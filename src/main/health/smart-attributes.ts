import {
  HIGH_USAGE_HOURS,
  TEMPERATURE_CRITICAL_CELSIUS,
  TEMPERATURE_WARNING_CELSIUS,
  WEAR_WARNING_PERCENT,
  type AttributeStatus,
  type AttributeUnit,
  type DriveHealthStatus,
  type HealthFinding,
  type SmartAttribute,
} from '@shared/types/health'

/**
 * Decoding and judging SMART data.
 *
 * Two problems are solved here, and they are separate.
 *
 * The first is decoding. Windows hands over the drive's SMART page as a raw
 * 512-byte blob; the layout is fixed by the ATA specification but the *meaning*
 * of each raw value is vendor-defined, so a sector count and a temperature
 * arrive in identical shape. Rendering them identically is what produces the
 * absurd readings consumer tools are known for.
 *
 * The second is judgement, and it is the part that matters. Most attributes say
 * nothing useful about whether a drive is about to fail. Backblaze's published
 * analysis of their own fleet found four that do — reallocated sectors,
 * reported uncorrectable errors, pending sectors and offline uncorrectable
 * sectors — and those are the ones weighted here. Everything else is reported
 * for completeness and left out of the score, because a score that moves on
 * noise trains users to ignore it.
 */

/** Length of the SMART data and threshold pages defined by ATA. */
export const SMART_PAGE_BYTES = 512

/** Attribute entries begin after a two-byte revision number. */
const ATTRIBUTE_TABLE_OFFSET = 2
const ATTRIBUTE_ENTRY_BYTES = 12
const MAX_ATTRIBUTES = 30

interface AttributeDefinition {
  readonly name: string
  readonly unit: AttributeUnit
  /** Counted towards the health score. */
  readonly decisive?: boolean
  /** A non-zero raw value is itself the problem, regardless of normalisation. */
  readonly failOnAnyCount?: boolean
}

/**
 * The attributes this application understands.
 *
 * Unknown IDs are still reported — a vendor-specific attribute a user needs to
 * quote to a manufacturer must not vanish — but they are named generically and
 * never influence the score, because their meaning is genuinely unknown.
 */
const CATALOG: Readonly<Record<number, AttributeDefinition>> = {
  1: { name: 'Read error rate', unit: 'raw' },
  3: { name: 'Spin-up time', unit: 'raw' },
  4: { name: 'Start/stop count', unit: 'count' },
  5: {
    name: 'Reallocated sectors count',
    unit: 'count',
    decisive: true,
    failOnAnyCount: true,
  },
  7: { name: 'Seek error rate', unit: 'raw' },
  9: { name: 'Power-on hours', unit: 'hours' },
  10: { name: 'Spin retry count', unit: 'count', decisive: true },
  12: { name: 'Power cycle count', unit: 'count' },
  177: { name: 'Wear levelling count', unit: 'count' },
  179: { name: 'Used reserved block count', unit: 'count' },
  181: { name: 'Program fail count', unit: 'count' },
  182: { name: 'Erase fail count', unit: 'count' },
  183: { name: 'Runtime bad block', unit: 'count', decisive: true },
  184: { name: 'End-to-end error', unit: 'count', decisive: true, failOnAnyCount: true },
  187: {
    name: 'Reported uncorrectable errors',
    unit: 'count',
    decisive: true,
    failOnAnyCount: true,
  },
  188: { name: 'Command timeout', unit: 'count', decisive: true },
  190: { name: 'Airflow temperature', unit: 'celsius' },
  194: { name: 'Temperature', unit: 'celsius' },
  196: { name: 'Reallocation event count', unit: 'count' },
  197: {
    name: 'Current pending sector count',
    unit: 'count',
    decisive: true,
    failOnAnyCount: true,
  },
  198: {
    name: 'Uncorrectable sector count',
    unit: 'count',
    decisive: true,
    failOnAnyCount: true,
  },
  // Explicitly *not* decisive: CRC errors are a cable or connector fault, not a
  // dying drive. Counting them against drive health tells users to replace
  // healthy hardware when they should reseat a cable.
  199: { name: 'Interface CRC error count', unit: 'count' },
  231: { name: 'SSD life left', unit: 'percent' },
  232: { name: 'Endurance remaining', unit: 'percent' },
  233: { name: 'Media wear-out indicator', unit: 'percent' },
  241: { name: 'Total data written', unit: 'bytes' },
  242: { name: 'Total data read', unit: 'bytes' },
}

