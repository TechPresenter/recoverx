import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Building2,
  ClipboardCopy,
  Database,
  ExternalLink,
  FolderOpen,
  Globe,
  ScrollText,
  Shield,
} from 'lucide-react'
import {
  APP_NAME,
  DOCS_URL,
  PRIVACY_URL,
  RELEASE_NOTES_URL,
  VENDOR_NAME,
  VENDOR_URL,
  COPYRIGHT_NOTICE,
  WEBSITE_URL,
} from '@shared/constants/app'
import { IpcChannel } from '@shared/ipc/channels'
import type { AppInfo, Diagnostics } from '@shared/types/system'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { UpdatePanel } from './UpdatePanel'
import { Skeleton } from '@/components/ui/Skeleton'
import { DefinitionRow } from '@/components/ui/StatTile'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke } from '@/lib/ipc-client'
import { toast } from '@/stores/ui.store'

/**
 * About.
 *
 * Doubles as the support surface: everything an engineer needs to reproduce a
 * report — build, runtime versions, schema version, storage paths and sizes — is
 * on this page and copyable in one click. That removes an entire round trip from
 * every support conversation.
 */
export function AboutPage() {
  const { t } = useTranslation()
  const format = useFormatters()
  const { copy } = useCopyToClipboard()

  const [info, setInfo] = useState<AppInfo | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)

  useEffect(() => {
    let cancelled = false

    void Promise.all([
      invoke(IpcChannel.AppGetInfo, undefined),
      invoke(IpcChannel.AppGetDiagnostics, undefined),
    ]).then(([infoResult, diagnosticsResult]) => {
      if (cancelled) return
      if (infoResult.ok) setInfo(infoResult.data)
      if (diagnosticsResult.ok) setDiagnostics(diagnosticsResult.data)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const onCopyDiagnostics = useCallback(() => {
    if (info === null || diagnostics === null) return

    void copy(buildSupportReport(info, diagnostics)).then((succeeded) => {
      if (succeeded) toast.success(t('common.copied'))
    })
  }, [copy, diagnostics, info, t])

  const onReveal = useCallback((path: string) => {
    void invoke(IpcChannel.AppRevealPath, { path })
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('about.title')}
        description={t('about.subtitle')}
        actions={
          <Button
            size="sm"
            variant="secondary"
            iconLeft={<ClipboardCopy size={14} />}
            disabled={info === null || diagnostics === null}
            onClick={onCopyDiagnostics}
          >
            {t('about.copyDiagnostics')}
          </Button>
        }
      />

      <UpdatePanel />

      <Card>
        <div className="flex items-start gap-4">
          <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-accent text-accent-contrast">
            <Shield size={26} aria-hidden />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-ink">{APP_NAME}</h2>
              {info !== null && (
                <>
                  <Badge tone="accent">{info.version}</Badge>
                  <Badge tone="neutral">{t('about.edition')}</Badge>
                  {!info.isPackaged && <Badge tone="warning">development</Badge>}
                </>
              )}
            </div>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
              {t('about.legalBody')}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<Globe size={16} />} title={t('about.runtime')} />

          <dl className="mt-3">
            {info === null ? (
              <LoadingRows />
            ) : (
              <>
                <DefinitionRow term={t('about.version')} selectable>
                  {info.version}
                </DefinitionRow>
                <DefinitionRow term={t('about.channel')}>{info.channel}</DefinitionRow>
                <DefinitionRow term={t('about.build')}>
                  {info.isPackaged ? t('dashboard.buildPackaged') : t('dashboard.buildDevelopment')}
                </DefinitionRow>
                <DefinitionRow term={t('about.platform')} selectable>
                  {`${info.platform} · ${info.arch}`}
                </DefinitionRow>
                <DefinitionRow term={t('about.locale')}>{info.locale}</DefinitionRow>
                <DefinitionRow term="Electron" selectable>
                  {info.runtime.electron}
                </DefinitionRow>
                <DefinitionRow term="Chromium" selectable>
                  {info.runtime.chrome}
                </DefinitionRow>
                <DefinitionRow term="Node.js" selectable>
                  {info.runtime.node}
                </DefinitionRow>
                <DefinitionRow term="V8" selectable>
                  {info.runtime.v8}
                </DefinitionRow>
              </>
            )}
          </dl>
        </Card>

        <Card>
          <CardHeader icon={<Database size={16} />} title={t('about.storage')} />

          <dl className="mt-3">
            {diagnostics === null ? (
              <LoadingRows />
            ) : (
              <>
                <DefinitionRow term={t('about.startupTime')}>
                  {`${diagnostics.startupMs.toFixed(0)} ms`}
                </DefinitionRow>
                <DefinitionRow term={t('about.schemaVersion')}>
                  {`v${diagnostics.schemaVersion}`}
                </DefinitionRow>
                <DefinitionRow term={t('about.migrations')}>
                  {format.number(diagnostics.appliedMigrations)}
                </DefinitionRow>
                <DefinitionRow term={t('about.databaseSize')}>
                  {format.bytes(diagnostics.databaseSizeBytes)}
                </DefinitionRow>
                <DefinitionRow term={t('about.logFiles')}>
                  {format.number(diagnostics.logFileCount)}
                </DefinitionRow>
                <DefinitionRow term={t('about.logSize')}>
                  {format.bytes(diagnostics.logSizeBytes)}
                </DefinitionRow>
              </>
            )}
          </dl>

          {diagnostics !== null && (
            <div className="mt-4 space-y-2">
              <PathRow
                label={t('about.userData')}
                path={diagnostics.userDataDir}
                onReveal={onReveal}
                revealLabel={t('about.reveal')}
              />
              <PathRow
                label={t('about.logDirectory')}
                path={diagnostics.logDirectory}
                onReveal={onReveal}
                revealLabel={t('about.reveal')}
              />
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader icon={<BookOpen size={16} />} title={t('about.links')} />

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <ExternalLinkRow
            icon={<Globe size={15} />}
            label={t('about.website')}
            url={WEBSITE_URL}
          />
          <ExternalLinkRow
            icon={<BookOpen size={15} />}
            label={t('about.documentation')}
            url={DOCS_URL}
          />
          <ExternalLinkRow
            icon={<Shield size={15} />}
            label={t('about.privacy')}
            url={PRIVACY_URL}
          />
          <ExternalLinkRow
            icon={<ScrollText size={15} />}
            label={t('about.releaseNotes')}
            url={RELEASE_NOTES_URL}
          />
        </div>
      </Card>

      {/* Credits and the licence notice. Kept as one block so the attribution
          and the terms it is attached to cannot drift apart. */}
      <Card className="gradient-surface">
        <CardHeader icon={<Building2 size={16} />} title={t('about.credits')} />

        <p className="mt-3 text-[13px] leading-relaxed text-ink">
          {t('about.creditsBody', { vendor: VENDOR_NAME })}
        </p>

        <div className="mt-3">
          <ExternalLinkRow icon={<Globe size={15} />} label={t('about.website')} url={VENDOR_URL} />
        </div>

        <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-ink-muted">
          {COPYRIGHT_NOTICE} {t('about.rightsReserved', { vendor: VENDOR_NAME })}
        </p>
      </Card>
    </div>
  )
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="my-2.5 h-4 w-full" />
      ))}
    </>
  )
}

