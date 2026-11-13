import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BugOff, FolderOpen, ShieldCheck, Trash2 } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { CrashKind, CrashReport } from '@shared/types/diagnostics'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { useFormatters } from '@/hooks/useFormatters'
import { invoke } from '@/lib/ipc-client'
import { toast, useUiStore } from '@/stores/ui.store'

/**
 * Crash reports.
 *
 * Shown in full, including the stack trace, because the person most likely to
 * read this is the one whose application crashed and who now has to decide
 * whether it is safe to try again. Hiding the detail behind "an error occurred"
 * would leave them guessing.
 *
 * The traces are already redacted on disk — the home directory and account name
 * are removed as the report is written, not as it is sent — so what is shown
 * here is the same text that is safe to attach to an email.
 */
export function CrashReports() {
  const { t } = useTranslation()
  const format = useFormatters()
  const requestConfirm = useUiStore((state) => state.requestConfirm)

  const [reports, setReports] = useState<readonly CrashReport[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const response = await invoke(IpcChannel.CrashList, undefined)
    if (response.ok) setReports(response.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const clear = useCallback(async (): Promise<void> => {
    const confirmed = await requestConfirm({
      title: t('crashes.clearTitle'),
      description: t('crashes.clearBody'),
      confirmLabel: t('crashes.clear'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    })

    if (!confirmed) return

    const response = await invoke(IpcChannel.CrashClear, undefined)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return
    }

    setReports([])
    toast.success(t('crashes.cleared', { count: response.data.removed }))
  }, [requestConfirm, t])

  if (reports === null) return null

  return (
    <Card>
      <CardHeader
        icon={<BugOff size={16} aria-hidden />}
        title={t('crashes.title')}
        description={
          reports.length === 0 ? t('crashes.none') : t('crashes.count', { count: reports.length })
        }
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<FolderOpen size={14} />}
              onClick={() => {
                void invoke(IpcChannel.CrashOpenFolder, undefined)
              }}
            >
              {t('crashes.openFolder')}
            </Button>
            {reports.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<Trash2 size={14} />}
                onClick={() => {
                  void clear()
                }}
              >
                {t('crashes.clear')}
              </Button>
            )}
          </div>
        }
      />

      {/* Stated where the reports are, not buried in a privacy policy. */}
      <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-ink-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
        {t('crashes.privacy')}
      </p>

      {reports.length > 0 && (
        <div className="mt-4 space-y-2">
          {reports.map((report) => (
            <div key={report.id} className="rounded-lg border border-line">
              <button
                type="button"
                aria-expanded={expanded === report.id}
                onClick={() => {
                  setExpanded((current) => (current === report.id ? null : report.id))
                }}
                className="flex w-full flex-wrap items-center gap-2 p-3 text-left"
              >
                <Badge dense tone="danger">
                  {kindLabel(report.kind, t)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {report.message}
                </span>
                <span className="text-[11.5px] tabular-nums text-ink-subtle">
                  {format.relative(report.occurredAt)}
                </span>
              </button>

              {expanded === report.id && (
                <div className="border-t border-line p-3">
                  <p className="text-[11.5px] text-ink-subtle">
                    {t('crashes.environment', {
                      app: report.appVersion,
                      electron: report.electronVersion,
                      os: report.osVersion,
                      arch: report.arch,
                    })}
                  </p>
                  {report.stack !== null && (
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
                      {report.stack}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

function kindLabel(kind: CrashKind, t: Translate): string {
  switch (kind) {
    case 'main-exception':
      return t('crashes.kind.mainException')
    case 'main-rejection':
      return t('crashes.kind.mainRejection')
    case 'renderer-gone':
      return t('crashes.kind.rendererGone')
    case 'child-process-gone':
      return t('crashes.kind.childGone')
  }
}
