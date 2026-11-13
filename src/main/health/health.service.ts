import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { DriveHealth, HealthReport, HealthUnavailable } from '@shared/types/health'
import { describeUnknown } from '@shared/utils/errors'
import { parseJson } from '@shared/utils/json'
import type { DiskService } from '../disk/disk.service'
import type { Logger } from '../logging/logger'
import {
  assessHealth,
  decodeSmartPage,
  readLifeRemaining,
  readTemperature,
} from './smart-attributes'

/**
 * Reading drive health from Windows.
 *
 * Two providers are queried because neither is sufficient alone.
 * `MSStorageDriver_*` in `root\wmi` carries the real ATA SMART pages, which is
 * the only place per-attribute data lives — but the driver stack does not
 * expose it for NVMe or for most USB bridges. `MSFT_PhysicalDisk` and its
 * reliability counters cover those cases with a smaller set of figures.
 *
 * Where they overlap, SMART wins: it is the drive's own account of itself,
 * while the reliability counters are the storage stack's summary of it.
 *
 * A drive that reports nothing is reported as `unknown`, never as healthy. A
 * USB enclosure that hides SMART is extremely common, and telling a user their
 * failing disk is fine because the bridge would not answer is the worst
 * available outcome.
 */

const execFileAsync = promisify(execFile)

/** SMART queries can hang on a failing drive; the UI must not hang with them. */
const QUERY_TIMEOUT_MS = 25_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * The query.
 *
 * `InstanceName` is what ties a SMART record back to a physical disk: the WMI
 * classes key on a driver instance path, not a disk number, so the association
 * has to be made through `MSFT_PhysicalDisk` and matched by serial number and
 * position. Both are captured here and reconciled in TypeScript, where the
 * matching is testable.
 */
const HEALTH_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'

$smart = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_ATAPISmartData | ForEach-Object {
  [pscustomobject]@{
    InstanceName   = [string]$_.InstanceName
    VendorSpecific = @($_.VendorSpecific)
  }
})

$thresholds = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictThresholds | ForEach-Object {
  [pscustomobject]@{
    InstanceName   = [string]$_.InstanceName
    VendorSpecific = @($_.VendorSpecific)
  }
})

$status = @(Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus | ForEach-Object {
  [pscustomobject]@{
    InstanceName = [string]$_.InstanceName
    PredictFailure = [bool]$_.PredictFailure
  }
})

$physical = @(Get-CimInstance -Namespace root\Microsoft\Windows\Storage -ClassName MSFT_PhysicalDisk | ForEach-Object {
  [pscustomobject]@{
    DeviceId     = [string]$_.DeviceId
    SerialNumber = [string]$_.SerialNumber
    HealthStatus = [int]$_.HealthStatus
  }
})

$reliability = @(Get-CimInstance -Namespace root\Microsoft\Windows\Storage -ClassName MSFT_PhysicalDisk | ForEach-Object {
  $counter = Get-CimAssociatedInstance -InputObject $_ -ResultClassName MSFT_StorageReliabilityCounter
  if ($null -ne $counter) {
    [pscustomobject]@{
      DeviceId        = [string]$_.DeviceId
      Temperature     = [string]$counter.Temperature
      PowerOnHours    = [string]$counter.PowerOnHours
      Wear            = [string]$counter.Wear
      ReadErrorsTotal = [string]$counter.ReadErrorsTotal
    }
  }
})