function PathRow({
  label,
  path,
  onReveal,
  revealLabel,
}: {
  label: string
  path: string
  onReveal: (path: string) => void
  revealLabel: string
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] text-ink-subtle">{label}</p>
        <p className="selectable truncate font-mono text-[12px] text-ink-muted" title={path}>
          {path}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        aria-label={revealLabel}
        title={revealLabel}
        onClick={() => {
          onReveal(path)
        }}
        iconLeft={<FolderOpen size={14} />}
      />
    </div>
  )
}

/**
 * External link.
 *
 * Rendered as a button rather than an anchor on purpose: the navigation guard
 * blocks in-place navigation, and routing through the IPC channel means the URL
 * is checked against the host allowlist before the OS browser is invoked.
 */
function ExternalLinkRow({
  icon,
  label,
  url,
}: {
  icon: React.ReactNode
  label: string
  url: string
}) {
  return (
    <button
      type="button"
      onClick={() => {
        void invoke(IpcChannel.AppOpenExternal, { url })
      }}
      className="group flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        <span className="block truncate text-[12px] text-ink-subtle">{url}</span>
      </span>
      <ExternalLink
        size={14}
        aria-hidden
        className="shrink-0 text-ink-subtle transition-colors group-hover:text-ink"
      />
    </button>
  )
}

/**
 * Plain-text support report.
 *
 * Format is deliberately flat and greppable so it survives being pasted into an
 * email, a chat window or a GitHub issue without a code fence.
 */
function buildSupportReport(info: AppInfo, diagnostics: Diagnostics): string {
  return [
    `${APP_NAME} ${info.version} (${info.channel}${info.isPackaged ? '' : ', development'})`,
    `Platform:   ${info.platform} ${info.arch}`,
    `Locale:     ${info.locale}`,
    `Electron:   ${info.runtime.electron}`,
    `Chromium:   ${info.runtime.chrome}`,
    `Node.js:    ${info.runtime.node}`,
    `V8:         ${info.runtime.v8}`,
    '',
    `Start-up:   ${diagnostics.startupMs.toFixed(0)} ms`,
    `Schema:     v${diagnostics.schemaVersion} (${diagnostics.appliedMigrations} migrations)`,
    `Database:   ${diagnostics.databasePath} (${diagnostics.databaseSizeBytes} bytes)`,
    `User data:  ${diagnostics.userDataDir}`,
    `Logs:       ${diagnostics.logDirectory} (${diagnostics.logFileCount} files, ${diagnostics.logSizeBytes} bytes)`,
  ].join('\n')
}
