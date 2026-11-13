import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BadgeCheck, Copy, KeyRound, RefreshCw, ShieldOff, ShoppingCart } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { LicenseEdition, LicenseState, LicenseStatus } from '@shared/types/license'
import {
  formatKeyAsTyped,
  isPartialKeyPrefix,
  validateKey,
  type KeyProblem,
} from '@shared/utils/license-key'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Skeleton } from '@/components/ui/Skeleton'
import { DefinitionRow } from '@/components/ui/StatTile'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke } from '@/lib/ipc-client'
import { toast, useUiStore } from '@/stores/ui.store'
import { PURCHASE_SITE, openPurchasePage } from './purchase'

/**
 * Activation.
 *
 * Three things are load-bearing here beyond the obvious.
 *
 * The key is validated as it is typed, locally. A customer who transposed two
 * characters learns so immediately rather than after a network round trip that
 * reads as "your purchase was rejected" — which is the version of this screen
 * that generates support mail.
 *
 * Offline activation is presented as an equal, not a fallback. The machines
 * that most need it are exactly the ones a technician has been called out to:
 * no network, someone else's broken computer, data that matters.
 *
 * Every state short of active offers a way to buy. The Free user is the one
 * most likely to want a licence, and this is the screen they open to find out
 * what they have — sending them off to search for a shop instead is how a
 * sale becomes a closed tab.
 */
type Method = 'online' | 'offline'

