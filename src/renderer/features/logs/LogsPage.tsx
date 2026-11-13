import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, FolderOpen, Radio, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'
import type { LogEntry, LogFileInfo, LogQueryResult } from '@shared/types/logging'
import type { LogLevel } from '@shared/types/settings'
import { formatLogTimestamp, formatTimestamp } from '@shared/utils/time'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { SearchInput } from '@/components/ui/Input'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useFormatters } from '@/hooks/useFormatters'
import { useVirtualRows } from '@/hooks/useVirtualRows'
import { cn } from '@/lib/cn'
import { invoke, subscribe } from '@/lib/ipc-client'
import { CrashReports } from './CrashReports'
import { useSettingsStore } from '@/stores/settings.store'
import { toast, useUiStore } from '@/stores/ui.store'

/** Fixed row heights, required by the virtualiser and matched by the row styles. */
const ROW_HEIGHT = 32
const COMPACT_ROW_HEIGHT = 27

/** Page size. Large enough that scrolling rarely reaches the end in one session. */
const PAGE_SIZE = 1000

/** Bound on buffered live records, so a log storm cannot grow memory without limit. */
const MAX_LIVE_ENTRIES = 500

/** Debounce for the search field; each query re-reads and re-parses the file. */
const QUERY_DEBOUNCE_MS = 220

type LevelFilter = 'all' | LogLevel

/**
 * Diagnostics log viewer.
 *
 * Rows are virtualised because a verbose scan produces tens of thousands of
 * records per file — mounting a DOM node for each would make the screen unusable
 * at exactly the moment a user needs it most.
 *
 * Filtering runs in the main process, against the file. Live records arriving
 * over `evt:log-appended` are matched client-side against the same predicate, so
 * the tail shows exactly what a re-query would.
 */
