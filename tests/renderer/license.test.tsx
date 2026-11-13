import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PURCHASE_URL } from '@shared/constants/app'
import { IpcChannel } from '@shared/ipc/channels'
import type { LicenseStatus } from '@shared/types/license'
import { emptySelection, type Selection } from '@shared/types/scan'
import { ErrorCode, type SerializedError } from '@shared/utils/errors'
import type { Result } from '@shared/utils/result'
import { LicensePage } from '@/features/license/LicensePage'
import { readFreeLimitRefusal } from '@/features/license/purchase'
import { RecoveryDialog } from '@/features/recovery/RecoveryDialog'
import { initializeI18n } from '@/i18n'
import { useUiStore } from '@/stores/ui.store'

/**
 * The way from Free to paid.
 *
 * What matters is that every place a user meets the limit hands them the
 * purchase page through the allowlisted IPC channel — never a raw link — and
 * that the edition refusal reads as numbers and choices rather than JSON.
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

const GIB = 1024 * 1024 * 1024

const ok = <T,>(data: T): Result<T> => ({ ok: true, data })
const fail = (error: SerializedError): Result<never> => ({ ok: false, error })

/** Answer each channel from a table; anything unlisted fails loudly. */
function answer(routes: Partial<Record<string, Result<unknown>>>): void {
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(
      routes[channel] ??
        fail({ code: ErrorCode.Unknown, message: `unexpected ${channel}`, retryable: false }),
    ),
  )
}

function licence(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    state: 'unlicensed',
    edition: 'free',
    maskedKey: null,
    activatedAt: null,
    expiresAt: null,
    machineId: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX',
    registeredTo: null,
    recoveryLimitBytes: GIB,
    recoveredBytes: 0,
    remainingBytes: GIB,
    ...overrides,
  }
}

/** The refusal exactly as `LicenseService.assertRecoveryAllowed` raises it. */
function freeLimitError(remainingBytes: number): SerializedError {
  return {
    code: ErrorCode.Unsupported,
    message: 'This recovery is larger than the Free edition allows',
    details: JSON.stringify({
      limitBytes: GIB,
      usedBytes: GIB - remainingBytes,
      remainingBytes,
      requestedBytes: 2 * GIB,
    }),
    retryable: false,
  }
}

beforeAll(() => {
  initializeI18n('en')
})

beforeEach(() => {
  invoke.mockReset()
  useUiStore.setState({ toasts: [], confirmRequest: null })
})

/** Answer the confirmation dialog the way the user would, once it is open. */
async function confirmWith(title: string, confirmed: boolean): Promise<void> {
  await waitFor(() => {
    expect(useUiStore.getState().confirmRequest?.title).toBe(title)
  })
  act(() => {
    useUiStore.getState().resolveConfirm(confirmed)
  })
}

const toastTitles = (): string[] => useUiStore.getState().toasts.map((toast) => toast.title)

