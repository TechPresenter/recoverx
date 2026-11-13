import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  FolderOpen,
  HardDriveDownload,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
} from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type {
  AccentColor,
  AppSettingsPatch,
  Language,
  LogLevel,
  ThemeMode,
} from '@shared/types/settings'
import type { PathValidation } from '@shared/types/system'
import type { ByteUnitSystem } from '@shared/utils/bytes'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { AVAILABLE_LANGUAGES } from '@/i18n'
import { useFormatters } from '@/hooks/useFormatters'
import { cn } from '@/lib/cn'
import { invoke } from '@/lib/ipc-client'
import { useSettings, useSettingsStore } from '@/stores/settings.store'
import { toast, useUiStore } from '@/stores/ui.store'

/**
 * Settings.
 *
 * Every control writes immediately — there is no Save button. Each change is a
 * single validated IPC round trip that either persists or reverts, so the UI can
 * never claim a preference is active when it was not stored. A form-wide save
 * would introduce a state where the screen and the database disagree, which for
 * the recovery destination is a data-safety problem rather than a cosmetic one.
 */
export function SettingsPage() {
  const { t } = useTranslation()
  const settings = useSettings()
  const update = useSettingsStore((state) => state.update)
  const reset = useSettingsStore((state) => state.reset)
  const savingKeys = useSettingsStore((state) => state.savingKeys)
  const requestConfirm = useUiStore((state) => state.requestConfirm)

  const apply = useCallback(
    async (patch: AppSettingsPatch): Promise<void> => {
      const succeeded = await update(patch)
      if (!succeeded) {
        toast.error(t('settings.saveFailed'), useSettingsStore.getState().error?.message)
      }
    },
    [update, t],
  )

  const onReset = useCallback(() => {
    void (async () => {
      if (settings.confirmDestructiveActions) {
        const confirmed = await requestConfirm({
          title: t('settings.resetTitle'),
          description: t('settings.resetConfirm'),
          confirmLabel: t('settings.resetAction'),
          cancelLabel: t('common.cancel'),
          destructive: true,
        })
        if (!confirmed) return
      }

      const succeeded = await reset()
      if (succeeded) toast.success(t('settings.resetDone'))
      else toast.error(t('settings.saveFailed'))
    })()
  }, [requestConfirm, reset, settings.confirmDestructiveActions, t])

  const isSaving = (key: keyof AppSettingsPatch): boolean => savingKeys.includes(key)

  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />

      <SettingsSection icon={<Palette size={16} />} title={t('settings.appearance')}>
        <Select<ThemeMode>
          inline
          label={t('settings.theme')}
          description={t('settings.themeHint')}
          value={settings.theme}
          disabled={isSaving('theme')}
          onValueChange={(theme) => {
            void apply({ theme })
          }}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
        />

        <AccentPicker
          value={settings.accent}
          onChange={(accent) => {
            void apply({ accent })
          }}
        />

        <Select<Language>
          inline
          label={t('settings.language')}
          description={t('settings.languageHint')}
          value={settings.language}
          disabled={isSaving('language')}
          onValueChange={(language) => {
            void apply({ language })
          }}
          options={AVAILABLE_LANGUAGES.map((entry) => ({ value: entry.code, label: entry.label }))}
        />

        <Select<ByteUnitSystem>
          inline
          label={t('settings.units')}
          description={t('settings.unitsHint')}
          value={settings.byteUnitSystem}
          disabled={isSaving('byteUnitSystem')}
          onValueChange={(byteUnitSystem) => {
            void apply({ byteUnitSystem })
          }}
          options={[
            { value: 'binary', label: t('settings.unitsBinary') },
            { value: 'decimal', label: t('settings.unitsDecimal') },
          ]}
        />

        <Switch
          label={t('settings.density')}
          description={t('settings.densityHint')}
          checked={settings.compactDensity}
          pending={isSaving('compactDensity')}
          onCheckedChange={(compactDensity) => {
            void apply({ compactDensity })
          }}
        />

        <Switch
          label={t('settings.motion')}
          description={t('settings.motionHint')}
          checked={settings.reduceMotion}
          pending={isSaving('reduceMotion')}
          onCheckedChange={(reduceMotion) => {
            void apply({ reduceMotion })
          }}
        />
      </SettingsSection>

      <SettingsSection icon={<ShieldCheck size={16} />} title={t('settings.safety')}>
        <RecoveryPathField
          value={settings.defaultRecoveryPath}
          onChange={(defaultRecoveryPath) => apply({ defaultRecoveryPath })}
        />

        <Switch
          label={t('settings.confirmDestructive')}
          description={t('settings.confirmDestructiveHint')}
          checked={settings.confirmDestructiveActions}
          pending={isSaving('confirmDestructiveActions')}
          onCheckedChange={(confirmDestructiveActions) => {
            void apply({ confirmDestructiveActions })
          }}
        />
      </SettingsSection>

      <SettingsSection icon={<Stethoscope size={16} />} title={t('settings.diagnostics')}>
        <Select<LogLevel>
          inline
          label={t('settings.logLevel')}
          description={t('settings.logLevelHint')}
          value={settings.logLevel}
          disabled={isSaving('logLevel')}
          onValueChange={(logLevel) => {
            void apply({ logLevel })
          }}
          options={[
            { value: 'error', label: t('settings.logLevelError') },
            { value: 'warn', label: t('settings.logLevelWarn') },
            { value: 'info', label: t('settings.logLevelInfo') },
            { value: 'debug', label: t('settings.logLevelDebug') },
          ]}
        />

        <Select<string>
          inline
          label={t('settings.logRetention')}
          description={t('settings.logRetentionHint')}
          value={String(settings.logRetentionDays)}
          disabled={isSaving('logRetentionDays')}
          onValueChange={(value) => {
            void apply({ logRetentionDays: Number.parseInt(value, 10) })
          }}
          options={[7, 14, 30, 60, 90].map((days) => ({
            value: String(days),
            label: t('settings.logRetentionDays', { count: days }),
          }))}
        />

        {/* No "share diagnostics" switch: nothing in the application sends
            diagnostics anywhere, and a switch that controls nothing tells the
            user something untrue in either position. See `telemetryEnabled`. */}
      </SettingsSection>

      <SettingsSection icon={<SlidersHorizontal size={16} />} title={t('settings.application')}>
        <Switch
          label={t('settings.autoUpdate')}
          description={t('settings.autoUpdateHint')}
          checked={settings.autoCheckUpdates}
          pending={isSaving('autoCheckUpdates')}
          onCheckedChange={(autoCheckUpdates) => {
            void apply({ autoCheckUpdates })
          }}
        />

        <Switch
          label={t('settings.hardwareAcceleration')}
          description={t('settings.hardwareAccelerationHint')}
          checked={settings.hardwareAcceleration}
          pending={isSaving('hardwareAcceleration')}
          onCheckedChange={(hardwareAcceleration) => {
            void apply({ hardwareAcceleration })
          }}
        />

        <Switch
          label={t('settings.launchMinimized')}
          description={t('settings.launchMinimizedHint')}
          checked={settings.launchMinimized}
          pending={isSaving('launchMinimized')}
          onCheckedChange={(launchMinimized) => {
            void apply({ launchMinimized })
          }}
        />
      </SettingsSection>

      <Card>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{t('settings.resetTitle')}</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
              {t('settings.resetHint')}
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={onReset}>
            {t('settings.resetAction')}
          </Button>
        </div>
      </Card>
    </div>
  )
}

function SettingsSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader icon={icon} title={title} />
      <div className="mt-2 divide-y divide-line">{children}</div>
    </Card>
  )
}

const ACCENTS: ReadonlyArray<{ value: AccentColor; labelKey: string }> = [
  { value: 'blue', labelKey: 'settings.accentBlue' },
  { value: 'violet', labelKey: 'settings.accentViolet' },
  { value: 'emerald', labelKey: 'settings.accentEmerald' },
  { value: 'amber', labelKey: 'settings.accentAmber' },
  { value: 'rose', labelKey: 'settings.accentRose' },
]

/**
 * Accent swatches.
 *
 * Each swatch carries its own `data-accent`, so the dot renders in the colour it
 * selects by resolving the very same custom property the application uses — the
 * preview cannot drift from the result.
 */
function AccentPicker({
  value,
  onChange,
}: {
  value: AccentColor
  onChange: (accent: AccentColor) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <span className="block text-sm font-medium text-ink">{t('settings.accent')}</span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-muted">
          {t('settings.accentHint')}
        </span>
      </div>

      <div
        role="radiogroup"
        aria-label={t('settings.accent')}
        className="flex shrink-0 items-center gap-2"
      >
        {ACCENTS.map((accent) => {
          const selected = accent.value === value
          const label = t(accent.labelKey as 'settings.accentBlue')

          return (
            <button
              key={accent.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              data-accent={accent.value}
              onClick={() => {
                onChange(accent.value)
              }}
              className={cn(
                'grid size-7 place-items-center rounded-full transition-transform',
                'hover:scale-110',
                selected && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
              )}
            >
              <span className="size-5 rounded-full bg-accent" />
              {selected && (
                <Check
                  size={12}
                  aria-hidden
                  className="absolute text-accent-contrast"
                  strokeWidth={3}
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Recovery destination.
 *
 * Validated against the real filesystem whenever it changes, and the free space
 * on the target volume is shown. Writing recovered files back onto the source
 * device can overwrite the very sectors still holding unrecovered data, so this
 * is the one setting on the page with irreversible consequences.
 */
function RecoveryPathField({
  value,
  onChange,
}: {
  value: string
  onChange: (path: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const format = useFormatters()
  const [validation, setValidation] = useState<PathValidation | null>(null)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    let cancelled = false

    void invoke(IpcChannel.AppValidatePath, { path: value }).then((result) => {
      if (!cancelled) setValidation(result.ok ? result.data : null)
    })

    return () => {
      cancelled = true
    }
  }, [value])

  const onBrowse = useCallback(() => {
    setBrowsing(true)

    void invoke(IpcChannel.AppPickDirectory, {
      title: t('settings.recoveryPath'),
      defaultPath: value,
    })
      .then(async (result) => {
        if (!result.ok || result.data.path === null) return
        await onChange(result.data.path)
      })
      .finally(() => {
        setBrowsing(false)
      })
  }, [onChange, t, value])

  const problem = describeProblem(validation)

  return (
    <div className="py-3">
      <Input
        readOnly
        label={t('settings.recoveryPath')}
        description={t('settings.recoveryPathHint')}
        value={value}
        iconLeft={<HardDriveDownload size={15} />}
        className="selectable font-mono text-[12.5px]"
        {...(problem === null ? {} : { error: t(problem) })}
        trailing={
          <Button
            variant="secondary"
            loading={browsing}
            onClick={onBrowse}
            iconLeft={<FolderOpen size={15} />}
          >
            {t('common.browse')}
          </Button>
        }
      />

      {validation !== null && problem === null && validation.totalBytes > 0 && (
        <p className="text-numeric mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-subtle">
          <Check size={13} className="text-success" aria-hidden />
          {t('settings.recoveryPathFree', {
            free: format.bytes(validation.freeBytes),
            total: format.bytes(validation.totalBytes),
          })}
        </p>
      )}

      {problem !== null && (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-warning">
          <AlertTriangle size={13} aria-hidden />
          {t('settings.recoveryPathInvalid')}
        </p>
      )}
    </div>
  )
}

type PathProblem = 'settings.recoveryPathMissing' | 'settings.recoveryPathReadOnly'

function describeProblem(validation: PathValidation | null): PathProblem | null {
  if (validation === null) return null
  if (!validation.exists || !validation.isDirectory) return 'settings.recoveryPathMissing'
  if (!validation.isWritable) return 'settings.recoveryPathReadOnly'
  return null
}
