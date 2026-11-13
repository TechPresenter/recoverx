import { render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/types/settings'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { initializeI18n } from '@/i18n'
import { useSettingsStore } from '@/stores/settings.store'

/**
 * What the Settings screen promises.
 *
 * Every switch on it is a statement about what the application does, and the
 * privacy policy repeats those statements. A switch that controls nothing is
 * therefore not harmless clutter: it tells the user something untrue in
 * whichever position they leave it.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@/lib/ipc-client', () => ({
  invoke,
  subscribe: vi.fn(() => () => undefined),
  isBridgeAvailable: () => true,
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

beforeAll(() => {
  initializeI18n('en')
})

beforeEach(() => {
  // The recovery-destination field validates its path on mount; its answer is
  // irrelevant here.
  invoke.mockImplementation(() => new Promise(() => undefined))
  useSettingsStore.setState({
    settings: createDefaultSettings('D:\\Recovered'),
    status: 'ready',
    error: null,
    pendingRestartKeys: [],
    savingKeys: [],
  })
})

describe('the Settings screen', () => {
  it('offers no switch for sharing diagnostics, because nothing is ever sent', () => {
    render(<SettingsPage />)

    expect(screen.queryByRole('switch', { name: /diagnostic|telemetry/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/crash reports|usage counts/i)).not.toBeInTheDocument()
  })

  it('says what the automatic update check does, and that downloading stays a choice', () => {
    render(<SettingsPage />)

    const automatic = screen.getByRole('switch', { name: 'Check for updates automatically' })

    expect(automatic).toBeChecked()
    expect(automatic).toHaveAccessibleDescription(
      'Checks once, shortly after start-up. Updates are downloaded and installed only when you choose.',
    )
  })
})
