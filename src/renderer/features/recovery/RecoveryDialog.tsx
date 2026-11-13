import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { CircleAlert, FolderOpen, KeyRound, ShieldCheck, ShoppingCart } from 'lucide-react'
import { AppRoute } from '@shared/constants/routes'
import { IpcChannel } from '@shared/ipc/channels'
import {
  defaultRecoveryOptions,
  type RecoveryJob,
  type RecoveryOptions,
} from '@shared/types/recovery'
import type { Selection, SelectionSummary } from '@shared/types/scan'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import {
  openPurchasePage,
  readFreeLimitRefusal,
  type FreeLimitRefusal,
} from '@/features/license/purchase'
import { useFormatters } from '@/hooks/useFormatters'
import { useSettingsStore } from '@/stores/settings.store'
import { cn } from '@/lib/cn'
import { invoke } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'

/**
 * Recovery setup.
 *
 * The destination is checked as it changes, not when the user presses Start.
 * The check that matters — refusing the device being recovered from — is the
 * one a user is most likely to trip, and telling them after they commit would
 * be too late to be useful.
 */

export interface RecoveryDialogProps {
  readonly selection: Selection
  readonly summary: SelectionSummary
  readonly onStarted: (job: RecoveryJob) => void
  readonly onClose: () => void
}

interface DestinationState {
  readonly isUsable: boolean
  readonly message: string
  readonly problem: string | null
  readonly freeBytes: number
}

