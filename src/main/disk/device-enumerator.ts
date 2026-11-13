import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  type BusType,
  type DeviceKind,
  type HealthStatus,
  type MediaType,
  type PartitionStyle,
} from '@shared/types/disk'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import { parseJson } from '@shared/utils/json'

/**
 * Windows storage enumeration.
 *
 * Device inventory comes from the Storage Management CIM provider
 * (`root/Microsoft/Windows/Storage`), which reports offline disks, removable
 * media and disks with no readable partition table — all of which a recovery
 * user specifically needs to see, and all of which the older `Win32_LogicalDisk`
 * view omits.
 *
 * `Win32_DiskDrive` is queried alongside it purely for `BytesPerSector`, which
 * the newer provider does not expose and which every raw read depends on.
 */

const execFileAsync = promisify(execFile)

/** Enumeration is on the UI path; a hung WMI service must not hang the app. */
const ENUMERATION_TIMEOUT_MS = 20_000

/** A machine with many volumes produces a few hundred KB of JSON. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * The query, run as a single PowerShell invocation.
 *
 * 64-bit values are stringified before serialisation: PowerShell renders
 * `UInt64` in scientific notation for large disks, which silently loses
 * precision on a multi-terabyte device.
 */
const ENUMERATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ns = 'root/Microsoft/Windows/Storage'

$disks = @(Get-CimInstance -Namespace $ns -ClassName MSFT_Disk | ForEach-Object {
  [pscustomobject]@{
    Number             = [int]$_.Number
    FriendlyName       = [string]$_.FriendlyName
    SerialNumber       = [string]$_.SerialNumber
    Size               = [string]$_.Size
    PartitionStyle     = [int]$_.PartitionStyle
    BusType            = [int]$_.BusType
    MediaType          = [int]$_.MediaType
    HealthStatus       = [int]$_.HealthStatus
    IsBoot             = [bool]$_.IsBoot
    IsSystem           = [bool]$_.IsSystem
    IsOffline          = [bool]$_.IsOffline
    IsReadOnly         = [bool]$_.IsReadOnly
    LogicalSectorSize  = [string]$_.LogicalSectorSize
    PhysicalSectorSize = [string]$_.PhysicalSectorSize
  }
})

$partitions = @(Get-CimInstance -Namespace $ns -ClassName MSFT_Partition | ForEach-Object {
  [pscustomobject]@{
    DiskNumber      = [int]$_.DiskNumber
    PartitionNumber = [int]$_.PartitionNumber
    DriveLetter     = [string]$_.DriveLetter
    Offset          = [string]$_.Offset
    Size            = [string]$_.Size
    GptType         = [string]$_.GptType
    MbrType         = [int]$_.MbrType
    IsActive        = [bool]$_.IsActive
    IsHidden        = [bool]$_.IsHidden
    IsBoot          = [bool]$_.IsBoot
  }
})

$volumes = @(Get-CimInstance -Namespace $ns -ClassName MSFT_Volume | ForEach-Object {
  [pscustomobject]@{
    DriveLetter     = [string]$_.DriveLetter
    FileSystem      = [string]$_.FileSystem
    FileSystemLabel = [string]$_.FileSystemLabel
    Size            = [string]$_.Size
    SizeRemaining   = [string]$_.SizeRemaining
    DriveType       = [int]$_.DriveType
    HealthStatus    = [int]$_.HealthStatus
  }
})

$physical = @(Get-CimInstance -ClassName Win32_DiskDrive | ForEach-Object {
  [pscustomobject]@{
    Index          = [int]$_.Index
    BytesPerSector = [int]$_.BytesPerSector
    InterfaceType  = [string]$_.InterfaceType
    Model          = [string]$_.Model
    SerialNumber   = [string]$_.SerialNumber
    MediaType      = [string]$_.MediaType
  }
})