/** Attributes whose normalised value expresses percentage of life remaining. */
const LIFE_REMAINING_IDS = [231, 232, 233, 202] as const

/**
 * Decode one 512-byte SMART page into attributes.
 *
 * `thresholds` is the matching page from the drive's threshold table, which
 * arrives as a separate WMI object and is frequently missing. Its absence is
 * not an error: it costs the pre-failure comparison, not the reading.
 */
export function decodeSmartPage(data: Buffer, thresholds: Buffer | null = null): SmartAttribute[] {
  if (data.length < ATTRIBUTE_TABLE_OFFSET + ATTRIBUTE_ENTRY_BYTES) return []

  const thresholdById = decodeThresholds(thresholds)
  const attributes: SmartAttribute[] = []

  for (let index = 0; index < MAX_ATTRIBUTES; index += 1) {
    const base = ATTRIBUTE_TABLE_OFFSET + index * ATTRIBUTE_ENTRY_BYTES
    if (base + ATTRIBUTE_ENTRY_BYTES > data.length) break

    const id = data.readUInt8(base)
    // A zero identifier marks an unused slot; the table is fixed-length and
    // sparsely filled, so this is padding rather than the end of the data.
    if (id === 0) continue

    const flags = data.readUInt16LE(base + 1)
    const definition = CATALOG[id]

    const raw = readRaw48(data, base + 5)
    const current = data.readUInt8(base + 3)
    const worst = data.readUInt8(base + 4)
    const threshold = thresholdById.get(id) ?? null
    const unit = definition?.unit ?? 'raw'

    attributes.push({
      id,
      name: definition?.name ?? `Vendor attribute ${id}`,
      current,
      worst,
      threshold,
      raw: normaliseRaw(id, raw, unit),
      unit,
      // Bit 0 of the flags word marks an attribute as pre-failure rather than
      // advisory: falling below its threshold means imminent failure.
      isPreFailure: (flags & 0x0001) !== 0,
      status: judgeAttribute(id, current, threshold, raw, definition),
      isDecisive: definition?.decisive === true,
    })
  }

  return attributes.sort((a, b) => a.id - b.id)
}

function decodeThresholds(page: Buffer | null): Map<number, number> {
  const map = new Map<number, number>()
  if (page === null || page.length < ATTRIBUTE_TABLE_OFFSET + ATTRIBUTE_ENTRY_BYTES) return map

  for (let index = 0; index < MAX_ATTRIBUTES; index += 1) {
    const base = ATTRIBUTE_TABLE_OFFSET + index * ATTRIBUTE_ENTRY_BYTES
    if (base + ATTRIBUTE_ENTRY_BYTES > page.length) break

    const id = page.readUInt8(base)
    if (id === 0) continue

    map.set(id, page.readUInt8(base + 1))
  }

  return map
}

/** Raw values are 48-bit little-endian, which exceeds a 32-bit read. */
function readRaw48(buffer: Buffer, offset: number): number {
  if (offset + 6 > buffer.length) return 0

  const low = buffer.readUInt32LE(offset)
  const high = buffer.readUInt16LE(offset + 4)

  return high * 0x1_0000_0000 + low
}

/**
 * Reduce a vendor-defined raw field to the quantity it actually represents.
 *
 * Temperature is the case that matters. Most drives pack the current reading
 * into the low byte and the lifetime minimum and maximum into the bytes above
 * it, so reporting the field verbatim yields readings in the millions. Masking
 * to the low two bytes and rejecting anything outside a physically possible
 * range is what keeps the number believable.
 */