export function RecoveryDialog({ selection, summary, onStarted, onClose }: RecoveryDialogProps) {
  const { t } = useTranslation()
  const format = useFormatters()
  const defaultPath = useSettingsStore((state) => state.settings?.defaultRecoveryPath ?? '')

  const [options, setOptions] = useState<RecoveryOptions>(() => defaultRecoveryOptions(defaultPath))
  const [destinationState, setDestinationState] = useState<DestinationState | null>(null)
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [limitRefusal, setLimitRefusal] = useState<FreeLimitRefusal | null>(null)

  const check = useCallback(
    async (destination: string): Promise<void> => {
      if (destination.trim().length === 0) {
        setDestinationState(null)
        return
      }

      setChecking(true)
      const response = await invoke(IpcChannel.RecoveryCheckDestination, { selection, destination })
      setChecking(false)

      if (!response.ok) {
        setDestinationState({
          isUsable: false,
          message: response.error.message,
          problem: 'error',
          freeBytes: 0,
        })
        return
      }

      setDestinationState(response.data)
    },
    [selection],
  )

  useEffect(() => {
    void check(options.destination)
  }, [check, options.destination])

  const browse = useCallback(async (): Promise<void> => {
    const response = await invoke(IpcChannel.AppPickDirectory, {
      title: t('recovery.pickTitle'),
      ...(options.destination.length > 0 ? { defaultPath: options.destination } : {}),
    })

    if (response.ok && response.data.path !== null) {
      setOptions((current) => ({ ...current, destination: response.data.path! }))
    }
  }, [options.destination, t])

  const start = useCallback(async (): Promise<void> => {
    setStarting(true)
    setLimitRefusal(null)
    const response = await invoke(IpcChannel.RecoveryStart, { selection, options })
    setStarting(false)

    if (!response.ok) {
      // The edition limit gets a notice in the dialog rather than a toast: it
      // needs the numbers and a way forward, and a toast fades before either
      // can be read, let alone acted on.
      const refusal = readFreeLimitRefusal(response.error)

      if (refusal !== null) {
        setLimitRefusal(refusal)
        return
      }

      toast.error(response.error.message, response.error.details)
      return
    }

    onStarted(response.data)
  }, [selection, options, onStarted])

  const canStart = destinationState?.isUsable === true && !checking && !starting

  return (
    <div className="space-y-4 rounded-card border border-line bg-surface p-5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{t('recovery.title')}</h2>
        <p className="text-numeric mt-1 text-[12.5px] text-ink-muted">
          {t('recovery.subtitle', {
            count: summary.count,
            size: format.bytes(summary.totalSizeBytes),
          })}
        </p>
      </div>

      <div>
        <label
          htmlFor="recovery-destination"
          className="mb-1.5 block text-[12px] font-medium text-ink"
        >
          {t('recovery.destination')}
        </label>
        <div className="flex gap-2">
          <Input
            id="recovery-destination"
            value={options.destination}
            onChange={(event) => {
              setOptions((current) => ({ ...current, destination: event.target.value }))
            }}
            placeholder={t('recovery.destinationPlaceholder')}
            aria-invalid={destinationState !== null && !destinationState.isUsable}
            className="flex-1"
          />
          <Button
            variant="secondary"
            iconLeft={<FolderOpen size={14} />}
            onClick={() => void browse()}
          >
            {t('common.browse')}
          </Button>
        </div>

        {destinationState !== null && (
          <DestinationNotice
            state={destinationState}
            freeLabel={format.bytes(destinationState.freeBytes)}
          />
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-4">
        <Switch
          checked={options.restoreFolderStructure}
          onCheckedChange={(value) => {
            setOptions((current) => ({ ...current, restoreFolderStructure: value }))
          }}
          label={t('recovery.restoreStructure')}
          description={t('recovery.restoreStructureHint')}
        />
        <Switch
          checked={options.groupByCategory}
          onCheckedChange={(value) => {
            setOptions((current) => ({ ...current, groupByCategory: value }))
          }}
          label={t('recovery.groupByCategory')}
          description={t('recovery.groupByCategoryHint')}
        />
      </div>

      {limitRefusal !== null && <FreeLimitNotice refusal={limitRefusal} />}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button loading={starting} disabled={!canStart} onClick={() => void start()}>
          {t('recovery.start')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The destination verdict.
 *
 * A refusal explains *why* — "writing there would overwrite the files still
 * waiting to be recovered" — because a user who does not understand the reason
 * will look for a way around it.
 */
function DestinationNotice({ state, freeLabel }: { state: DestinationState; freeLabel: string }) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        'mt-2 flex items-start gap-2.5 rounded-lg border p-3 text-[12.5px]',
        state.isUsable
          ? 'border-success/30 bg-success-soft/40'
          : 'border-danger/30 bg-danger-soft/40',
      )}
    >
      {state.isUsable ? (
        <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />
      ) : (
        <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0 text-danger" />
      )}
      <p className="leading-relaxed text-ink">
        {state.isUsable ? t('recovery.destinationOk', { free: freeLabel }) : state.message}
      </p>
    </div>
  )
}

/**
 * The Free-edition refusal, with a way past it.
 *
 * Buying is the primary action because it opens the browser and leaves this
 * dialog — and the selection behind it — exactly as it is. Entering a key
 * means leaving the scan for the Licence screen, so it is offered second.
 */
function FreeLimitNotice({ refusal }: { refusal: FreeLimitRefusal }) {
  const { t } = useTranslation()
  const format = useFormatters()
  const navigate = useNavigate()

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-soft/40 p-3 text-[12.5px]"
    >
      <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">{t('recovery.freeLimit.title')}</p>
        <p className="mt-1 leading-relaxed text-ink-muted">
          {refusal.remainingBytes === 0
            ? t('recovery.freeLimit.spent', { limit: format.bytes(refusal.limitBytes) })
            : t('recovery.freeLimit.body', {
                requested: format.bytes(refusal.requestedBytes),
                remaining: format.bytes(refusal.remainingBytes),
                limit: format.bytes(refusal.limitBytes),
              })}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            iconLeft={<ShoppingCart size={14} />}
            onClick={() => {
              void openPurchasePage()
            }}
          >
            {t('license.buy')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<KeyRound size={14} />}
            onClick={() => {
              void navigate(AppRoute.License)
            }}
          >
            {t('recovery.freeLimit.enterKey')}
          </Button>
        </div>
      </div>
    </div>
  )
}
