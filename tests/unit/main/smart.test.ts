import { describe, expect, it } from 'vitest'
import {
  SMART_PAGE_BYTES,
  assessHealth,
  decodeSmartPage,
  readLifeRemaining,
  readTemperature,
} from '@main/health/smart-attributes'
import { buildDriveHealth } from '@main/health/health.service'
import type { SmartAttribute } from '@shared/types/health'

/**
 * SMART decoding and the judgement built on it.
 *
 * Real drives cannot be made to produce the readings that matter — a failing
 * drive is precisely what is not available to test against — so the pages here
 * are assembled byte by byte to the ATA layout.
 */

interface AttributeSpec {
  readonly id: number
  readonly current?: number
  readonly worst?: number
  readonly raw?: number
  readonly preFailure?: boolean
}

/** Build a SMART data page in the layout the ATA specification defines. */
function buildPage(specs: readonly AttributeSpec[]): Buffer {
  const page = Buffer.alloc(SMART_PAGE_BYTES)
  page.writeUInt16LE(0x0010, 0)

  specs.forEach((spec, index) => {
    const base = 2 + index * 12
    const raw = spec.raw ?? 0

    page.writeUInt8(spec.id, base)
    page.writeUInt16LE(spec.preFailure === true ? 0x0001 : 0x0002, base + 1)
    page.writeUInt8(spec.current ?? 100, base + 3)
    page.writeUInt8(spec.worst ?? 100, base + 4)
    // The raw field is 48 bits little-endian: four low bytes then two high.
    page.writeUInt32LE(raw >>> 0, base + 5)
    page.writeUInt16LE(Math.floor(raw / 0x1_0000_0000), base + 9)
  })

  return page
}

function buildThresholds(entries: ReadonlyArray<readonly [number, number]>): Buffer {
  const page = Buffer.alloc(SMART_PAGE_BYTES)
  page.writeUInt16LE(0x0010, 0)

  entries.forEach(([id, threshold], index) => {
    const base = 2 + index * 12
    page.writeUInt8(id, base)
    page.writeUInt8(threshold, base + 1)
  })

  return page
}

describe('decodeSmartPage', () => {
  it('decodes an attribute into its named parts', () => {
    const page = buildPage([{ id: 5, current: 97, worst: 95, raw: 12, preFailure: true }])

    const [attribute] = decodeSmartPage(page)

    expect(attribute).toMatchObject({
      id: 5,
      name: 'Reallocated sectors count',
      current: 97,
      worst: 95,
      raw: 12,
      isPreFailure: true,
      isDecisive: true,
    })
  })

  it('reads a raw value wider than 32 bits', () => {
    // Power-on hours stay small, but total-bytes-written counters routinely
    // pass 2^32 and a 32-bit read silently wraps them.
    const raw = 0x2_0000_0005
    const page = buildPage([{ id: 9, raw }])

    expect(decodeSmartPage(page)[0]?.raw).toBe(raw)
  })

  it('skips unused slots without stopping', () => {
    // The table is fixed-length and sparsely filled, so a zero identifier is
    // padding. Treating it as the end of the data loses every later attribute.
    const page = buildPage([{ id: 5, raw: 1 }])
    // Leave slot 1 empty and write into slot 2.
    const base = 2 + 2 * 12
    page.writeUInt8(197, base)
    page.writeUInt8(100, base + 3)
    page.writeUInt32LE(4, base + 5)

    const ids = decodeSmartPage(page).map((attribute) => attribute.id)

    expect(ids).toEqual([5, 197])
  })

  it('applies the manufacturer threshold when one is supplied', () => {
    const page = buildPage([{ id: 5, current: 30, preFailure: true }])
    const thresholds = buildThresholds([[5, 36]])

    const [attribute] = decodeSmartPage(page, thresholds)

    expect(attribute?.threshold).toBe(36)
    // The drive is below its own manufacturer's failure threshold, which
    // outranks any heuristic this application applies.
    expect(attribute?.status).toBe('critical')
  })

  it('reads without thresholds when the drive does not supply them', () => {
    const [attribute] = decodeSmartPage(buildPage([{ id: 5, raw: 0 }]))

    expect(attribute?.threshold).toBeNull()
    expect(attribute?.status).toBe('ok')
  })

  it('reports an unknown attribute rather than discarding it', () => {
    // A vendor-specific attribute a user may need to quote to a manufacturer
    // must survive, even though nothing here can interpret it.
    const [attribute] = decodeSmartPage(buildPage([{ id: 250, raw: 7 }]))

    expect(attribute?.name).toBe('Vendor attribute 250')
    expect(attribute?.isDecisive).toBe(false)
    expect(attribute?.status).toBe('unknown')
  })

  it('returns nothing for a truncated page', () => {
    expect(decodeSmartPage(Buffer.alloc(4))).toEqual([])
  })

  it('orders attributes by identifier', () => {
    const page = buildPage([{ id: 194 }, { id: 5 }, { id: 9 }])

    expect(decodeSmartPage(page).map((a) => a.id)).toEqual([5, 9, 194])
  })
})