export function LogsPage() {
  const { t } = useTranslation()
  const format = useFormatters()
  const compact = useSettingsStore((state) => state.settings?.compactDensity ?? false)
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT

  const [files, setFiles] = useState<readonly LogFileInfo[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [level, setLevel] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const [live, setLive] = useState(true)
  const [result, setResult] = useState<LogQueryResult | null>(null)
  const [liveEntries, setLiveEntries] = useState<readonly LogEntry[]>([])
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [loading, setLoading] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const { copy } = useCopyToClipboard()
  const requestConfirm = useUiStore((state) => state.requestConfirm)

  const loadFiles = useCallback(async (): Promise<void> => {
    const response = await invoke(IpcChannel.LogsListFiles, undefined)
    if (!response.ok) return

    setFiles(response.data)

    // Default to whichever file is being written to — what a user opening this
    // screen almost always wants to see.
    setSelectedFile((current) => {
      if (current.length > 0 && response.data.some((file) => file.name === current)) return current
      return response.data.find((file) => file.isActive)?.name ?? response.data[0]?.name ?? ''
    })
  }, [])

  const runQuery = useCallback(async (): Promise<void> => {
    if (selectedFile.length === 0) return

    setLoading(true)

    const trimmedSearch = search.trim()

    const response = await invoke(IpcChannel.LogsQuery, {
      file: selectedFile,
      ...(level === 'all' ? {} : { levels: [level] }),
      ...(trimmedSearch.length === 0 ? {} : { search: trimmedSearch }),
      limit: PAGE_SIZE,
      offset: 0,
    })

    setLoading(false)

    if (!response.ok) {
      toast.error(t('errors.generic'), response.error.message)
      return
    }

    setResult(response.data)
    // The file that was just read already contains everything buffered so far;
    // keeping the live buffer would duplicate those rows.
    setLiveEntries([])
  }, [selectedFile, level, search, t])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    const timer = setTimeout(() => {
      void runQuery()
    }, QUERY_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [runQuery])

  const matchesFilters = useCallback(
    (entry: LogEntry): boolean => {
      if (level !== 'all' && entry.level !== level) return false

      const needle = search.trim().toLowerCase()
      if (needle.length === 0) return true

      return `${entry.message}\n${entry.scope}\n${entry.meta ?? ''}`.toLowerCase().includes(needle)
    },
    [level, search],
  )

  const isViewingActiveFile = files.find((file) => file.name === selectedFile)?.isActive ?? false
  const tailing = live && isViewingActiveFile

  // Only the active file receives new records, so tailing an archived file would
  // silently never update.
  useEffect(() => {
    if (!tailing) return

    return subscribe(IpcEvent.LogAppended, (batch) => {
      const accepted = batch.filter(matchesFilters)
      if (accepted.length === 0) return

      // The list is newest-first, and a batch arrives oldest-first.
      setLiveEntries((previous) =>
        [...accepted.slice().reverse(), ...previous].slice(0, MAX_LIVE_ENTRIES),
      )
    })
  }, [tailing, matchesFilters])

  const entries = useMemo(() => [...liveEntries, ...(result?.entries ?? [])], [liveEntries, result])

  const range = useVirtualRows(scrollRef, { count: entries.length, rowHeight })

  const onClearOlder = useCallback(() => {
    void (async () => {
      const confirmed = await requestConfirm({
        title: t('logs.clearOlder'),
        description: t('logs.clearConfirm'),
        confirmLabel: t('common.clear'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      })
      if (!confirmed) return

      const response = await invoke(IpcChannel.LogsClear, undefined)

      if (!response.ok) {
        toast.error(t('errors.generic'), response.error.message)
        return
      }

      toast.success(
        t('logs.cleared', {
          count: response.data.removedFiles,
          size: format.bytes(response.data.freedBytes),
        }),
      )
      await loadFiles()
    })()
  }, [format, loadFiles, requestConfirm, t])

  const onCopyEntry = useCallback(
    (entry: LogEntry): void => {
      void copy(serializeEntry(entry)).then((succeeded) => {
        if (succeeded) toast.success(t('common.copied'))
      })
    },
    [copy, t],
  )

  const isFiltered = search.trim().length > 0 || level !== 'all'

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('logs.title')}
        description={t('logs.subtitle')}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<FolderOpen size={14} />}
              onClick={() => {
                void invoke(IpcChannel.LogsOpenFolder, undefined)
              }}
            >
              {t('logs.openFolder')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Trash2 size={14} />}
              onClick={onClearOlder}
            >
              {t('logs.clearOlder')}
            </Button>
          </>
        }
      />

      <Card flush className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <Select<string>
            value={selectedFile}
            onValueChange={setSelectedFile}
            className="w-64"
            aria-label={t('logs.file')}
            options={
              files.length === 0
                ? [{ value: '', label: t('logs.noFiles') }]
                : files.map((file) => ({
                    value: file.name,
                    label: file.isActive ? `${file.name} · ${t('logs.activeFile')}` : file.name,
                  }))
            }
          />

          <SegmentedControl<LevelFilter>
            size="sm"
            value={level}
            onValueChange={setLevel}
            ariaLabel={t('logs.level')}
            segments={[
              { value: 'all', label: t('logs.allLevels') },
              { value: 'error', label: 'Error' },
              { value: 'warn', label: 'Warn' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]}
          />

          <SearchInput
            value={search}
            onValueChange={setSearch}
            ariaLabel={t('logs.searchPlaceholder')}
            placeholder={t('logs.searchPlaceholder')}
            className="min-w-56 flex-1"
          />

          <button
            type="button"
            role="switch"
            aria-checked={tailing}
            disabled={!isViewingActiveFile}
            onClick={() => {
              setLive((current) => !current)
            }}
            title={tailing ? t('logs.liveOn') : t('logs.liveOff')}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-50',
              tailing
                ? 'border-transparent bg-success-soft text-success'
                : 'border-line bg-surface text-ink-muted hover:bg-surface-2',
            )}
          >
            <Radio size={13} aria-hidden className={tailing ? 'animate-pulse' : undefined} />
            {t('logs.live')}
          </button>

          <Button
            size="sm"
            variant="ghost"
            loading={loading}
            aria-label={t('common.refresh')}
            onClick={() => {
              void runQuery()
            }}
            iconLeft={<RefreshCw size={14} />}
          />
        </div>

        {result !== null && (result.truncated || result.malformedLines > 0) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line bg-warning-soft/50 px-3 py-2 text-[12.5px] text-ink-muted">
            {result.truncated && <span>{t('logs.truncated')}</span>}
            {result.malformedLines > 0 && (
              <span>{t('logs.malformed', { count: result.malformedLines })}</span>
            )}
          </div>
        )}

        <div ref={scrollRef} className="h-[calc(100vh-24rem)] min-h-64 overflow-y-auto">
          {entries.length === 0 ? (
            <EmptyState
              icon={<ScrollText size={22} />}
              title={isFiltered ? t('logs.empty') : t('logs.emptyFile')}
              {...(isFiltered ? { description: t('logs.emptyHint') } : {})}
            />
          ) : (
            <div style={{ height: range.totalHeight }}>
              <div style={{ transform: `translateY(${range.paddingTop}px)` }}>
                {entries.slice(range.startIndex, range.endIndex).map((entry) => (
                  <LogRow
                    key={entry.id}
                    entry={entry}
                    height={rowHeight}
                    selected={selected?.id === entry.id}
                    onSelect={setSelected}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="text-numeric flex items-center justify-between border-t border-line px-3 py-2 text-[12px] text-ink-subtle">
          <span>
            {t('logs.entryCount', {
              shown: entries.length,
              // Records tailed since the last query are not in the file's match
              // count yet, so they have to be added or the footer reads
              // "11 of 7".
              total: (result?.total ?? 0) + liveEntries.length,
            })}
          </span>
          {result !== null && result.scannedBytes > 0 && (
            <span>{format.bytes(result.scannedBytes)}</span>
          )}
        </div>
      </Card>

      {selected !== null && (
        <LogDetail
          entry={selected}
          onCopy={() => {
            onCopyEntry(selected)
          }}
          onClose={() => {
            setSelected(null)
          }}
        />
      )}

      <CrashReports />
    </div>
  )
}

const LEVEL_TEXT_STYLES: Record<LogLevel, string> = {
  error: 'text-danger',
  warn: 'text-warning',
  info: 'text-info',
  debug: 'text-ink-subtle',
}

const LEVEL_TONES: Record<LogLevel, BadgeTone> = {
  error: 'danger',
  warn: 'warning',
  info: 'info',
  debug: 'neutral',
}

function LogRow({
  entry,
  height,
  selected,
  onSelect,
}: {
  entry: LogEntry
  height: number
  selected: boolean
  onSelect: (entry: LogEntry) => void
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onSelect(entry)
      }}
      style={{ height }}
      className={cn(
        'flex w-full items-center gap-3 border-b border-line/60 px-3 text-left font-mono text-[12px] transition-colors last:border-b-0',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="text-numeric w-20 shrink-0 text-ink-subtle">
        {formatLogTimestamp(entry.timestamp)}
      </span>
      <span className={cn('w-12 shrink-0 font-semibold uppercase', LEVEL_TEXT_STYLES[entry.level])}>
        {entry.level}
      </span>
      <span className="w-40 shrink-0 truncate text-ink-muted">{entry.scope}</span>
      <span className="min-w-0 flex-1 truncate text-ink">{entry.message}</span>
      {entry.meta !== null && (
        <Badge dense tone="neutral" className="shrink-0 font-sans">
          meta
        </Badge>
      )}
    </button>
  )
}

function LogDetail({
  entry,
  onCopy,
  onClose,
}: {
  entry: LogEntry
  onCopy: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <Card className="animate-slide-up">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={LEVEL_TONES[entry.level]}>{entry.level}</Badge>
            <span className="text-numeric text-[12.5px] text-ink-muted">
              {formatTimestamp(entry.timestamp)}
            </span>
            <span className="text-[12.5px] text-ink-subtle">
              {t('logs.scope')}: {entry.scope}
            </span>
          </div>

          <p className="selectable mt-2 font-mono text-[13px] break-words text-ink">
            {entry.message}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" iconLeft={<Copy size={14} />} onClick={onCopy}>
            {t('common.copy')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>

      {entry.meta !== null && (
        <div className="mt-3">
          <p className="mb-1.5 text-[12px] font-medium text-ink-muted">{t('logs.metadata')}</p>
          <pre className="selectable max-h-56 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-muted">
            {prettifyMeta(entry.meta)}
          </pre>
        </div>
      )}
    </Card>
  )
}

/** One-line, copy-ready rendering of a record. */
function serializeEntry(entry: LogEntry): string {
  return [
    formatTimestamp(entry.timestamp),
    entry.level.toUpperCase(),
    `[${entry.scope}]`,
    entry.message,
    entry.meta ?? '',
  ]
    .filter((part) => part.length > 0)
    .join(' ')
}

/**
 * Re-indent stored metadata for display.
 *
 * Metadata is persisted as a compact JSON string. If it will not parse — it may
 * have been truncated by the serialiser's size cap — the raw text is shown
 * rather than an error, because a truncated payload is still worth reading.
 */
function prettifyMeta(meta: string): string {
  try {
    // eslint-disable-next-line no-restricted-syntax -- display-only re-formatting; failure falls back to the raw string
    return JSON.stringify(JSON.parse(meta), null, 2)
  } catch {
    return meta
  }
}