[pscustomobject]@{
  disks      = $disks
  partitions = $partitions
  volumes    = $volumes
  physical   = $physical
} | ConvertTo-Json -Depth 4 -Compress
`

const NumericStringSchema = z.string().transform((value) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
})

/**
 * A CIM string field.
 *
 * PowerShell renders an unset `Char` property — `MSFT_Partition.DriveLetter` on
 * a partition with no mount point is the common case — as a single NUL
 * character rather than as an empty string. A plain `.trim()` does not remove
 * it, so a length check on the raw value reports "1 character" and the UI ends
 * up rendering a partition labelled `" :"`.
 */
const CimStringSchema = z.string().transform((value) =>
  // eslint-disable-next-line no-control-regex
  value.replace(/\u0000/gu, '').trim(),
)

const CimDiskSchema = z.object({
  Number: z.number(),
  FriendlyName: CimStringSchema,
  SerialNumber: CimStringSchema,
  Size: NumericStringSchema,
  PartitionStyle: z.number(),
  BusType: z.number(),
  MediaType: z.number(),
  HealthStatus: z.number(),
  IsBoot: z.boolean(),
  IsSystem: z.boolean(),
  IsOffline: z.boolean(),
  IsReadOnly: z.boolean(),
  LogicalSectorSize: NumericStringSchema,
  PhysicalSectorSize: NumericStringSchema,
})

const CimPartitionSchema = z.object({
  DiskNumber: z.number(),
  PartitionNumber: z.number(),
  DriveLetter: CimStringSchema,
  Offset: NumericStringSchema,
  Size: NumericStringSchema,
  GptType: CimStringSchema,
  MbrType: z.number(),
  IsActive: z.boolean(),
  IsHidden: z.boolean(),
  IsBoot: z.boolean(),
})

const CimVolumeSchema = z.object({
  DriveLetter: CimStringSchema,
  FileSystem: CimStringSchema,
  FileSystemLabel: CimStringSchema,
  Size: NumericStringSchema,
  SizeRemaining: NumericStringSchema,
  DriveType: z.number(),
  HealthStatus: z.number(),
})

const CimPhysicalSchema = z.object({
  Index: z.number(),
  BytesPerSector: z.number(),
  InterfaceType: CimStringSchema,
  Model: CimStringSchema,
  SerialNumber: CimStringSchema,
  MediaType: CimStringSchema,
})

/**
 * `ConvertTo-Json` collapses a one-element array to a bare object. Coercing
 * back to an array here means a machine with a single disk does not take a
 * different code path from every other machine.
 */
const asArray = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([z.array(schema), schema.transform((value: unknown) => [value]), z.null()])
    .transform((value) => (value ?? []) as Array<z.infer<T>>)

const EnumerationSchema = z.object({
  disks: asArray(CimDiskSchema),
  partitions: asArray(CimPartitionSchema),
  volumes: asArray(CimVolumeSchema),
  physical: asArray(CimPhysicalSchema),
})

export type CimDisk = z.infer<typeof CimDiskSchema>
export type CimPartition = z.infer<typeof CimPartitionSchema>
export type CimVolume = z.infer<typeof CimVolumeSchema>
export type CimPhysical = z.infer<typeof CimPhysicalSchema>

export interface EnumerationResult {
  readonly disks: readonly CimDisk[]
  readonly partitions: readonly CimPartition[]
  readonly volumes: readonly CimVolume[]
  readonly physical: readonly CimPhysical[]
}

/**
 * Query the OS for its storage inventory.
 *
 * The script is passed as `-EncodedCommand` (base64 UTF-16LE) rather than as a
 * command-line string. A multi-line script containing quotes, `$` and `@{}`
 * cannot be passed through Windows command-line quoting intact, and the
 * failures that produces are intermittent and awful to diagnose.
 */
export async function enumerateStorage(): Promise<EnumerationResult> {
  const encoded = Buffer.from(ENUMERATION_SCRIPT, 'utf16le').toString('base64')

  let stdout: string
  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        timeout: ENUMERATION_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
    )
    stdout = result.stdout
  } catch (error) {
    throw new AppError(ErrorCode.Io, 'Windows did not return a list of storage devices', {
      details: describeUnknown(error),
      cause: error,
      retryable: true,
    })
  }

  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    throw new AppError(ErrorCode.Io, 'Windows returned an empty storage inventory', {
      retryable: true,
    })
  }

  const parsed = parseJson(trimmed, EnumerationSchema)
  if (!parsed.ok) {
    throw new AppError(ErrorCode.Io, 'The storage inventory could not be read', {
      details: parsed.error.details ?? parsed.error.message,
      retryable: true,
    })
  }

  return parsed.data
}

// --- CIM enum translation --------------------------------------------------

/** `MSFT_Disk.BusType`. */
export function mapBusType(value: number): BusType {
  const map: Readonly<Record<number, BusType>> = {
    0: 'unknown',
    1: 'scsi',
    2: 'atapi',
    3: 'ata',
    4: 'ieee1394',
    5: 'ssa',
    6: 'fibre',
    7: 'usb',
    8: 'raid',
    9: 'iscsi',
    10: 'sas',
    11: 'sata',
    12: 'sd',
    13: 'mmc',
    14: 'virtual',
    15: 'file-backed-virtual',
    16: 'storage-spaces',
    17: 'nvme',
  }

  return map[value] ?? 'unknown'
}

/** `MSFT_Disk.MediaType`. */
export function mapMediaType(value: number): MediaType {
  const map: Readonly<Record<number, MediaType>> = {
    0: 'unspecified',
    3: 'hdd',
    4: 'ssd',
    5: 'scm',
  }

  return map[value] ?? 'unspecified'
}

/** `MSFT_Disk.PartitionStyle`. */
export function mapPartitionStyle(value: number): PartitionStyle {
  const map: Readonly<Record<number, PartitionStyle>> = { 0: 'raw', 1: 'mbr', 2: 'gpt' }
  return map[value] ?? 'unknown'
}

/** `MSFT_Disk.HealthStatus` / `MSFT_Volume.HealthStatus`. */
export function mapHealthStatus(value: number): HealthStatus {
  const map: Readonly<Record<number, HealthStatus>> = {
    0: 'healthy',
    1: 'warning',
    2: 'unhealthy',
  }

  return map[value] ?? 'unknown'
}

/**
 * Classify a device the way a user would describe it.
 *
 * Windows does not report "this is an SD card" directly — the answer has to be
 * assembled from the bus type, the media type and removability. Getting this
 * right matters beyond the icon: an SD card and an internal NVMe drive need
 * very different advice about what to do next.
 */
export function classifyDevice(
  busType: BusType,
  mediaType: MediaType,
  isRemovable: boolean,
): DeviceKind {
  // An if-chain rather than a switch: only a handful of the seventeen bus types
  // imply a device class on their own, and the rest fall through to the media
  // type below.
  if (busType === 'sd') return 'sd-card'
  if (busType === 'mmc') return 'micro-sd'
  if (busType === 'nvme') return 'nvme'
  if (busType === 'atapi') return 'optical'
  if (busType === 'virtual' || busType === 'file-backed-virtual') return 'virtual-disk'

  if (busType === 'usb') {
    // A USB SSD reports its media type honestly; a flash stick reports
    // `unspecified`, which is the distinguishing signal.
    if (mediaType === 'ssd') return 'external-ssd'
    if (mediaType === 'hdd') return 'external-hdd'
    return 'usb-flash'
  }

  if (busType === 'ieee1394' || busType === 'iscsi') {
    return mediaType === 'ssd' ? 'external-ssd' : 'external-hdd'
  }

  if (mediaType === 'ssd') return isRemovable ? 'external-ssd' : 'ssd'
  if (mediaType === 'hdd') return isRemovable ? 'external-hdd' : 'hard-disk'

  return isRemovable ? 'usb-flash' : 'unknown'
}

/** Removable-media bus types, used when the OS does not flag removability. */
export function isRemovableBus(busType: BusType): boolean {
  return busType === 'usb' || busType === 'sd' || busType === 'mmc' || busType === 'ieee1394'
}

/** Raw device path for a physical disk number. */
export function physicalDrivePath(diskNumber: number): string {
  return `\\\\.\\PhysicalDrive${diskNumber}`
}

/** Raw device path for a mounted volume, e.g. `\\.\C:`. */
export function volumePath(driveLetter: string): string {
  return `\\\\.\\${driveLetter.replace(/:$/u, '')}:`
}