describe('raw value interpretation', () => {
  it('extracts the current temperature from a packed field', () => {
    // Drives pack the lifetime minimum and maximum into the upper bytes. Read
    // verbatim, a 38 °C drive reports a temperature in the millions.
    const packed = 38 + (20 << 16) + (55 << 24)
    const page = buildPage([{ id: 194, raw: packed }])

    expect(decodeSmartPage(page)[0]?.raw).toBe(38)
  })

  it('falls back to the low byte when the packing is unrecognised', () => {
    const page = buildPage([{ id: 194, raw: 0x9c40 + 42 }])

    const value = decodeSmartPage(page)[0]?.raw ?? 0

    expect(value).toBeLessThan(200)
  })

  it('converts logical sector counters into bytes', () => {
    // Attributes 241 and 242 count 512-byte sectors, not bytes.
    const page = buildPage([{ id: 241, raw: 1000 }])

    expect(decodeSmartPage(page)[0]?.raw).toBe(1000 * 512)
    expect(decodeSmartPage(page)[0]?.unit).toBe('bytes')
  })

  it('leaves a count alone', () => {
    expect(decodeSmartPage(buildPage([{ id: 5, raw: 12 }]))[0]?.raw).toBe(12)
  })
})

describe('assessHealth', () => {
  function assess(specs: readonly AttributeSpec[], passed: boolean | null = true) {
    return assessHealth(decodeSmartPage(buildPage(specs)), passed)
  }

  it('reports a clean drive as healthy', () => {
    const result = assess([
      { id: 5, raw: 0 },
      { id: 197, raw: 0 },
      { id: 9, raw: 1000 },
    ])

    expect(result.status).toBe('good')
    expect(result.score).toBe(100)
    expect(result.findings).toEqual([])
    expect(result.imageBeforeScanning).toBe(false)
  })

  it('treats pending sectors as the strongest warning there is', () => {
    // These are sectors the drive cannot currently read. Backblaze's fleet
    // analysis puts this among the few attributes that genuinely predict
    // failure, and it is the reason to image before scanning.
    const result = assess([{ id: 197, raw: 8 }])

    expect(result.findings.map((f) => f.code)).toContain('pending-sectors')
    expect(result.status).toBe('at-risk')
    expect(result.imageBeforeScanning).toBe(true)
  })

  it('calls for an image before scanning when sectors are unreadable', () => {
    const result = assess([{ id: 198, raw: 3 }])

    expect(result.imageBeforeScanning).toBe(true)
  })

  it('does not demand an image for reallocated sectors alone', () => {
    // Remapping is the mechanism working as designed, and every large drive
    // accumulates some. Sending users to image a drive over four remapped
    // sectors would make the warning meaningless when it matters.
    const result = assess([{ id: 5, raw: 4 }])

    expect(result.imageBeforeScanning).toBe(false)
    expect(result.status).toBe('caution')
  })

  it('escalates a drive shedding sectors in quantity', () => {
    const result = assess([{ id: 5, raw: 120 }])

    expect(result.findings[0]?.severity).toBe('critical')
    expect(result.status).toBe('at-risk')
  })

  it('calls a drive failing when several indicators have moved', () => {
    const result = assess([
      { id: 5, raw: 60 },
      { id: 197, raw: 12 },
      { id: 198, raw: 4 },
    ])

    expect(result.status).toBe('failing')
    expect(result.imageBeforeScanning).toBe(true)
  })

  it("trusts the drive's own failure prediction above everything else", () => {
    const result = assess([{ id: 5, raw: 0 }], false)

    expect(result.status).toBe('failing')
    expect(result.imageBeforeScanning).toBe(true)
    expect(result.findings.map((f) => f.code)).toContain('self-assessment-failed')
  })

  it('does not blame the drive for interface errors', () => {
    // Attribute 199 counts corruption between the drive and the computer: a
    // cable, port or enclosure fault. Scoring it as drive failure tells users
    // to replace healthy hardware instead of reseating a cable.
    const result = assess([{ id: 199, raw: 40 }])

    expect(result.findings.map((f) => f.code)).toEqual(['interface-errors'])
    expect(result.status).toBe('caution')
    expect(result.imageBeforeScanning).toBe(false)
    expect(result.score).toBeGreaterThan(90)
  })

  it('separates ageing from failing', () => {
    // Six years of uptime is not a fault, and a drive reported as failing for
    // being old is a drive the user replaces for nothing.
    const result = assess([{ id: 9, raw: 52_000 }])

    expect(result.findings.map((f) => f.code)).toEqual(['high-usage'])
    expect(result.status).toBe('good')
  })

  it('warns about heat without calling it a failure', () => {
    const result = assess([{ id: 194, raw: 58 }])

    expect(result.findings.map((f) => f.code)).toContain('overheating')
    expect(result.status).toBe('caution')
  })

  it('treats an extreme temperature as critical', () => {
    const result = assess([{ id: 194, raw: 72 }])

    expect(result.findings.find((f) => f.code === 'overheating')?.severity).toBe('critical')
  })

  it('flags an SSD that has used up its write endurance', () => {
    const result = assess([{ id: 231, current: 4, raw: 0 }])

    expect(result.findings.map((f) => f.code)).toContain('wear-exhausted')
  })

  it('reports nothing rather than guessing when there is no data', () => {
    const result = assessHealth([], null)

    expect(result.status).toBe('unknown')
    expect(result.imageBeforeScanning).toBe(false)
  })

  it('never returns a score outside 0 to 100', () => {
    const result = assess(
      [
        { id: 5, raw: 500 },
        { id: 187, raw: 500 },
        { id: 188, raw: 500 },
        { id: 197, raw: 500 },
        { id: 198, raw: 500 },
        { id: 199, raw: 500 },
        { id: 194, raw: 80 },
      ],
      false,
    )

    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })
})

