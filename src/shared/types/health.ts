import { z } from 'zod'

/**
 * Drive health.
 *
 * Health matters here for a reason specific to data recovery: a drive that is
 * physically failing gets *worse every time it is read*. On such a drive the
 * correct first step is to take one sequential image and then recover from that
 * copy, rather than to run scan after scan against failing hardware. A health
 * reading is therefore not a status badge — it decides the safe order of work,
 * and this module exists to make that call before a long scan begins.
 */

/**
 * Overall condition of a drive.
 *
 * `caution` is separated from `at-risk` deliberately. Ageing indicators — hours
 * powered on, SSD write wear — are not failures and must not be presented as
 * such, or users replace healthy drives. `at-risk` is reserved for the specific
 * attributes that actually precede failure.
 */
export const DriveHealthStatusSchema = z.enum(['good', 'caution', 'at-risk', 'failing', 'unknown'])
export type DriveHealthStatus = z.infer<typeof DriveHealthStatusSchema>

/** How seriously one attribute reading should be taken. */
export const AttributeStatusSchema = z.enum(['ok', 'warning', 'critical', 'unknown'])
export type AttributeStatus = z.infer<typeof AttributeStatusSchema>

/**
 * How an attribute's raw value should be read.
 *
 * SMART raw values are vendor-defined 48-bit fields with no common meaning, so
 * a count of sectors and a temperature in Celsius arrive in identical shape.
 * Rendering them identically is what produces the notorious "power-on hours:
 * 3,600,000" readings in consumer tools.
 */
export const AttributeUnitSchema = z.enum(['count', 'hours', 'celsius', 'percent', 'bytes', 'raw'])
export type AttributeUnit = z.infer<typeof AttributeUnitSchema>

export const SmartAttributeSchema = z.object({
  id: z.number().int(),
  /** Canonical attribute name, e.g. "Reallocated sectors count". */
  name: z.string(),
  /** Normalised value, 1–253. Higher is healthier. */
  current: z.number().int(),
  /** Worst normalised value ever recorded. */
  worst: z.number().int(),
  /** Manufacturer's failure threshold, when the drive reports one. */
  threshold: z.number().int().nullable(),
  /** Vendor-defined 48-bit raw value. */
  raw: z.number(),
  unit: AttributeUnitSchema,
  /** `true` when falling below the threshold means imminent failure. */
  isPreFailure: z.boolean(),
  status: AttributeStatusSchema,
  /**
   * `true` for attributes this application judges health by. The rest are
   * reported for completeness but do not move the score.
   */
  isDecisive: z.boolean(),
})

export type SmartAttribute = z.infer<typeof SmartAttributeSchema>

/**
 * A specific, named problem.
 *
 * Codes rather than sentences, so the UI translates them and so a finding can
 * be matched against advice without parsing prose.
 */
export const HealthFindingCodeSchema = z.enum([
  /** The drive's own firmware predicts failure. */
  'self-assessment-failed',
  /** Sectors have gone bad and been remapped. */
  'reallocated-sectors',
  /** Sectors are unreadable and waiting to be remapped. */
  'pending-sectors',
  /** Sectors could not be read even offline. */
  'uncorrectable-sectors',
  /** The drive reported errors it could not correct. */
  'reported-uncorrectable',
  /** Commands are timing out. */
  'command-timeouts',
  /** Interface CRC errors — a cable or connection fault, not the drive. */
  'interface-errors',
  /** Running hotter than the drive is rated for. */
  'overheating',
  /** An SSD is near the end of its rated write endurance. */
  'wear-exhausted',
  /** The drive has been powered on a very long time. */
  'high-usage',
])
export type HealthFindingCode = z.infer<typeof HealthFindingCodeSchema>

export const HealthFindingSchema = z.object({
  code: HealthFindingCodeSchema,
  severity: AttributeStatusSchema,
  /** The measurement behind the finding, for the UI to interpolate. */
  value: z.number().nullable(),
})

export type HealthFinding = z.infer<typeof HealthFindingSchema>

/**
 * Why no health reading is available.
 *
 * A code rather than a sentence, for two reasons: it must be translatable, and
 * the distinction between them changes what the user should do. Being told a
 * drive does not report SMART sends someone looking for a different tool; being
 * told the application needs Administrator rights sends them to the fix.
 */
export const HealthUnavailableSchema = z.enum([
  /** The process lacks the elevation Windows requires to read SMART. */
  'needs-elevation',
  /** The drive or its USB bridge genuinely does not expose SMART. */
  'not-supported',
  /** Only the storage stack's summary counters were available. */
  'summary-only',
  /** The query itself failed. */
  'query-failed',
])
export type HealthUnavailable = z.infer<typeof HealthUnavailableSchema>

export const DriveHealthSchema = z.object({
  deviceId: z.string(),
  /** When the reading was taken. */
  capturedAt: z.number(),
  status: DriveHealthStatusSchema,
  /** 0–100. Only meaningful alongside `status` and the findings. */
  score: z.number().int(),
  /** The drive's own pass/fail prediction, when it offers one. */
  selfAssessmentPassed: z.boolean().nullable(),
  temperatureCelsius: z.number().nullable(),
  powerOnHours: z.number().nullable(),
  powerCycles: z.number().nullable(),
  /** Remaining write endurance for an SSD, 0–100. */
  lifeRemainingPercent: z.number().nullable(),
  reallocatedSectors: z.number().nullable(),
  pendingSectors: z.number().nullable(),
  attributes: z.array(SmartAttributeSchema),
  findings: z.array(HealthFindingSchema),
  /**
   * `true` when the drive should be imaged before it is scanned.
   *
   * Set when the failure indicators say every additional read is a risk. This
   * is the field that changes what the application recommends doing next.
   */
  imageBeforeScanning: z.boolean(),
  /** Populated when a full SMART reading was not available. */
  unavailable: HealthUnavailableSchema.nullable(),
})

export type DriveHealth = z.infer<typeof DriveHealthSchema>

export const HealthReportSchema = z.object({
  capturedAt: z.number(),
  drives: z.array(DriveHealthSchema),
  warnings: z.array(z.string()),
})

export type HealthReport = z.infer<typeof HealthReportSchema>

/** One stored reading, for plotting how a drive is changing over time. */
export const HealthHistoryPointSchema = z.object({
  deviceId: z.string(),
  capturedAt: z.number(),
  status: DriveHealthStatusSchema,
  score: z.number().int(),
  temperatureCelsius: z.number().nullable(),
  reallocatedSectors: z.number().nullable(),
  pendingSectors: z.number().nullable(),
  powerOnHours: z.number().nullable(),
})

export type HealthHistoryPoint = z.infer<typeof HealthHistoryPointSchema>

/**
 * Temperature limits.
 *
 * Consumer drives are rated to 55–60 °C. Sustained operation above that
 * shortens life materially, so 55 warns and 65 is treated as a fault.
 */
export const TEMPERATURE_WARNING_CELSIUS = 55
export const TEMPERATURE_CRITICAL_CELSIUS = 65

/** Below this much rated endurance left, an SSD should be replaced. */
export const WEAR_WARNING_PERCENT = 10

/** Five years of continuous operation. Ageing, not failure. */
export const HIGH_USAGE_HOURS = 43_800