[pscustomobject]@{
  Smart       = $smart
  Thresholds  = $thresholds
  Status      = $status
  Physical    = $physical
  Reliability = $reliability
} | ConvertTo-Json -Depth 5 -Compress
`

/** WMI renders absent numeric counters as empty strings, not nulls. */
const NumericSchema = z
  .string()
  .transform((value) => {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  })
  .nullable()
  .catch(null)

const SmartRecordSchema = z.object({
  InstanceName: z.string(),
  VendorSpecific: z.array(z.number()).nullable().catch(null),
})

const HealthQuerySchema = z.object({
  Smart: z.array(SmartRecordSchema).nullable().catch(null),
  Thresholds: z.array(SmartRecordSchema).nullable().catch(null),
  Status: z
    .array(z.object({ InstanceName: z.string(), PredictFailure: z.boolean() }))
    .nullable()
    .catch(null),
  Physical: z
    .array(
      z.object({
        DeviceId: z.string(),
        SerialNumber: z.string(),
        HealthStatus: z.number(),
      }),
    )
    .nullable()
    .catch(null),
  Reliability: z
    .array(
      z.object({
        DeviceId: z.string(),
        Temperature: NumericSchema,
        PowerOnHours: NumericSchema,
        Wear: NumericSchema,
        ReadErrorsTotal: NumericSchema,
      }),
    )
    .nullable()
    .catch(null),
})

type HealthQuery = z.infer<typeof HealthQuerySchema>

export class HealthService {
  private readonly disks: DiskService
  private readonly logger: Logger
  private cached: HealthReport | null = null

  constructor(disks: DiskService, logger: Logger) {
    this.disks = disks
    this.logger = logger.child('health')
  }

  getCached(): HealthReport | null {
    return this.cached
  }

  /** Read health for every device currently in the inventory. */
  async refresh(): Promise<HealthReport> {
    const inventory = this.disks.getCached() ?? (await this.disks.refresh())
    const warnings: string[] = []

    let query: HealthQuery | null = null
    try {
      query = await runHealthQuery()
    } catch (error) {
      warnings.push(`SMART data could not be read: ${describeUnknown(error)}`)
      this.logger.warn('SMART query failed', { error: describeUnknown(error) })
    }

    const capturedAt = Date.now()
    const drives = inventory.devices.map((device) =>
      buildDriveHealth(
        device.id,
        device.diskNumber,
        device.serialNumber,
        query,
        capturedAt,
        inventory.hasRawAccess,
      ),
    )

    const report: HealthReport = { capturedAt, drives, warnings }
    this.cached = report

    this.logger.info('Health captured', {
      drives: drives.length,
      failing: drives.filter((drive) => drive.status === 'failing').length,
    })

    return report
  }
}

async function runHealthQuery(): Promise<HealthQuery> {
  const encoded = Buffer.from(HEALTH_SCRIPT, 'utf16le').toString('base64')

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
  )

  const trimmed = stdout.trim()
  if (trimmed.length === 0) throw new Error('Windows returned no health data')

  const parsed = parseJson(trimmed, HealthQuerySchema)
  if (!parsed.ok) throw new Error(parsed.error.message)

  return parsed.data
}

/**
 * Match a disk to its SMART record and assemble the reading.
 *
 * Exported for tests: the matching between a disk number and a WMI instance
 * path is the part that breaks on real hardware, and it can be exercised
 * without WMI.
 */
export function buildDriveHealth(
  deviceId: string,
  diskNumber: number,
  serialNumber: string | null,
  query: HealthQuery | null,
  capturedAt: number,
  hasRawAccess = true,
): DriveHealth {
  /*
   * Windows refuses every SMART provider to an unelevated process — the WMI
   * classes return zero rows rather than an error. Reporting that as "this
   * drive does not report SMART" blames the hardware for a permission the
   * application simply has not asked for, and sends the user looking for
   * another tool instead of restarting this one as Administrator.
   */
  const noDataReason: HealthUnavailable = hasRawAccess ? 'not-supported' : 'needs-elevation'
  const empty: DriveHealth = {
    deviceId,
    capturedAt,
    status: 'unknown',
    score: 0,
    selfAssessmentPassed: null,
    temperatureCelsius: null,
    powerOnHours: null,
    powerCycles: null,
    lifeRemainingPercent: null,
    reallocatedSectors: null,
    pendingSectors: null,
    attributes: [],
    findings: [],
    imageBeforeScanning: false,
    unavailable: noDataReason,
  }

  if (query === null) return { ...empty, unavailable: 'query-failed' }

  const instance = findInstanceName(query, diskNumber, serialNumber)

  const smartPage = toPage(
    query.Smart?.find((record) => record.InstanceName === instance)?.VendorSpecific ?? null,
  )
  const thresholdPage = toPage(
    query.Thresholds?.find((record) => record.InstanceName === instance)?.VendorSpecific ?? null,
  )

  const predicted = query.Status?.find((record) => record.InstanceName === instance)
  const selfAssessmentPassed = predicted === undefined ? null : !predicted.PredictFailure

  const attributes = smartPage === null ? [] : decodeSmartPage(smartPage, thresholdPage)
  const reliability = query.Reliability?.find((record) => record.DeviceId === String(diskNumber))

  if (attributes.length === 0 && selfAssessmentPassed === null) {
    // Fall back to the storage stack's own counters. They carry no per-attribute
    // detail, so no verdict is offered — but temperature and hours are still
    // worth showing, and are often all an NVMe drive exposes.
    if (reliability === undefined) return empty

    return {
      ...empty,
      temperatureCelsius: plausibleTemperature(reliability.Temperature),
      powerOnHours: reliability.PowerOnHours,
      lifeRemainingPercent: reliability.Wear === null ? null : 100 - reliability.Wear,
      unavailable: 'summary-only',
    }
  }

  const assessment = assessHealth(attributes, selfAssessmentPassed)
  const rawOf = (id: number): number | null =>
    attributes.find((attribute) => attribute.id === id)?.raw ?? null

  return {
    deviceId,
    capturedAt,
    status: assessment.status,
    score: assessment.score,
    selfAssessmentPassed,
    temperatureCelsius:
      readTemperature(attributes) ?? plausibleTemperature(reliability?.Temperature ?? null),
    powerOnHours: rawOf(9) ?? reliability?.PowerOnHours ?? null,
    powerCycles: rawOf(12),
    lifeRemainingPercent: readLifeRemaining(attributes),
    reallocatedSectors: rawOf(5),
    pendingSectors: rawOf(197),
    attributes,
    findings: [...assessment.findings],
    imageBeforeScanning: assessment.imageBeforeScanning,
    unavailable: null,
  }
}

/**
 * Find the WMI instance path for a disk.
 *
 * The SMART classes key on a driver instance name that embeds the disk's
 * position on its controller, not its disk number — so the two are related only
 * through `MSFT_PhysicalDisk`. Serial number is tried first because it is
 * unambiguous; the trailing index of the instance path is the fallback, and it
 * matches the disk number on every stack seen so far.
 */
function findInstanceName(
  query: HealthQuery,
  diskNumber: number,
  serialNumber: string | null,
): string | null {
  /*
   * Both sources are consulted, and emptiness — not nullness — decides.
   *
   * `??` is wrong here: WMI returns an empty array, not null, when a class has
   * no rows, so `Smart ?? Status` would never reach the fallback. A drive that
   * publishes a failure prediction but no attribute page is exactly the case
   * that matters, and it would have been reported as "no data" while the drive
   * was saying it is dying.
   */
  const records: ReadonlyArray<{ readonly InstanceName: string }> =
    query.Smart !== null && query.Smart.length > 0 ? query.Smart : (query.Status ?? [])

  if (records.length === 0) return null

  if (serialNumber !== null && serialNumber.trim().length > 0) {
    const physical = query.Physical?.find(
      (candidate) => candidate.SerialNumber.trim() === serialNumber.trim(),
    )

    if (physical !== undefined) {
      const byDeviceId = records.find((record) =>
        record.InstanceName.trim().endsWith(`_${physical.DeviceId}`),
      )
      if (byDeviceId !== undefined) return byDeviceId.InstanceName
    }
  }

  const byIndex = records.find((record) => record.InstanceName.trim().endsWith(`_${diskNumber}`))
  if (byIndex !== undefined) return byIndex.InstanceName

  // A single-drive machine is the common case and needs no matching at all.
  return records.length === 1 ? (records[0]?.InstanceName ?? null) : null
}

/** WMI hands the SMART page over as an array of byte-valued numbers. */
function toPage(values: readonly number[] | null): Buffer | null {
  if (values === null || values.length === 0) return null

  return Buffer.from(Uint8Array.from(values, (value) => value & 0xff))
}

/**
 * Reject an implausible temperature.
 *
 * The reliability counter reports 0 for a drive with no sensor, and some USB
 * bridges return a raw Kelvin value or uninitialised memory.
 */
function plausibleTemperature(value: number | null): number | null {
  if (value === null || value <= 0 || value >= 150) return null
  return value
}