function normaliseRaw(id: number, raw: number, unit: AttributeUnit): number {
  if (unit === 'celsius') {
    const celsius = raw & 0xffff
    // Above 200 the field is certainly packed differently; the low byte alone
    // is then the best remaining guess.
    return celsius > 200 ? raw & 0xff : celsius
  }

  // Total data written and read are counted in 512-byte logical sectors.
  if (id === 241 || id === 242) return raw * 512

  return raw
}

function judgeAttribute(
  id: number,
  current: number,
  threshold: number | null,
  raw: number,
  definition: AttributeDefinition | undefined,
): AttributeStatus {
  // The manufacturer's own threshold outranks every heuristic below it: the
  // drive is saying it has failed by its own specification.
  if (threshold !== null && threshold > 0 && current > 0 && current <= threshold) {
    return 'critical'
  }

  if (definition === undefined) return 'unknown'

  if (definition.unit === 'celsius') {
    if (raw >= TEMPERATURE_CRITICAL_CELSIUS) return 'critical'
    if (raw >= TEMPERATURE_WARNING_CELSIUS) return 'warning'
    return 'ok'
  }

  if (LIFE_REMAINING_IDS.includes(id as (typeof LIFE_REMAINING_IDS)[number])) {
    // These report life *remaining* in the normalised value, counting down.
    if (current <= WEAR_WARNING_PERCENT) return 'warning'
    return 'ok'
  }

  if (definition.failOnAnyCount === true && raw > 0) {
    // A handful of remapped sectors is a warning; a drive shedding them in
    // quantity is failing, and the difference is worth drawing.
    return raw >= 40 ? 'critical' : 'warning'
  }

  if (id === 199 && raw > 0) return 'warning'
  if (id === 188 && raw >= 10) return 'warning'
  if (definition.decisive === true && raw > 0) return 'warning'

  return 'ok'
}

// --- Summarising -----------------------------------------------------------

export interface HealthAssessment {
  readonly status: DriveHealthStatus
  readonly score: number
  readonly findings: readonly HealthFinding[]
  readonly imageBeforeScanning: boolean
}

/** Weight deducted from the score by each kind of problem. */
const PENALTY = {
  selfAssessmentFailed: 60,
  pendingSectors: 35,
  uncorrectableSectors: 30,
  reportedUncorrectable: 25,
  reallocatedSectors: 20,
  commandTimeouts: 10,
  overheating: 15,
  wearExhausted: 20,
  interfaceErrors: 5,
  highUsage: 5,
} as const

/**
 * Turn attributes into a verdict.
 *
 * The output that matters most is `imageBeforeScanning`. A drive with
 * unreadable sectors degrades further with every pass over it, so the right
 * first move is one sequential copy — not the repeated deep scans this
 * application would otherwise happily run against it.
 */
