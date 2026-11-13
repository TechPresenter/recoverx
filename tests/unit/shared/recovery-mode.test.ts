import { describe, expect, it } from 'vitest'
import {
  RECOVERY_MODES,
  RECOVERY_MODE_ORDER,
  allowsScanTypeChoice,
  modePreset,
  type RecoveryModeId,
} from '@shared/types/recovery-mode'

/**
 * These presets decide whether a scan can work at all, so they are pinned.
 *
 * Quietly flipping "formatted drive" to a quick scan would produce a scan that
 * completes in seconds and finds nothing, and the user would conclude their data
 * was gone.
 */
describe('recovery mode presets', () => {
  it('uses a metadata scan for deleted files, where the records survive', () => {
    const preset = modePreset('deleted-files')

    expect(preset.scanType).toBe('quick')
    expect(preset.target).toBe('partition')
    // Deleted files are the point; existing ones would bury them.
    expect(preset.includeExisting).toBe(false)
    expect(preset.deletedOnlyByDefault).toBe(true)
  })

  it('uses carving for a formatted drive, where the records are gone', () => {
    // Formatting writes a fresh empty filesystem. A quick scan would read that
    // empty filesystem, report nothing, and mislead the user completely.
    const preset = modePreset('formatted-drive')

    expect(preset.scanType).toBe('deep')
    expect(preset.includeExisting).toBe(true)
    // Every carved result is equally "deleted", so the filter would be noise.
    expect(preset.deletedOnlyByDefault).toBe(false)
  })

  it('reads the whole device for an unmountable drive', () => {
    // The partition table may be the broken thing, so there is no partition to
    // scan — and the lost partition's data sits in unallocated space.
    const preset = modePreset('raw-drive')

    expect(preset.scanType).toBe('deep')
    expect(preset.target).toBe('device')
  })

  it('only lets the user override the scan type in custom mode', () => {
    // Offering a quick scan for a formatted drive offers a scan that cannot
    // work, and a control that produces nothing is worse than no control.
    expect(allowsScanTypeChoice('custom')).toBe(true)
    expect(allowsScanTypeChoice('deleted-files')).toBe(false)
    expect(allowsScanTypeChoice('formatted-drive')).toBe(false)
    expect(allowsScanTypeChoice('raw-drive')).toBe(false)
  })

  it('defines a preset for every mode in the display order', () => {
    for (const id of RECOVERY_MODE_ORDER) {
      expect(modePreset(id)).toBeDefined()
      expect(modePreset(id).id).toBe(id)
    }
  })

  it('lists every defined mode exactly once in the display order', () => {
    const defined = Object.keys(RECOVERY_MODES) as RecoveryModeId[]

    expect([...RECOVERY_MODE_ORDER].sort()).toEqual([...defined].sort())
    expect(new Set(RECOVERY_MODE_ORDER).size).toBe(RECOVERY_MODE_ORDER.length)
  })

  it('puts the commonest scenario first', () => {
    // A user who deleted a file is the overwhelming majority of cases.
    expect(RECOVERY_MODE_ORDER[0]).toBe('deleted-files')
    expect(RECOVERY_MODE_ORDER.at(-1)).toBe('custom')
  })

  it('never pairs a device-level target with a quick scan', () => {
    // A quick scan reads a filesystem's records, which live inside a partition.
    // A whole-device quick scan has nothing to read.
    for (const id of RECOVERY_MODE_ORDER) {
      const preset = modePreset(id)
      if (preset.target === 'device') expect(preset.scanType).toBe('deep')
    }
  })
})
