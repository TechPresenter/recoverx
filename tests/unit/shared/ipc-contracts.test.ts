import { describe, expect, it } from 'vitest'
import {
  IPC_CHANNEL_NAMES,
  IPC_EVENT_NAMES,
  IpcChannel,
  IpcEvent,
  isIpcChannelName,
  isIpcEventName,
} from '@shared/ipc/channels'
import { IPC_CONTRACTS, IPC_EVENT_CONTRACTS, getContract } from '@shared/ipc/contracts'

/**
 * The IPC contract is the security boundary between a sandboxed renderer and a
 * main process holding an Administrator token. These tests assert the properties
 * that boundary depends on: full coverage, and rejection of malformed payloads.
 */

describe('IPC channel inventory', () => {
  it('declares a request and response schema for every channel', () => {
    for (const channel of IPC_CHANNEL_NAMES) {
      const contract = getContract(channel)

      expect(contract, `missing contract for ${channel}`).toBeDefined()
      expect(typeof contract.request.safeParse).toBe('function')
      expect(typeof contract.response.safeParse).toBe('function')
    }
  })

  it('has no contract without a corresponding channel name', () => {
    expect(Object.keys(IPC_CONTRACTS).sort()).toEqual([...IPC_CHANNEL_NAMES].sort())
  })

  it('declares a payload schema for every event', () => {
    expect(Object.keys(IPC_EVENT_CONTRACTS).sort()).toEqual([...IPC_EVENT_NAMES].sort())
  })

  it('uses unique, namespaced channel names', () => {
    expect(new Set(IPC_CHANNEL_NAMES).size).toBe(IPC_CHANNEL_NAMES.length)

    for (const channel of IPC_CHANNEL_NAMES) {
      expect(channel).toMatch(/^[a-z]+:[a-z-]+$/)
    }
  })

  it('namespaces every event distinctly from request channels', () => {
    for (const event of IPC_EVENT_NAMES) {
      expect(event.startsWith('evt:')).toBe(true)
      expect(IPC_CHANNEL_NAMES).not.toContain(event as never)
    }
  })
})

describe('channel name guards', () => {
  it('accepts declared names and rejects everything else', () => {
    expect(isIpcChannelName(IpcChannel.AppGetInfo)).toBe(true)
    expect(isIpcChannelName('app:delete-everything')).toBe(false)
    expect(isIpcChannelName(42)).toBe(false)
    expect(isIpcChannelName(null)).toBe(false)

    expect(isIpcEventName(IpcEvent.SettingsChanged)).toBe(true)
    expect(isIpcEventName('evt:not-real')).toBe(false)
  })
})

describe('request validation', () => {
  it('accepts a well-formed settings patch', () => {
    const result = getContract(IpcChannel.SettingsUpdate).request.safeParse({
      patch: { theme: 'dark', logRetentionDays: 30 },
    })

    expect(result.success).toBe(true)
  })

  it('rejects a settings value outside its allowed set', () => {
    const result = getContract(IpcChannel.SettingsUpdate).request.safeParse({
      patch: { theme: 'neon' },
    })

    expect(result.success).toBe(false)
  })

  it('rejects a log retention outside the supported range', () => {
    const contract = getContract(IpcChannel.SettingsUpdate).request

    expect(contract.safeParse({ patch: { logRetentionDays: 0 } }).success).toBe(false)
    expect(contract.safeParse({ patch: { logRetentionDays: 1000 } }).success).toBe(false)
    expect(contract.safeParse({ patch: { logRetentionDays: 2.5 } }).success).toBe(false)
  })

  it('bounds the log query so a hostile renderer cannot request unbounded work', () => {
    const contract = getContract(IpcChannel.LogsQuery).request

    expect(contract.safeParse({ limit: 100, offset: 0 }).success).toBe(true)
    expect(contract.safeParse({ limit: 100_000, offset: 0 }).success).toBe(false)
    expect(contract.safeParse({ limit: 0, offset: 0 }).success).toBe(false)
    expect(contract.safeParse({ limit: 100, offset: -1 }).success).toBe(false)
  })

  it('bounds an external URL so a megabyte cannot be sent', () => {
    const contract = getContract(IpcChannel.AppOpenExternal).request

    expect(contract.safeParse({ url: 'https://recoverx.snapkio.com/' }).success).toBe(true)
    expect(contract.safeParse({ url: '' }).success).toBe(false)
    expect(contract.safeParse({ url: 'x'.repeat(4096) }).success).toBe(false)
  })

  it('bounds a forwarded renderer log record', () => {
    const contract = getContract(IpcChannel.LogsWrite).request

    expect(
      contract.safeParse({ level: 'info', scope: 'ui', message: 'hello', meta: null }).success,
    ).toBe(true)
    expect(
      contract.safeParse({ level: 'trace', scope: 'ui', message: 'hello', meta: null }).success,
    ).toBe(false)
    expect(
      contract.safeParse({ level: 'info', scope: '', message: 'hello', meta: null }).success,
    ).toBe(false)
  })

  it('accepts an omitted payload on no-argument channels', () => {
    expect(getContract(IpcChannel.AppGetInfo).request.safeParse(undefined).success).toBe(true)
    expect(getContract(IpcChannel.WindowMinimize).request.safeParse(undefined).success).toBe(true)
  })
})

describe('response validation', () => {
  it('says explicitly whether a renewal check found a renewal', () => {
    const contract = getContract(IpcChannel.LicenseCheckRenewal)
    const status = {
      state: 'active',
      edition: 'professional',
      maskedKey: 'RECX-•••••-•••••-•••••-STVWX',
      activatedAt: 1,
      expiresAt: 2,
      machineId: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX',
      registeredTo: null,
      recoveryLimitBytes: null,
      recoveredBytes: 0,
      remainingBytes: null,
    }

    expect(contract.request.safeParse(undefined).success).toBe(true)
    expect(contract.response.safeParse({ renewed: true, status }).success).toBe(true)
    expect(contract.response.safeParse({ status }).success).toBe(false)
    expect(contract.response.safeParse({ renewed: false }).success).toBe(false)
  })

  it('rejects a window state that is missing a field', () => {
    const contract = getContract(IpcChannel.WindowGetState).response

    expect(
      contract.safeParse({
        isMaximized: false,
        isMinimized: false,
        isFullScreen: false,
        isFocused: true,
      }).success,
    ).toBe(true)

    expect(contract.safeParse({ isMaximized: false }).success).toBe(false)
  })
})