export function assessHealth(
  attributes: readonly SmartAttribute[],
  selfAssessmentPassed: boolean | null,
): HealthAssessment {
  if (attributes.length === 0 && selfAssessmentPassed === null) {
    return { status: 'unknown', score: 0, findings: [], imageBeforeScanning: false }
  }

  const findings: HealthFinding[] = []
  let score = 100

  const rawOf = (id: number): number | null => attributes.find((a) => a.id === id)?.raw ?? null

  const add = (
    code: HealthFinding['code'],
    severity: AttributeStatus,
    value: number | null,
    penalty: number,
  ): void => {
    findings.push({ code, severity, value })
    score -= penalty
  }

  if (selfAssessmentPassed === false) {
    add('self-assessment-failed', 'critical', null, PENALTY.selfAssessmentFailed)
  }

  // --- The four that actually predict failure ------------------------------
  const pending = rawOf(197)
  if (pending !== null && pending > 0) {
    add('pending-sectors', 'critical', pending, PENALTY.pendingSectors)
  }

  const uncorrectable = rawOf(198)
  if (uncorrectable !== null && uncorrectable > 0) {
    add('uncorrectable-sectors', 'critical', uncorrectable, PENALTY.uncorrectableSectors)
  }

  const reported = rawOf(187)
  if (reported !== null && reported > 0) {
    add('reported-uncorrectable', 'critical', reported, PENALTY.reportedUncorrectable)
  }

  const reallocated = rawOf(5)
  if (reallocated !== null && reallocated > 0) {
    add(
      'reallocated-sectors',
      reallocated >= 40 ? 'critical' : 'warning',
      reallocated,
      PENALTY.reallocatedSectors,
    )
  }

  // --- Supporting signals --------------------------------------------------
  const timeouts = rawOf(188)
  if (timeouts !== null && timeouts >= 10) {
    add('command-timeouts', 'warning', timeouts, PENALTY.commandTimeouts)
  }

  const temperature = readTemperature(attributes)
  if (temperature !== null && temperature >= TEMPERATURE_WARNING_CELSIUS) {
    add(
      'overheating',
      temperature >= TEMPERATURE_CRITICAL_CELSIUS ? 'critical' : 'warning',
      temperature,
      PENALTY.overheating,
    )
  }

  const life = readLifeRemaining(attributes)
  if (life !== null && life <= WEAR_WARNING_PERCENT) {
    add('wear-exhausted', 'warning', life, PENALTY.wearExhausted)
  }

  // Reported, but never counted as drive failure: this is the cable.
  const crc = rawOf(199)
  if (crc !== null && crc > 0) {
    add('interface-errors', 'warning', crc, PENALTY.interfaceErrors)
  }

  const hours = rawOf(9)
  if (hours !== null && hours >= HIGH_USAGE_HOURS) {
    add('high-usage', 'ok', hours, PENALTY.highUsage)
  }

  score = Math.max(0, Math.min(100, score))

  /*
   * Unreadable sectors are the trigger for imaging first. Reallocated sectors
   * alone are not: remapping is the mechanism working as designed, and every
   * large drive accumulates some. Pending and uncorrectable sectors are data
   * the drive has already failed to read, and each further pass over the
   * platter risks turning a recoverable read into a permanent one.
   */
  const hasUnreadableSectors =
    (pending !== null && pending > 0) || (uncorrectable !== null && uncorrectable > 0)
  const imageBeforeScanning = hasUnreadableSectors || selfAssessmentPassed === false

  return {
    status: classify(score, findings, selfAssessmentPassed),
    score,
    findings,
    imageBeforeScanning,
  }
}

function classify(
  score: number,
  findings: readonly HealthFinding[],
  selfAssessmentPassed: boolean | null,
): DriveHealthStatus {
  if (selfAssessmentPassed === false) return 'failing'

  const critical = findings.filter((finding) => finding.severity === 'critical')

  // A drive can fail with a high score if only one indicator has moved, so the
  // presence of a critical finding decides the status, not the arithmetic.
  if (critical.length >= 2 || score < 50) return 'failing'
  if (critical.length === 1) return 'at-risk'

  // Findings that are purely about age or cabling must not read as danger.
  const warnings = findings.filter((finding) => finding.severity === 'warning')
  if (warnings.length > 0) return 'caution'

  return 'good'
}

/** Prefer the drive temperature over the airflow sensor beside it. */
export function readTemperature(attributes: readonly SmartAttribute[]): number | null {
  for (const id of [194, 190]) {
    const value = attributes.find((attribute) => attribute.id === id)?.raw
    // Zero means the sensor is absent rather than the drive being at freezing.
    if (value !== undefined && value > 0 && value < 150) return value
  }

  return null
}

/**
 * Remaining SSD write endurance, as a percentage.
 *
 * Read from the *normalised* value, not the raw one: these attributes count a
 * percentage down from 100 in the normalised field, while their raw field holds
 * a vendor-specific block count that means nothing on its own.
 */
export function readLifeRemaining(attributes: readonly SmartAttribute[]): number | null {
  for (const id of LIFE_REMAINING_IDS) {
    const attribute = attributes.find((candidate) => candidate.id === id)
    if (attribute !== undefined && attribute.current <= 100) return attribute.current
  }

  return null
}