describe('the Licence screen', () => {
  it('offers a Free user a way to buy, through the allowlisted channel', async () => {
    answer({
      [IpcChannel.LicenseGetStatus]: ok(licence()),
      [IpcChannel.AppOpenExternal]: ok(undefined),
    })
    render(<LicensePage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Buy a licence' }))

    expect(invoke).toHaveBeenCalledWith(IpcChannel.AppOpenExternal, { url: PURCHASE_URL })
  })

  it('lets a key be typed from a receipt, prefix and all, and erased again', async () => {
    answer({ [IpcChannel.LicenseGetStatus]: ok(licence()) })
    render(<LicensePage />)
    const field = await screen.findByLabelText('Licence key')

    await userEvent.type(field, 'RE')
    expect(field).toHaveValue('RE')
    // Unfinished, not another product's.
    expect(screen.queryByText('That key is for a different product.')).not.toBeInTheDocument()
    expect(screen.getByText('A licence key has 20 characters after RECX.')).toBeInTheDocument()

    await userEvent.type(field, 'cx-abcdefg')
    expect(field).toHaveValue('RECX-ABCDE-FG')

    await userEvent.type(field, '{Backspace}'.repeat(12))
    expect(field).toHaveValue('')
  })

  it('calls it a renewal when the licence has expired', async () => {
    answer({ [IpcChannel.LicenseGetStatus]: ok(licence({ state: 'expired' })) })
    render(<LicensePage />)

    expect(await screen.findByRole('button', { name: 'Renew licence' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Buy a licence' })).not.toBeInTheDocument()
  })

  it('offers nothing to buy once a licence is active', async () => {
    answer({
      [IpcChannel.LicenseGetStatus]: ok(
        licence({
          state: 'active',
          edition: 'professional',
          recoveryLimitBytes: null,
          remainingBytes: null,
        }),
      ),
    })
    render(<LicensePage />)

    expect(await screen.findByRole('button', { name: /remove from this computer/iu })).toBeVisible()
    expect(screen.queryByRole('button', { name: /buy|renew/iu })).not.toBeInTheDocument()
  })

  it('removes an active licence after asking first', async () => {
    answer({
      [IpcChannel.LicenseGetStatus]: ok(
        licence({ state: 'active', edition: 'professional', maskedKey: '•••••-STVWX' }),
      ),
      [IpcChannel.LicenseDeactivate]: ok(licence()),
    })
    render(<LicensePage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Remove from this computer' }))
    await confirmWith('Remove this licence?', true)

    await waitFor(() => {
      expect(toastTitles()).toContain('Licence removed from this computer.')
    })
    expect(invoke).toHaveBeenCalledWith(IpcChannel.LicenseDeactivate, undefined)
    expect(await screen.findByRole('button', { name: 'Buy a licence' })).toBeInTheDocument()
  })

  // A stored licence that no longer verifies still holds a seat on the server.
  // Releasing it here is the customer's only way to get it back without
  // support — after renaming the computer, say, which reads as another one.
  it.each(['machine-mismatch', 'expired', 'invalid', 'unverifiable'] as const)(
    'lets a %s licence release its seat',
    async (state) => {
      answer({
        [IpcChannel.LicenseGetStatus]: ok(licence({ state, maskedKey: '•••••-STVWX' })),
        [IpcChannel.LicenseDeactivate]: ok(licence()),
      })
      render(<LicensePage />)

      await userEvent.click(await screen.findByRole('button', { name: 'Release this activation' }))
      await confirmWith('Release this activation?', true)

      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(IpcChannel.LicenseDeactivate, undefined)
      })
      await waitFor(() => {
        expect(toastTitles()).toContain('Activation removed from this computer.')
      })
      expect(
        screen.queryByRole('button', { name: 'Release this activation' }),
      ).not.toBeInTheDocument()
    },
  )

  it('keeps the licence on screen when the server will not move it again', async () => {
    // The licence server's sentence for its cap on self-service moves; the
    // licence stays active here, and the customer is told so in its words.
    const kept =
      'This licence has already been moved between computers 4 times in the last 12 months. It is still active on this computer. To move it again, contact info@appsgain.in with your licence key.'
    answer({
      [IpcChannel.LicenseGetStatus]: ok(
        licence({ state: 'active', edition: 'professional', maskedKey: '•••••-STVWX' }),
      ),
      [IpcChannel.LicenseDeactivate]: fail({
        code: ErrorCode.Validation,
        message: kept,
        retryable: false,
      }),
    })
    render(<LicensePage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Remove from this computer' }))
    await confirmWith('Remove this licence?', true)

    await waitFor(() => {
      expect(useUiStore.getState().toasts).toContainEqual(
        expect.objectContaining({ tone: 'error', title: kept }),
      )
    })
    expect(toastTitles()).not.toContain('Licence removed from this computer.')
    expect(screen.getByRole('button', { name: 'Remove from this computer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Buy a licence' })).not.toBeInTheDocument()
  })

  describe('checking for a renewal', () => {
    const expired = licence({
      state: 'expired',
      edition: 'free',
      maskedKey: '•••••-STVWX',
      expiresAt: 1_700_000_000_000,
    })

    it('promises start-up checks only for as long as start-up makes them', async () => {
      // Shown on every expired licence, however long ago it ended; start-up
      // stops asking 30 days after the end date (RENEWAL_GRACE_MS).
      answer({ [IpcChannel.LicenseGetStatus]: ok(expired) })
      render(<LicensePage />)

      expect(
        await screen.findByText(/looks for a renewal when it starts, until 30 days after the end/u),
      ).toBeVisible()
      expect(screen.queryByText(/each time it starts/u)).not.toBeInTheDocument()
    })

    it('picks up a renewal and says so', async () => {
      answer({
        [IpcChannel.LicenseGetStatus]: ok(expired),
        [IpcChannel.LicenseCheckRenewal]: ok({
          renewed: true,
          status: licence({
            state: 'active',
            edition: 'professional',
            maskedKey: '•••••-STVWX',
            expiresAt: 1_800_000_000_000,
            recoveryLimitBytes: null,
            remainingBytes: null,
          }),
        }),
      })
      render(<LicensePage />)

      await userEvent.click(await screen.findByRole('button', { name: 'Check for renewal' }))

      await waitFor(() => {
        expect(toastTitles()).toContain(
          'Renewal applied. You are running the Professional edition.',
        )
      })
      expect(invoke).toHaveBeenCalledWith(IpcChannel.LicenseCheckRenewal, undefined)
      expect(screen.queryByRole('button', { name: 'Renew licence' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Check for renewal' })).not.toBeInTheDocument()
    })

    it('says plainly when there is nothing newer yet', async () => {
      answer({
        [IpcChannel.LicenseGetStatus]: ok(expired),
        [IpcChannel.LicenseCheckRenewal]: ok({ renewed: false, status: expired }),
      })
      render(<LicensePage />)

      await userEvent.click(await screen.findByRole('button', { name: 'Check for renewal' }))

      await waitFor(() => {
        expect(useUiStore.getState().toasts).toContainEqual(
          expect.objectContaining({
            tone: 'info',
            title: 'No renewal has been recorded for this licence yet.',
          }),
        )
      })
      expect(screen.getByRole('button', { name: 'Renew licence' })).toBeInTheDocument()
    })

    it('passes on why the check failed', async () => {
      answer({
        [IpcChannel.LicenseGetStatus]: ok(expired),
        [IpcChannel.LicenseCheckRenewal]: fail({
          code: ErrorCode.Io,
          message: 'The activation service could not be reached',
          retryable: true,
        }),
      })
      render(<LicensePage />)

      await userEvent.click(await screen.findByRole('button', { name: 'Check for renewal' }))

      await waitFor(() => {
        expect(toastTitles()).toContain('The activation service could not be reached')
      })
      expect(screen.getByRole('button', { name: 'Check for renewal' })).toBeInTheDocument()
    })

    // Only an expired licence with its key still here can be renewed in place;
    // anything else needs a purchase or a fresh activation.
    it.each([
      ['an expired licence with no key stored', licence({ state: 'expired' })],
      ['a licence for another computer', licence({ state: 'machine-mismatch', maskedKey: 'x' })],
      ['no licence at all', licence()],
    ])('is not offered for %s', async (_label, status) => {
      answer({ [IpcChannel.LicenseGetStatus]: ok(status) })
      render(<LicensePage />)

      expect(await screen.findByRole('button', { name: /buy|renew/iu })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Check for renewal' })).not.toBeInTheDocument()
    })
  })

  it('releases nothing when the user thinks better of it', async () => {
    answer({
      [IpcChannel.LicenseGetStatus]: ok(
        licence({ state: 'machine-mismatch', maskedKey: '•••••-STVWX' }),
      ),
    })
    render(<LicensePage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Release this activation' }))
    await confirmWith('Release this activation?', false)

    expect(invoke).not.toHaveBeenCalledWith(IpcChannel.LicenseDeactivate, undefined)
    expect(screen.getByRole('button', { name: 'Release this activation' })).toBeInTheDocument()
  })

  it('offers nothing to release when no licence is stored', async () => {
    answer({ [IpcChannel.LicenseGetStatus]: ok(licence()) })
    render(<LicensePage />)

    expect(await screen.findByRole('button', { name: 'Buy a licence' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /release|remove/iu })).not.toBeInTheDocument()
  })

  it('says so when the purchase page cannot be opened', async () => {
    answer({
      [IpcChannel.LicenseGetStatus]: ok(licence()),
      [IpcChannel.AppOpenExternal]: fail({
        code: ErrorCode.PermissionDenied,
        message: 'That link was blocked',
        retryable: false,
      }),
    })
    render(<LicensePage />)

    await userEvent.click(await screen.findByRole('button', { name: 'Buy a licence' }))

    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((toast) => toast.title)).toContain(
        'That link was blocked',
      )
    })
  })
})

describe('the Free-edition refusal', () => {
  it('is recognised by its figures', () => {
    expect(readFreeLimitRefusal(freeLimitError(GIB / 4))).toEqual({
      limitBytes: GIB,
      usedBytes: GIB - GIB / 4,
      remainingBytes: GIB / 4,
      requestedBytes: 2 * GIB,
    })
  })

  it('is not confused with another unsupported operation', () => {
    // A real error of the same code whose details are prose, not figures.
    const offlineOnly: SerializedError = {
      code: ErrorCode.Unsupported,
      message: 'Online activation is not available',
      details: 'This build has no activation service configured. Use offline activation.',
      retryable: false,
    }

    expect(readFreeLimitRefusal(offlineOnly)).toBeNull()
    expect(readFreeLimitRefusal({ ...offlineOnly, details: undefined })).toBeNull()
  })

  it('is not recognised under any other error code', () => {
    expect(readFreeLimitRefusal({ ...freeLimitError(0), code: ErrorCode.Validation })).toBeNull()
  })
})

describe('the recovery dialog at the Free limit', () => {
  const selection: Selection = emptySelection({
    sessionId: 'session-1',
    sortBy: 'name',
    sortDirection: 'asc',
    limit: 100,
    offset: 0,
  })

  function renderDialog(remainingBytes: number) {
    answer({
      [IpcChannel.RecoveryCheckDestination]: ok({
        path: 'E:\\Recovered',
        isUsable: true,
        problem: null,
        message: '',
        freeBytes: 100 * GIB,
        totalBytes: 500 * GIB,
      }),
      [IpcChannel.RecoveryStart]: fail(freeLimitError(remainingBytes)),
      [IpcChannel.AppOpenExternal]: ok(undefined),
    })

    render(
      <MemoryRouter initialEntries={['/scan']}>
        <Routes>
          <Route
            path="/scan"
            element={
              <RecoveryDialog
                selection={selection}
                summary={{ count: 12, totalSizeBytes: 2 * GIB }}
                onStarted={vi.fn()}
                onClose={vi.fn()}
              />
            }
          />
          <Route path="/license" element={<p>Licence screen</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  async function startRecovery(): Promise<void> {
    await userEvent.type(screen.getByLabelText('Save recovered files to'), 'E:\\Recovered')
    const start = screen.getByRole('button', { name: 'Start recovery' })
    await waitFor(() => {
      expect(start).toBeEnabled()
    })
    await userEvent.click(start)
  }

  it('explains the limit in the dialog and offers to buy', async () => {
    renderDialog(GIB / 4)
    await startRecovery()

    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent('This recovery is larger than the Free edition allows')
    expect(notice).toHaveTextContent(/Select fewer files/u)
    // The figures replace the raw JSON a toast would have shown.
    expect(notice).not.toHaveTextContent('remainingBytes')
    expect(useUiStore.getState().toasts).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Buy a licence' }))
    expect(invoke).toHaveBeenCalledWith(IpcChannel.AppOpenExternal, { url: PURCHASE_URL })
  })

  it('says the allowance is used up when nothing is left', async () => {
    renderDialog(0)
    await startRecovery()

    expect(await screen.findByRole('alert')).toHaveTextContent(/allowance is used up/u)
  })

  it('leads to the Licence screen to enter a key', async () => {
    renderDialog(GIB / 4)
    await startRecovery()

    await userEvent.click(await screen.findByRole('button', { name: 'Enter a licence key' }))

    expect(await screen.findByText('Licence screen')).toBeInTheDocument()
  })
})
