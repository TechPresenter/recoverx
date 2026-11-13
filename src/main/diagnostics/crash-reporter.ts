import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import {
  CrashReportSchema,
  MAX_CRASH_REPORTS,
  type CrashKind,
  type CrashReport,
} from '@shared/types/diagnostics'
import { describeUnknown } from '@shared/utils/errors'
import { parseJson } from '@shared/utils/json'
import type { Logger } from '../logging/logger'
import { createRedactor, type Redactor } from './redaction'

/**
 * Crash reports.
 *
 * A crash is written to a file of its own rather than only to the rolling log,
 * because the two are read at different moments. The log answers "what was the
 * application doing"; a crash report answers "what killed it", and it has to
 * survive being found days later by someone who does not know what to grep for.
 *
 * Everything is redacted before it is written, not before it is sent. Writing
 * the raw text and cleaning it on the way out means the unredacted copy exists
 * on disk, gets attached to a support email by a helpful user, and defeats the
 * whole exercise. Redacting on the way in means the file on disk is already the
 * version that is safe to share.
 */

const CRASH_DIR = 'crashes'
const FILE_SUFFIX = '.crash.json'

export class CrashReporter {
  private readonly directory: string
  private readonly logger: Logger
  private readonly redactor: Redactor

  constructor(userDataDir: string, logger: Logger) {
    this.directory = join(userDataDir, CRASH_DIR)
    this.logger = logger.child('crash')
    this.redactor = createRedactor()
  }

  /**
   * Record a crash.
   *
   * Never throws. This runs from inside an `uncaughtException` handler, where a
   * second failure would take down the process while it is already trying to
   * explain the first one.
   */
  record(kind: CrashKind, error: unknown, extra?: Readonly<Record<string, unknown>>): void {
    try {
      const stack = error instanceof Error ? (error.stack ?? null) : null

      const report: CrashReport = {
        id: randomUUID(),
        occurredAt: Date.now(),
        kind,
        message: this.redactor(describeUnknown(error)),
        stack: stack === null ? null : this.redactor(stack),
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        osVersion: release(),
        arch: process.arch,
        uptimeSeconds: Math.round(process.uptime()),
        sent: false,
      }

      mkdirSync(this.directory, { recursive: true })
      writeFileSync(
        join(this.directory, `${String(report.occurredAt)}-${report.id}${FILE_SUFFIX}`),
        JSON.stringify({ ...report, ...(extra === undefined ? {} : { context: extra }) }, null, 2),
        'utf8',
      )

      this.prune()
      this.logger.error('Crash recorded', { kind, id: report.id })
    } catch (failure) {
      // Deliberately swallowed. There is nowhere left to report a failure to
      // report a failure, and rethrowing here would replace a diagnosable crash
      // with an undiagnosable one.
      this.logger.warn('A crash report could not be written', {
        error: describeUnknown(failure),
      })
    }
  }

  /** Stored reports, newest first. */
  list(): CrashReport[] {
    let files: string[]
    try {
      files = readdirSync(this.directory).filter((name) => name.endsWith(FILE_SUFFIX))
    } catch {
      // No directory means no crashes, which is the good case.
      return []
    }

    const reports: CrashReport[] = []

    for (const name of files) {
      try {
        const parsed = parseJson(
          readFileSync(join(this.directory, name), 'utf8'),
          CrashReportSchema,
        )
        if (parsed.ok) reports.push(parsed.data)
      } catch {
        // A half-written file from a crash during the crash write. Skipping it
        // is correct: the others are still readable.
      }
    }

    return reports.sort((a, b) => b.occurredAt - a.occurredAt)
  }

  /** Delete every stored report. */
  clear(): number {
    const files = this.list()

    try {
      rmSync(this.directory, { recursive: true, force: true })
    } catch (error) {
      this.logger.warn('Crash reports could not be removed', { error: describeUnknown(error) })
      return 0
    }

    return files.length
  }

  /** The directory, so the user can be shown where the reports actually are. */
  directoryPath(): string {
    return this.directory
  }

  /** Discard the oldest once the cap is passed. */
  private prune(): void {
    const files = readdirSync(this.directory)
      .filter((name) => name.endsWith(FILE_SUFFIX))
      .sort()

    for (const name of files.slice(0, Math.max(0, files.length - MAX_CRASH_REPORTS))) {
      try {
        rmSync(join(this.directory, name), { force: true })
      } catch {
        // A file that will not delete is not worth failing a crash write over.
      }
    }
  }
}
