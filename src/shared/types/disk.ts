import { z } from 'zod'

/**
 * Storage device, partition and volume model.
 *
 * Deliberately physical-first: RecoverX recovers from *devices*, not from
 * drive letters. A formatted or corrupted partition has no letter, and the data
 * worth recovering is frequently in unallocated space that no volume claims.
 */

/** How the device attaches to the machine. Drives the icon and the risk advice. */
export const BusTypeSchema = z.enum([
  'unknown',
  'scsi',
  'atapi',
  'ata',
  'ieee1394',
  'ssa',
  'fibre',
  'usb',
  'raid',
  'iscsi',
  'sas',
  'sata',
  'sd',
  'mmc',
  'virtual',
  'file-backed-virtual',
  'storage-spaces',
  'nvme',
])
export type BusType = z.infer<typeof BusTypeSchema>

/** Physical medium, where the OS can tell us. */
export const MediaTypeSchema = z.enum(['unspecified', 'hdd', 'ssd', 'scm', 'removable'])
export type MediaType = z.infer<typeof MediaTypeSchema>

/**
 * User-facing device class, derived from bus + media + removability.
 * This is what the UI labels a device, and it matches the device list a
 * customer expects to see.
 */
export const DeviceKindSchema = z.enum([
  'hard-disk',
  'ssd',
  'nvme',
  'external-hdd',
  'external-ssd',
  'usb-flash',
  'sd-card',
  'micro-sd',
  'camera-card',
  'optical',
  'virtual-disk',
  'unknown',
])
export type DeviceKind = z.infer<typeof DeviceKindSchema>

export const PartitionStyleSchema = z.enum(['mbr', 'gpt', 'raw', 'unknown'])
export type PartitionStyle = z.infer<typeof PartitionStyleSchema>

/** Filesystems the scanner can recognise. `unknown` is still scannable by carving. */
export const FileSystemSchema = z.enum([
  'ntfs',
  'fat12',
  'fat16',
  'fat32',
  'exfat',
  'refs',
  'apfs',
  'hfs+',
  'ext2',
  'ext3',
  'ext4',
  'xfs',
  'btrfs',
  'iso9660',
  'udf',
  'swap',
  'unknown',
  'raw',
])
export type FileSystem = z.infer<typeof FileSystemSchema>

export const HealthStatusSchema = z.enum(['healthy', 'warning', 'unhealthy', 'unknown'])
export type HealthStatus = z.infer<typeof HealthStatusSchema>

export const PartitionSchema = z.object({
  /** Stable identity: `<deviceId>:p<index>`. */
  id: z.string(),
  deviceId: z.string(),
  /** 1-based index within the partition table. */
  index: z.number().int(),
  /** Byte offset of the first sector, from the start of the device. */
  offsetBytes: z.number(),
  sizeBytes: z.number(),
  fileSystem: FileSystemSchema,
  /** Volume label, when the filesystem carries one in its boot sector. */
  label: z.string().nullable(),
  /** Drive letter, when Windows has mounted it. */
  driveLetter: z.string().nullable(),
  /** Raw MBR type byte, or the GPT type GUID. */
  typeCode: z.string(),
  /** Human-readable partition type, e.g. "Basic data", "EFI System". */
  typeName: z.string(),
  isBootable: z.boolean(),
  isHidden: z.boolean(),
  /**
   * `true` when this entry was reconstructed from a filesystem signature found
   * during a scan, rather than read from an intact partition table.
   */
  isRecovered: z.boolean(),
  /** Free space, when the volume is mounted and readable. */
  freeBytes: z.number().nullable(),
})

export type Partition = z.infer<typeof PartitionSchema>

/**
 * A span of the device claimed by no partition.
 *
 * Surfaced explicitly because a deleted partition leaves its data here, and it
 * is the most valuable region to carve after a repartition or a bad format.
 */
export const UnallocatedRegionSchema = z.object({
  offsetBytes: z.number(),
  sizeBytes: z.number(),
})

export type UnallocatedRegion = z.infer<typeof UnallocatedRegionSchema>

export const StorageDeviceSchema = z.object({
  /** Stable identity across refreshes: `disk<number>`. */
  id: z.string(),
  /** Windows physical drive number. */
  diskNumber: z.number().int(),
  /** Path used for raw access, e.g. `\\.\PhysicalDrive0`. */
  devicePath: z.string(),
  /** Manufacturer model string. */
  model: z.string(),
  serialNumber: z.string().nullable(),
  sizeBytes: z.number(),
  logicalSectorSize: z.number().int(),
  physicalSectorSize: z.number().int(),
  busType: BusTypeSchema,
  mediaType: MediaTypeSchema,
  kind: DeviceKindSchema,
  partitionStyle: PartitionStyleSchema,
  isRemovable: z.boolean(),
  /** `true` for the disk Windows booted from — never a safe recovery target. */
  isSystem: z.boolean(),
  isBoot: z.boolean(),
  /** `true` when the device is offline or has no media inserted. */
  isOffline: z.boolean(),
  health: HealthStatusSchema,
  partitions: z.array(PartitionSchema),
  unallocated: z.array(UnallocatedRegionSchema),
  /** Populated when the partition table could not be read. */
  readError: z.string().nullable(),
})

export type StorageDevice = z.infer<typeof StorageDeviceSchema>

export const DeviceInventorySchema = z.object({
  capturedAt: z.number(),
  devices: z.array(StorageDeviceSchema),
  /** `false` when the process lacks the elevation needed for raw access. */
  hasRawAccess: z.boolean(),
  /**
   * Non-fatal problems encountered during enumeration — a device that could not
   * be opened, a partition table that would not parse. Shown in the UI so a
   * missing drive is never silently missing.
   */
  warnings: z.array(z.string()),
})

export type DeviceInventory = z.infer<typeof DeviceInventorySchema>

/** A scan or recovery target: a whole device, one partition, or a byte range. */
export const ScanTargetSchema = z.object({
  deviceId: z.string(),
  /** `null` scans the entire device, including unallocated space. */
  partitionId: z.string().nullable(),
  offsetBytes: z.number(),
  sizeBytes: z.number(),
})

export type ScanTarget = z.infer<typeof ScanTargetSchema>

/** Byte size of a sector when the device does not report one. */
export const DEFAULT_SECTOR_SIZE = 512

/** Filesystems the metadata (quick) scanner understands natively. */
export const QUICK_SCANNABLE_FILESYSTEMS: readonly FileSystem[] = [
  'ntfs',
  'fat12',
  'fat16',
  'fat32',
  'exfat',
]

/** `true` when a quick scan can read this filesystem's own records. */
export function supportsQuickScan(fileSystem: FileSystem): boolean {
  return QUICK_SCANNABLE_FILESYSTEMS.includes(fileSystem)
}
