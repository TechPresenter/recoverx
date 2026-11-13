import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleCheckBig, CircleHelp, FileQuestion, X } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { ContentVerdict, FilePreview } from '@shared/types/scan'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/cn'
import { invoke } from '@/lib/ipc-client'

/**
 * Preview pane.
 *
 * Exists to answer one question before a user commits to a recovery: *is this
 * actually my file?* The rendered image is the pleasant part, but the verdict
 * and the hex dump are the load-bearing ones — they are shown for every result,
 * including the ones that cannot be rendered at all.
 */

export interface PreviewPaneProps {
  readonly fileId: string | null
  readonly onClose: () => void
}

export function PreviewPane({ fileId, onClose }: PreviewPaneProps) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (fileId === null) {
      setPreview(null)
      return
    }

    let cancelled = false
    setPreview(null)
    setError(null)

    void (async () => {
      const response = await invoke(IpcChannel.PreviewFile, { fileId })
      // The user can click through results faster than a preview can be read;
      // a stale response must not overwrite a newer one.
      if (cancelled) return

      if (response.ok) setPreview(response.data)
      else setError(response.error.message)
    })()

    return () => {
      cancelled = true
    }
  }, [fileId])

  if (fileId === null) return null

  return (
    <aside
      aria-label={t('preview.title')}
      className="flex w-full flex-col gap-4 overflow-y-auto rounded-card border border-line bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-[14px] font-semibold text-ink">
          {preview?.name ?? t('preview.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="shrink-0 rounded-md p-1 text-ink-subtle hover:bg-surface-2 hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>

      {error !== null ? (
        <p className="text-[12.5px] text-danger">{error}</p>
      ) : preview === null ? (
        <div className="space-y-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          <VerdictBanner preview={preview} />
          <PreviewBody preview={preview} />
          <FactsList preview={preview} />
          <HexDump preview={preview} />
        </>
      )}
    </aside>
  )
}

/**
 * The verdict banner.
 *
 * Stated in plain language rather than as a status word, because "the bytes do
 * not match this file type" is actionable and "MISMATCH" is not.
 */
function VerdictBanner({ preview }: { preview: FilePreview }) {
  const { t } = useTranslation()

  const message =
    preview.verdict === 'match'
      ? t('preview.verdictMatch', { format: preview.detectedLabel ?? '' })
      : preview.verdict === 'mismatch'
        ? preview.isBlank
          ? t('preview.verdictBlank')
          : t('preview.verdictMismatch', { format: preview.detectedLabel ?? t('common.unknown') })
        : preview.verdict === 'empty'
          ? t('preview.verdictUnreadable')
          : preview.signatureUnavailable
            ? t('preview.verdictNoSignature')
            : t('preview.verdictUnknown')

  const Icon =
    preview.verdict === 'match'
      ? CircleCheckBig
      : preview.verdict === 'unknown'
        ? CircleHelp
        : CircleAlert

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-3 text-[12.5px]',
        preview.verdict === 'match'
          ? 'border-success/30 bg-success-soft/40'
          : preview.verdict === 'unknown'
            ? 'border-line bg-surface-2'
            : 'border-danger/30 bg-danger-soft/40',
      )}
    >
      <Icon size={15} aria-hidden className={cn('mt-0.5 shrink-0', verdictText(preview.verdict))} />
      <div className="min-w-0">
        <p className="leading-relaxed text-ink">{message}</p>
        <Badge dense tone={verdictTone(preview.verdict)} className="mt-1.5">
          {t(verdictKey(preview.verdict))}
        </Badge>
      </div>
    </div>
  )
}

function PreviewBody({ preview }: { preview: FilePreview }) {
  const { t } = useTranslation()

  if (preview.kind === 'image' && preview.mediaDataUrl !== null) {
    return (
      <img
        src={preview.mediaDataUrl}
        alt={t('preview.imageAlt', { name: preview.name })}
        className="max-h-72 w-full rounded-lg border border-line bg-surface-2 object-contain"
      />
    )
  }

  if (preview.kind === 'media' && preview.mediaDataUrl !== null) {
    // Chromium decodes whatever codecs it ships with; an unsupported one shows
    // the element's own error state rather than a blank box.
    return (
      <video
        src={preview.mediaDataUrl}
        controls
        className="max-h-72 w-full rounded-lg border border-line bg-black"
      >
        <track kind="captions" />
      </video>
    )
  }

  if (preview.kind === 'text' && preview.text !== null) {
    return (
      <div>
        <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink">
          {preview.text}
        </pre>
        {preview.textTruncated && (
          <p className="mt-1 text-[11.5px] text-ink-subtle">{t('preview.textTruncated')}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-2 py-8 text-ink-subtle">
      <FileQuestion size={22} aria-hidden />
      <p className="text-[12.5px]">{t('preview.noVisual')}</p>
    </div>
  )
}

function FactsList({ preview }: { preview: FilePreview }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {preview.facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-ink-subtle">{fact.label}</dt>
          <dd className="text-numeric truncate text-ink" title={fact.value}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function HexDump({ preview }: { preview: FilePreview }) {
  const { t } = useTranslation()

  if (preview.hexDump.length === 0) return null

  return (
    <details className="rounded-lg border border-line">
      <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-ink">
        {t('preview.hexDump')}
      </summary>
      <pre className="overflow-x-auto border-t border-line bg-surface-2 p-3 font-mono text-[10.5px] leading-relaxed text-ink-muted">
        {preview.hexDump}
      </pre>
    </details>
  )
}

function verdictKey(verdict: ContentVerdict) {
  switch (verdict) {
    case 'match':
      return 'preview.badgeVerified' as const
    case 'mismatch':
      return 'preview.badgeMismatch' as const
    case 'empty':
      return 'preview.badgeUnreadable' as const
    case 'unknown':
      return 'preview.badgeUnverified' as const
  }
}

function verdictTone(verdict: ContentVerdict): BadgeTone {
  switch (verdict) {
    case 'match':
      return 'success'
    case 'mismatch':
      return 'danger'
    case 'empty':
      return 'warning'
    case 'unknown':
      return 'neutral'
  }
}

function verdictText(verdict: ContentVerdict): string {
  switch (verdict) {
    case 'match':
      return 'text-success'
    case 'unknown':
      return 'text-ink-subtle'
    case 'mismatch':
    case 'empty':
      return 'text-danger'
  }
}