export function LicensePage() {
  const { t } = useTranslation()
  const format = useFormatters()

  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [method, setMethod] = useState<Method>('online')
  const [key, setKey] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const requestConfirm = useUiStore((state) => state.requestConfirm)

  const load = useCallback(async (): Promise<void> => {
    const response = await invoke(IpcChannel.LicenseGetStatus, undefined)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    setStatus(response.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const activate = useCallback(async (): Promise<void> => {
    setBusy(true)
    const response =
      method === 'online'
        ? await invoke(IpcChannel.LicenseActivate, { key })
        : await invoke(IpcChannel.LicenseActivateOffline, { token })
    setBusy(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    setStatus(response.data)
    setKey('')
    setToken('')
    toast.success(t('license.activated', { edition: editionLabel(response.data.edition, t) }))
  }, [method, key, token, t])

  /**
   * Remove the stored activation and release its seat.
   *
   * Offered for any stored licence, not only a working one. An expired licence,
   * or one that reads as a different computer after this one was renamed, still
   * holds a seat on the server, and this is the only thing that can give it
   * back without a support ticket. Only the wording changes: removing a
   * licence that is not unlocking anything is releasing it, not giving it up.
   *
   * A licence can only be moved between computers so many times a year
   * without support. When the server declines for that reason the licence
   * stays exactly where it is, and the error toast carries the server's own
   * sentence — how many moves were used, whom to contact — with the screen
   * left showing the licence that is still active.
   */
  const deactivate = useCallback(
    async (active: boolean): Promise<void> => {
      const confirmed = await requestConfirm({
        title: active ? t('license.deactivateConfirmTitle') : t('license.releaseConfirmTitle'),
        description: active ? t('license.deactivateConfirmBody') : t('license.releaseConfirmBody'),
        confirmLabel: active ? t('license.deactivate') : t('license.release'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })

      if (!confirmed) return

      setBusy(true)
      const response = await invoke(IpcChannel.LicenseDeactivate, undefined)
      setBusy(false)

      if (!response.ok) {
        toast.error(response.error.message, response.error.details)
        return
      }

      setStatus(response.data)
      toast.success(active ? t('license.removed') : t('license.released'))
    },
    [requestConfirm, t],
  )

  /**
   * Ask the licence server whether an expired licence has been renewed.
   *
   * Start-up asks on its own. This is for the customer who has just paid in
   * the browser and is looking at this screen now: making them restart the
   * application to see the renewal would read as the payment not having
   * worked. "Nothing yet" is information rather than an error — renewals can
   * take a few minutes to be recorded — so it is said as such.
   */
  const checkRenewal = useCallback(async (): Promise<void> => {
    setBusy(true)
    const response = await invoke(IpcChannel.LicenseCheckRenewal, undefined)
    setBusy(false)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    setStatus(response.data.status)

    if (response.data.renewed) {
      toast.success(
        t('license.renewalApplied', { edition: editionLabel(response.data.status.edition, t) }),
      )
    } else {
      toast.info(t('license.renewalNotFound'), t('license.renewalNotFoundHint'))
    }
  }, [t])

  const copyMachineId = useCallback(async (): Promise<void> => {
    if (status === null) return

    await navigator.clipboard.writeText(status.machineId)
    toast.success(t('license.machineIdCopied'))
  }, [status, t])

  if (status === null) return <Skeleton className="h-72 w-full" />

  const validation = validateKey(key)
  const canActivate = method === 'online' ? validation.ok : token.trim().length > 0
  const active = status.state === 'active'
  // A renewal extends the licence stored here, so there has to be one, and it
  // has to be the expired kind: any other failing licence needs activating
  // again, not renewing.
  const renewable = status.state === 'expired' && status.maskedKey !== null

  return (
    <div className="space-y-6">
      <PageHeader title={t('license.title')} description={t('license.subtitle')} />

      <Card>
        <CardHeader
          title={editionLabel(status.edition, t)}
          description={stateDescription(status.state, t)}
          icon={
            status.state === 'active' ? (
              <BadgeCheck size={16} aria-hidden />
            ) : (
              <KeyRound size={16} aria-hidden />
            )
          }
          actions={<Badge tone={stateTone(status.state)}>{stateLabel(status.state, t)}</Badge>}
        />

        {/* The Free ceiling is shown as consumption, not as a warning. It is a
            limit the user agreed to, and the useful question is how much is
            left — not whether they are doing something wrong. */}
        {status.recoveryLimitBytes !== null && (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] text-ink-muted">{t('license.allowance')}</span>
              <span className="text-[12.5px] font-medium tabular-nums text-ink">
                {t('license.allowanceUsed', {
                  used: format.bytes(status.recoveredBytes),
                  total: format.bytes(status.recoveryLimitBytes),
                })}
              </span>
            </div>
            <ProgressBar
              className="mt-2"
              thresholds
              ariaLabel={t('license.allowance')}
              value={(status.recoveredBytes / status.recoveryLimitBytes) * 100}
            />
            <p className="mt-2 text-[12px] text-ink-muted">
              {status.remainingBytes === 0
                ? t('license.allowanceSpent')
                : t('license.allowanceLeft', { size: format.bytes(status.remainingBytes ?? 0) })}
            </p>
          </div>
        )}

        <div className="mt-5 space-y-1 border-t border-line pt-4">
          {status.maskedKey !== null && (
            <DefinitionRow term={t('license.key')} selectable>
              {status.maskedKey}
            </DefinitionRow>
          )}
          {status.registeredTo !== null && (
            <DefinitionRow term={t('license.registeredTo')}>{status.registeredTo}</DefinitionRow>
          )}
          {status.activatedAt !== null && (
            <DefinitionRow term={t('license.activatedOn')}>
              {format.timestamp(status.activatedAt)}
            </DefinitionRow>
          )}
          <DefinitionRow term={t('license.expires')}>
            {status.expiresAt === null
              ? t('license.perpetual')
              : format.timestamp(status.expiresAt)}
          </DefinitionRow>
          <DefinitionRow term={t('license.machineId')} selectable>
            <span className="flex items-center gap-2">
              <span className="font-mono text-[12px]">{status.machineId}</span>
              <button
                type="button"
                onClick={() => {
                  void copyMachineId()
                }}
                aria-label={t('license.copyMachineId')}
                className="text-ink-subtle transition-colors hover:text-ink"
              >
                <Copy size={13} aria-hidden />
              </button>
            </span>
          </DefinitionRow>
        </div>

        {(active || status.maskedKey !== null) && (
          <div className="mt-4 border-t border-line pt-4">
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              iconLeft={<ShieldOff size={14} />}
              onClick={() => {
                void deactivate(active)
              }}
            >
              {active ? t('license.deactivate') : t('license.release')}
            </Button>
            <p className="mt-2 text-[12px] text-ink-muted">
              {active ? t('license.deactivateHint') : t('license.releaseHint')}
            </p>
          </div>
        )}

        {/* An expired licence is a renewal, not a first purchase, and calling
            it one tells a returning customer the product has forgotten them. */}
        {status.state !== 'active' && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                iconLeft={<ShoppingCart size={14} />}
                onClick={() => {
                  void openPurchasePage()
                }}
              >
                {status.state === 'expired' ? t('license.renew') : t('license.buy')}
              </Button>
              {renewable && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  iconLeft={<RefreshCw size={14} />}
                  onClick={() => {
                    void checkRenewal()
                  }}
                >
                  {t('license.checkRenewal')}
                </Button>
              )}
            </div>
            <p className="mt-2 text-[12px] text-ink-muted">
              {t('license.buyHint', { site: PURCHASE_SITE })}
            </p>
            {renewable && (
              <p className="mt-1 text-[12px] text-ink-muted">{t('license.checkRenewalHint')}</p>
            )}
          </div>
        )}
      </Card>

      {status.state !== 'active' && (
        <Card>
          <CardHeader title={t('license.activate')} description={t('license.activateHint')} />

          <SegmentedControl
            className="mt-4"
            size="sm"
            value={method}
            ariaLabel={t('license.method')}
            onValueChange={setMethod}
            segments={[
              { value: 'online', label: t('license.online') },
              { value: 'offline', label: t('license.offline') },
            ]}
          />

          {method === 'online' ? (
            <div className="mt-4 space-y-2">
              <Input
                label={t('license.key')}
                value={key}
                spellCheck={false}
                autoComplete="off"
                placeholder="RECX-XXXXX-XXXXX-XXXXX-XXXXX"
                onChange={(event) => {
                  setKey(formatKeyAsTyped(event.target.value))
                }}
                {...(key.length > 0 && !validation.ok
                  ? {
                      // "RE" on the way to the prefix is a key not finished
                      // yet, not a key for another product.
                      error: keyProblem(
                        isPartialKeyPrefix(key) ? 'wrong-length' : validation.problem,
                        t,
                      ),
                    }
                  : {})}
              />
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                {t('license.offlineHint')}
              </p>
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-medium text-ink">
                  {t('license.token')}
                </span>
                <textarea
                  value={token}
                  spellCheck={false}
                  rows={4}
                  onChange={(event) => {
                    setToken(event.target.value)
                  }}
                  className="w-full rounded-lg border border-line bg-surface-2 p-2.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
                />
              </label>
            </div>
          )}

          <Button
            className="mt-4"
            loading={busy}
            disabled={!canActivate}
            iconLeft={<KeyRound size={14} />}
            onClick={() => {
              void activate()
            }}
          >
            {t('license.activateAction')}
          </Button>
        </Card>
      )}
    </div>
  )
}

// --- labels ----------------------------------------------------------------

type Translate = ReturnType<typeof useTranslation>['t']

function editionLabel(edition: LicenseEdition, t: Translate): string {
  switch (edition) {
    case 'free':
      return t('license.edition.free')
    case 'professional':
      return t('license.edition.professional')
    case 'business':
      return t('license.edition.business')
    case 'technician':
      return t('license.edition.technician')
    case 'enterprise':
      return t('license.edition.enterprise')
  }
}

function stateLabel(state: LicenseState, t: Translate): string {
  switch (state) {
    case 'active':
      return t('license.state.active')
    case 'unlicensed':
      return t('license.state.unlicensed')
    case 'expired':
      return t('license.state.expired')
    case 'machine-mismatch':
      return t('license.state.machineMismatch')
    case 'invalid':
      return t('license.state.invalid')
    case 'unverifiable':
      return t('license.state.unverifiable')
  }
}

function stateDescription(state: LicenseState, t: Translate): string {
  switch (state) {
    case 'active':
      return t('license.stateBody.active')
    case 'unlicensed':
      return t('license.stateBody.unlicensed')
    case 'expired':
      return t('license.stateBody.expired')
    case 'machine-mismatch':
      return t('license.stateBody.machineMismatch')
    case 'invalid':
      return t('license.stateBody.invalid')
    case 'unverifiable':
      return t('license.stateBody.unverifiable')
  }
}

function stateTone(state: LicenseState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'active':
      return 'success'
    case 'unlicensed':
      return 'neutral'
    case 'expired':
    case 'machine-mismatch':
      return 'warning'
    case 'invalid':
    case 'unverifiable':
      return 'danger'
  }
}

function keyProblem(problem: KeyProblem | null, t: Translate): string {
  switch (problem) {
    case null:
    case 'empty':
      return t('license.problem.generic')
    case 'wrong-product':
      return t('license.problem.wrongProduct')
    case 'wrong-length':
      return t('license.problem.wrongLength')
    case 'bad-character':
      return t('license.problem.badCharacter')
    case 'checksum':
      return t('license.problem.checksum')
  }
}
