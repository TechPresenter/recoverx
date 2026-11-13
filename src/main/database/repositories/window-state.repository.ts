import { describeUnknown } from '@shared/utils/errors'
import type { Logger } from '../../logging/logger'
import {
  type SqliteDatabase,
  type SqliteStatement,
  readBoolean,
  readInteger,
  readOptionalInteger,
} from '../sqlite'

/**
 * Persistence for the main window's geometry.
 *
 * Restoring the window where the user left it is a small thing that separates an
 * application which feels native from one that feels like a web page in a frame.
 *
 * Every method swallows its errors: failing to remember a window position is
 * never a reason to fail a launch or block a shutdown.
 */

export interface PersistedWindowState {
  readonly x: number | null
  readonly y: number | null
  readonly width: number
  readonly height: number
  readonly isMaximized: boolean
}

export class WindowStateRepository {
  private readonly select: SqliteStatement
  private readonly upsert: SqliteStatement
  private readonly logger: Logger

  constructor(db: SqliteDatabase, logger: Logger) {
    this.logger = logger

    this.select = db.prepare(
      'SELECT x, y, width, height, is_maximized FROM window_state WHERE id = 1',
    )

    this.upsert = db.prepare(`
      INSERT INTO window_state (id, x, y, width, height, is_maximized, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        x = excluded.x,
        y = excluded.y,
        width = excluded.width,
        height = excluded.height,
        is_maximized = excluded.is_maximized,
        updated_at = excluded.updated_at
    `)
  }

  /** Last persisted geometry, or `null` on first run. */
  read(): PersistedWindowState | null {
    try {
      const row = this.select.get()
      if (row === undefined) return null

      return {
        x: readOptionalInteger(row, 'x'),
        y: readOptionalInteger(row, 'y'),
        width: readInteger(row, 'width'),
        height: readInteger(row, 'height'),
        isMaximized: readBoolean(row, 'is_maximized'),
      }
    } catch (error) {
      this.logger.warn('Could not read persisted window state', { reason: describeUnknown(error) })
      return null
    }
  }

  /** Store the current geometry. */
  write(state: PersistedWindowState): void {
    try {
      this.upsert.run(
        state.x,
        state.y,
        state.width,
        state.height,
        state.isMaximized ? 1 : 0,
        Date.now(),
      )
    } catch (error) {
      this.logger.warn('Could not persist window state', { reason: describeUnknown(error) })
    }
  }
}
