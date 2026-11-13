import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyLogSettings,
  getLogger,
  initializeLogging,
  setLogLevel,
  setLogRetention,
  shutdownLogging,
} from '@main/logging/logger'
import { createDefaultSettings, type AppSettings } from '@shared/types/settings'

/**
 * Settings → Diagnostics → "Keep logs for".
 *
 * The rotate transport deletes old files itself, but takes its retention only
 * when it is constructed, so the setting is honoured only if every change
 * reaches a new transport. Its constructor is replaced here to record what
 * each transport was built with, and what it was handed to write.
 */

interface Built {
  readonly options: Record<string, unknown>
  readonly written: Array<{ level: string; message: string }>
}

const rotate = vi.hoisted(() => ({ built: [] as Built[] }))

vi.mock('winston-daily-rotate-file', async () => {
  // The base class the real rotate transport extends, as winston requires.
  const { default: TransportStream } = await import('winston-transport')

  class RecordingTransport extends TransportStream {
    private readonly record: Built

    constructor(options: Record<string, unknown>) {
      super(options)
      this.record = { options, written: [] }
      rotate.built.push(this.record)
    }

    override log(info: { level: string; message: string }, callback: () => void): void {
      this.record.written.push({ level: info.level, message: info.message })
      callback()
    }
  }

  return { default: RecordingTransport }
})

const LOGS = join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'RecoverX', 'logs')

function boot(): void {
  initializeLogging({
    logDirectory: LOGS,
    level: 'info',
    retentionDays: null,
    enableConsole: false,
  })
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...createDefaultSettings('C:\\Recovered'), ...overrides }
}

/** The transport records are going to now. */
function current(): Built {
  const last = rotate.built.at(-1)
  if (last === undefined) throw new Error('No log transport was built')
  return last
}

afterEach(() => {
  shutdownLogging()
  rotate.built.length = 0
})

describe('how long log files are kept', () => {
  it('deletes nothing before the user’s choice has been read', () => {
    boot()

    expect(rotate.built).toHaveLength(1)
    expect(current().options).not.toHaveProperty('maxFiles')
  })

  it('keeps what the user chose as soon as the settings are read at start-up', () => {
    boot()

    applyLogSettings(settings({ logRetentionDays: 90 }))

    expect(current().options).toMatchObject({ maxFiles: '90d', dirname: LOGS })
  })

  it('applies a new choice straight away', () => {
    boot()
    applyLogSettings(settings({ logRetentionDays: 14 }))

    applyLogSettings(settings({ logRetentionDays: 7 }), ['logRetentionDays'])

    expect(current().options).toMatchObject({ maxFiles: '7d' })
  })

  it('keeps one list of files to delete from, whatever the retention', () => {
    // The library's default list is named after a hash of all the options,
    // so a new retention would start an empty list and orphan every file in
    // the old one.
    boot()
    applyLogSettings(settings({ logRetentionDays: 90 }))
    setLogRetention(7)

    const audits = new Set(rotate.built.map((built) => built.options.auditFile))

    expect(audits.size).toBe(1)
    expect([...audits][0]).toBe(join(LOGS, '.recoverx-audit.json'))
  })

  it('leaves the transports alone when the retention did not change', () => {
    boot()
    applyLogSettings(settings({ logRetentionDays: 30 }))
    const built = rotate.built.length

    applyLogSettings(settings({ logRetentionDays: 30, logLevel: 'debug' }), ['logLevel'])
    setLogRetention(30)

    expect(rotate.built).toHaveLength(built)
  })

  it('keeps the user’s log level, and loggers handed out earlier, across the change', () => {
    boot()
    const scan = getLogger('scan')
    setLogLevel('debug')

    setLogRetention(60)
    scan.debug('Reading the MFT')

    expect(current().options).toMatchObject({ maxFiles: '60d' })
    expect(current().written).toEqual([{ level: 'debug', message: 'Reading the MFT' }])
  })

  it('does nothing when logging is not running', () => {
    setLogRetention(7)
    applyLogSettings(settings({ logRetentionDays: 7 }))

    expect(rotate.built).toEqual([])
  })
})
