import {
  type AppSettings,
  type AppSettingsPatch,
  createDefaultSettings,
} from '@shared/types/settings'
import { AppError, ErrorCode } from '@shared/utils/errors'
import type { SettingsRepository } from '../database/repositories/settings.repository'
import type { Logger } from '../logging/logger'
import {
  changedKeys,
  decodeSettings,
  encodeSettings,
  encodeSettingsPatch,
  mergeSettings,
} from './settings-codec'

/**
 * Authoritative in-memory settings, backed by SQLite.
 *
 * Reads are served from cache because settings are consulted on nearly every
 * operation — theme resolution, byte formatting, safety confirmations — and a
 * synchronous database round trip on each would be wasteful. The cache is only
 * ever replaced after a successful write, so it cannot drift from disk.
 */

export type SettingsListener = (
  settings: AppSettings,
  changed: ReadonlyArray<keyof AppSettings>,
) => void

export class SettingsService {
  private readonly repository: SettingsRepository
  private readonly logger: Logger
  private readonly defaults: AppSettings
  private readonly listeners = new Set<SettingsListener>()
  private cache: AppSettings

  constructor(repository: SettingsRepository, defaultRecoveryPath: string, logger: Logger) {
    this.repository = repository
    this.logger = logger
    this.defaults = createDefaultSettings(defaultRecoveryPath)
    this.cache = this.defaults
  }

  /**
   * Load persisted settings into the cache.
   *
   * Invalid rows are repaired in place: the default is written back so the next
   * start is clean, and the user is not left with a preference that silently
   * resets on every launch.
   */
  load(): AppSettings {
    const rows = this.repository.readAll()
    const decoded = decodeSettings(rows, this.defaults)

    this.cache = decoded.settings

    if (decoded.invalidKeys.length > 0) {
      this.logger.warn('Repaired invalid settings values', { keys: decoded.invalidKeys })

      const repaired: Record<string, string> = {}
      for (const key of decoded.invalidKeys) {
        const value = this.cache[key as keyof AppSettings]
        repaired[key] = JSON.stringify(value)
      }
      this.repository.writeMany(repaired)
    }

    if (decoded.orphanedKeys.length > 0) {
      // Settings removed by an upgrade. Pruning them keeps the table aligned
      // with the schema and stops them reappearing in support bundles.
      this.logger.debug('Removing settings that are no longer part of the schema', {
        keys: decoded.orphanedKeys,
      })
      this.repository.removeKeys(decoded.orphanedKeys)
    }

    return this.cache
  }

  /** Current settings. Never hits the database. */
  getAll(): AppSettings {
    return this.cache
  }

  /**
   * Apply a partial update.
   *
   * The merged object is validated as a whole before anything is written, so a
   * combination that is individually valid but jointly nonsensical cannot be
   * persisted. A patch that changes nothing short-circuits without a write or a
   * notification.
   */
  update(patch: AppSettingsPatch): AppSettings {
    const merged = mergeSettings(this.cache, patch)

    if (merged === null) {
      throw new AppError(ErrorCode.Validation, 'The requested settings are not valid', {
        retryable: false,
      })
    }

    const changed = changedKeys(this.cache, merged)
    if (changed.length === 0) return this.cache

    this.repository.writeMany(encodeSettingsPatch(patch))
    this.cache = merged

    this.logger.info('Settings updated', { changed })
    this.emit(changed)

    return this.cache
  }

  /** Restore factory defaults and persist them. */
  reset(): AppSettings {
    const previous = this.cache

    this.repository.clear()
    this.repository.writeMany(encodeSettings(this.defaults))
    this.cache = this.defaults

    const changed = changedKeys(previous, this.defaults)
    this.logger.info('Settings reset to defaults', { changed })

    if (changed.length > 0) this.emit(changed)

    return this.cache
  }

  /** Subscribe to settings changes. Returns an unsubscribe function. */
  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(changed: ReadonlyArray<keyof AppSettings>): void {
    for (const listener of this.listeners) {
      try {
        listener(this.cache, changed)
      } catch (error) {
        // A misbehaving subscriber must not roll back a write that already
        // succeeded, nor prevent the remaining subscribers from running.
        this.logger.warn('A settings listener threw', { error: String(error) })
      }
    }
  }
}