describe('summary readings', () => {
  function attributes(specs: readonly AttributeSpec[]): SmartAttribute[] {
    return decodeSmartPage(buildPage(specs))
  }

  it('prefers the drive temperature over the airflow sensor', () => {
    const value = readTemperature(
      attributes([
        { id: 190, raw: 44 },
        { id: 194, raw: 38 },
      ]),
    )

    expect(value).toBe(38)
  })

  it('falls back to the airflow sensor when there is no drive sensor', () => {
    expect(readTemperature(attributes([{ id: 190, raw: 44 }]))).toBe(44)
  })

  it('treats a zero reading as a missing sensor, not freezing', () => {
    expect(readTemperature(attributes([{ id: 194, raw: 0 }]))).toBeNull()
  })

  it('reads SSD life from the normalised value, not the raw one', () => {
    // The raw field of these attributes holds a vendor-specific block count;
    // only the normalised value counts a percentage down from 100.
    const value = readLifeRemaining(attributes([{ id: 233, current: 82, raw: 918_273 }]))

    expect(value).toBe(82)
  })

  it('reports no life figure for a drive that does not track wear', () => {
    expect(readLifeRemaining(attributes([{ id: 5, raw: 0 }]))).toBeNull()
  })
})

describe('buildDriveHealth', () => {
  const AT = 1_700_000_000_000

  function query(overrides: Record<string, unknown> = {}) {
    return {
      Smart: [],
      Thresholds: [],
      Status: [],
      Physical: [],
      Reliability: [],
      ...overrides,
    } as Parameters<typeof buildDriveHealth>[3]
  }

  function page(specs: readonly AttributeSpec[]): number[] {
    return [...buildPage(specs)]
  }

  it('blames the missing permission, not the drive, when unelevated', () => {
    // Windows returns zero rows from every SMART provider to an unelevated
    // process rather than an error. Reporting that as "this drive does not
    // support SMART" sends the user looking for a different tool instead of
    // reopening this one as Administrator.
    const health = buildDriveHealth('disk0', 0, 'SER123', query(), AT, false)

    expect(health.unavailable).toBe('needs-elevation')
    expect(health.status).toBe('unknown')
  })

  it('blames the drive only when it genuinely had the chance to answer', () => {
    const health = buildDriveHealth('disk0', 0, 'SER123', query(), AT, true)

    expect(health.unavailable).toBe('not-supported')
  })

  it('never calls an unreadable drive healthy', () => {
    // The worst available outcome: a USB bridge hides SMART, and the user is
    // told their failing disk is fine.
    const health = buildDriveHealth('disk0', 0, null, null, AT)

    expect(health.status).toBe('unknown')
    expect(health.unavailable).toBe('query-failed')
    expect(health.imageBeforeScanning).toBe(false)
  })

  it('matches a drive to its SMART record by disk number', () => {
    const health = buildDriveHealth(
      'disk1',
      1,
      null,
      query({
        Smart: [
          {
            InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.0.0_0`,
            VendorSpecific: page([{ id: 5, raw: 99 }]),
          },
          {
            InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.1.0_1`,
            VendorSpecific: page([{ id: 5, raw: 7 }]),
          },
        ],
      }),
      AT,
    )

    // The second drive's record, not the first.
    expect(health.reallocatedSectors).toBe(7)
  })

  it('prefers a serial number match over positional matching', () => {
    // Instance paths are ordered by controller position, which does not always
    // follow the disk number. A serial number is unambiguous.
    const health = buildDriveHealth(
      'disk0',
      0,
      'SER-B',
      query({
        Smart: [
          {
            InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.0.0_0`,
            VendorSpecific: page([{ id: 5, raw: 1 }]),
          },
          {
            InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.1.0_1`,
            VendorSpecific: page([{ id: 5, raw: 42 }]),
          },
        ],
        Physical: [
          { DeviceId: '0', SerialNumber: 'SER-A', HealthStatus: 0 },
          { DeviceId: '1', SerialNumber: 'SER-B', HealthStatus: 0 },
        ],
      }),
      AT,
    )

    expect(health.reallocatedSectors).toBe(42)
  })

  it('needs no matching at all on a single-drive machine', () => {
    const health = buildDriveHealth(
      'disk0',
      0,
      null,
      query({
        Smart: [
          {
            InstanceName: String.raw`SCSI\Disk&Ven_&Prod_X&Rev_\4&1ee2&0&000000`,
            VendorSpecific: page([{ id: 5, raw: 3 }]),
          },
        ],
      }),
      AT,
    )

    expect(health.reallocatedSectors).toBe(3)
  })

  it('falls back to the storage stack counters when SMART is absent', () => {
    // The usual NVMe case: no ATA SMART page, but temperature and hours are
    // still worth showing.
    const health = buildDriveHealth(
      'disk0',
      0,
      null,
      query({
        Reliability: [
          { DeviceId: '0', Temperature: 41, PowerOnHours: 9000, Wear: 12, ReadErrorsTotal: 0 },
        ],
      }),
      AT,
    )

    expect(health.unavailable).toBe('summary-only')
    expect(health.temperatureCelsius).toBe(41)
    expect(health.powerOnHours).toBe(9000)
    expect(health.lifeRemainingPercent).toBe(88)
    // No per-attribute data means no verdict may be offered.
    expect(health.status).toBe('unknown')
  })

  it('rejects an implausible temperature from a summary counter', () => {
    // USB bridges return 0 for "no sensor", and some return raw Kelvin.
    const health = buildDriveHealth(
      'disk0',
      0,
      null,
      query({
        Reliability: [
          { DeviceId: '0', Temperature: 0, PowerOnHours: 100, Wear: null, ReadErrorsTotal: 0 },
        ],
      }),
      AT,
    )

    expect(health.temperatureCelsius).toBeNull()
  })

  it('carries the failure prediction through even without attributes', () => {
    const health = buildDriveHealth(
      'disk0',
      0,
      null,
      query({
        Status: [
          { InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.0.0_0`, PredictFailure: true },
        ],
      }),
      AT,
    )

    expect(health.selfAssessmentPassed).toBe(false)
    expect(health.status).toBe('failing')
    expect(health.imageBeforeScanning).toBe(true)
  })

  it('assembles a full reading when SMART is available', () => {
    const health = buildDriveHealth(
      'disk0',
      0,
      null,
      query({
        Smart: [
          {
            InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.0.0_0`,
            VendorSpecific: page([
              { id: 5, raw: 2 },
              { id: 9, raw: 14_000 },
              { id: 12, raw: 640 },
              { id: 194, raw: 39 },
              { id: 197, raw: 0 },
            ]),
          },
        ],
        Status: [
          {
            InstanceName: String.raw`IDE\DiskVendor_Model\5&2ab1&0&0.0.0_0`,
            PredictFailure: false,
          },
        ],
      }),
      AT,
    )

    expect(health.unavailable).toBeNull()
    expect(health).toMatchObject({
      deviceId: 'disk0',
      capturedAt: AT,
      temperatureCelsius: 39,
      powerOnHours: 14_000,
      powerCycles: 640,
      reallocatedSectors: 2,
      pendingSectors: 0,
      selfAssessmentPassed: true,
    })
    expect(health.attributes).toHaveLength(5)
  })
})
