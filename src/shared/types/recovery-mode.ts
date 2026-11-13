import { z } from 'zod'
import type { ScanType } from './scan'

/**
 * Recovery modes.
 *
 * Three of the features a recovery product advertises — "deleted file
 * recovery", "formatted drive recovery", "RAW drive recovery" — are not three
 * engines. They are the same scan and restore machinery pointed at different
 * targets with different settings. Competitors list them separately because it
 * sells; the honest implementation is a preset.
 *
 * What the preset genuinely buys is the framing. A user who has just formatted
 * the wrong drive does not know they need a signature carve of a partition with
 * existing files included. They know they formatted the wrong drive. Asking the
 * question in their terms and deriving the settings is the whole value.
 */

export const RecoveryModeIdSchema = z.enum([
  'deleted-files',
  'formatted-drive',
  'raw-drive',
  'custom',
])
export type RecoveryModeId = z.infer<typeof RecoveryModeIdSchema>

/** Whether a mode operates on a volume or on the raw device. */
export type ModeTarget = 'partition' | 'device'

export interface RecoveryModePreset {
  readonly id: RecoveryModeId
  readonly scanType: ScanType
  /**
   * What the user must pick.
   *
   * `device` matters for a drive Windows shows as RAW: its partition table may
   * be the thing that is broken, so scanning "the partition" is not an option —
   * there is no partition to scan.
   */
  readonly target: ModeTarget
  /** Include files the filesystem still lists. */
  readonly includeExisting: boolean
  /** Whether the results view opens filtered to deleted files only. */
  readonly deletedOnlyByDefault: boolean
}

export const RECOVERY_MODES: Readonly<Record<RecoveryModeId, RecoveryModePreset>> = {
  /**
   * Files removed from an intact filesystem.
   *
   * The records survive, so a metadata scan is both faster and far more
   * informative than carving — it keeps names, folders and dates.
   */
  'deleted-files': {
    id: 'deleted-files',
    scanType: 'quick',
    target: 'partition',
    includeExisting: false,
    deletedOnlyByDefault: true,
  },

  /**
   * A volume that has been reformatted.
   *
   * Formatting writes a fresh, empty filesystem: the old records are gone, so
   * there is nothing for a metadata scan to read. Only carving reaches the data,
   * and every result it finds is equally "deleted" — so the deleted-only filter
   * would draw a distinction that no longer exists.
   */
  'formatted-drive': {
    id: 'formatted-drive',
    scanType: 'deep',
    target: 'partition',
    includeExisting: true,
    deletedOnlyByDefault: false,
  },

  /**
   * A drive Windows cannot mount at all.
   *
   * The partition table or boot sector is damaged, so the device must be read
   * whole — including the unallocated space where a lost partition's data sits.
   */
  'raw-drive': {
    id: 'raw-drive',
    scanType: 'deep',
    target: 'device',
    includeExisting: true,
    deletedOnlyByDefault: false,
  },

  /** Every setting exposed, for a user who knows what they want. */
  custom: {
    id: 'custom',
    scanType: 'quick',
    target: 'partition',
    includeExisting: false,
    deletedOnlyByDefault: true,
  },
}

/** Display order on the mode picker, commonest scenario first. */
export const RECOVERY_MODE_ORDER: readonly RecoveryModeId[] = [
  'deleted-files',
  'formatted-drive',
  'raw-drive',
  'custom',
]

export function modePreset(id: RecoveryModeId): RecoveryModePreset {
  return RECOVERY_MODES[id]
}

/**
 * `true` when the mode lets the user change the scan type.
 *
 * Only `custom` does. Offering a quick scan for a formatted drive would be
 * offering a scan that cannot work, and a control that produces nothing is
 * worse than no control.
 */
export function allowsScanTypeChoice(id: RecoveryModeId): boolean {
  return id === 'custom'
}
