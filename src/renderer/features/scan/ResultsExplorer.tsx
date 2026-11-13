import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileSearch, Trash2 } from 'lucide-react'
import { IpcChannel } from '@shared/ipc/channels'
import type { RecoveryJob } from '@shared/types/recovery'
import {
  FILE_CATEGORY_ORDER,
  emptySelection,
  isSelected,
  isSelectionEmpty,
  toggleSelection,
  type FileCategory,
  type FileFilter,
  type FolderNode,
  type RecoveredFile,
  type RecoveryQuality,
  type Selection,
  type SelectionSummary,
} from '@shared/types/scan'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { SegmentedControl, type Segment } from '@/components/ui/SegmentedControl'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { useFormatters } from '@/hooks/useFormatters'
import { useVirtualRows } from '@/hooks/useVirtualRows'
import { cn } from '@/lib/cn'
import { categoryIcon, categoryTextClass } from '@/lib/category-style'
import { invoke } from '@/lib/ipc-client'
import { useLiveQuery } from '@/hooks/useLiveQuery'
import { toast } from '@/stores/ui.store'
import { FilterPanel, applyAdvancedFilters, countActiveFilters } from './FilterPanel'
import { FolderTree } from './FolderTree'
import { PreviewPane } from './PreviewPane'
import { RecoveryDialog } from '@/features/recovery/RecoveryDialog'
import { RecoveryProgressPanel } from '@/features/recovery/RecoveryProgressPanel'

/**
 * Scan results.
 *
 * Filtering, sorting, paging and selection sizing all happen in SQLite — the
 * renderer never holds more than one page. A scan of a large volume produces
 * millions of rows, and shipping those across the IPC boundary to filter them in
 * JavaScript would exhaust the renderer's heap before the user finished typing.
 *
 * Rows are virtualised on top of that, so even a full page mounts only the
 * handful of nodes actually on screen.
 */

const ROW_HEIGHT = 40
const PAGE_SIZE = 200
const MAX_PAGE = 2000
const SEARCH_DEBOUNCE_MS = 220

export interface ResultsExplorerProps {
  readonly sessionId: string
  /** Bumped by the parent when the scan reports new results. */
  readonly revision: number
}

export function ResultsExplorer({ sessionId, revision }: ResultsExplorerProps) {
  const { t } = useTranslation()
  const format = useFormatters()
  const scrollRef = useRef<HTMLDivElement>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [category, setCategory] = useState<FileCategory | 'all'>('all')
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [deletedOnly, setDeletedOnly] = useState(true)
  const [sortBy, setSortBy] = useState<FileFilter['sortBy']>('quality')
  const [sortDirection, setSortDirection] = useState<FileFilter['sortDirection']>('asc')

  const [filtersOpen, setFiltersOpen] = useState(false)
  const [qualities, setQualities] = useState<readonly RecoveryQuality[]>([])
  const [minSize, setMinSize] = useState('')
  const [maxSize, setMaxSize] = useState('')
  const [modifiedAfter, setModifiedAfter] = useState('')
  const [modifiedBefore, setModifiedBefore] = useState('')
  const [extensions, setExtensions] = useState('')

  const [limit, setLimit] = useState(PAGE_SIZE)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryJob, setRecoveryJob] = useState<RecoveryJob | null>(null)

  const advanced = useMemo(
    () => ({ qualities, minSize, maxSize, modifiedAfter, modifiedBefore, extensions }),
    [qualities, minSize, maxSize, modifiedAfter, modifiedBefore, extensions],
  )

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search)
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      clearTimeout(handle)
    }
  }, [search])

  const filter = useMemo<FileFilter>(() => {
    const base: FileFilter = {
      sessionId,
      sortBy,
      sortDirection,
      limit,
      offset: 0,
      ...(debouncedSearch.trim().length > 0 ? { search: debouncedSearch.trim() } : {}),
      ...(category === 'all' ? {} : { categories: [category] }),
      ...(folderPath === null ? {} : { pathPrefix: folderPath }),
      ...(deletedOnly ? { deletedOnly: true } : {}),
    }

    return applyAdvancedFilters(base, advanced)
  }, [
    sessionId,
    sortBy,
    sortDirection,
    limit,
    debouncedSearch,
    category,
    folderPath,
    deletedOnly,
    advanced,
  ])

  const [selection, setSelection] = useState<Selection>(() => emptySelection(filter))
  const [selectionSummary, setSelectionSummary] = useState<SelectionSummary>({
    count: 0,
    totalSizeBytes: 0,
  })

  // A changed filter invalidates the current page; start again from the top.
  useEffect(() => {
    setLimit(PAGE_SIZE)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [debouncedSearch, category, folderPath, deletedOnly, sortBy, sortDirection, advanced])

  /*
   * All three queries below coalesce rather than queue. During a scan the
   * revision changes several times a second while the main process is busy
   * scanning, and issuing a fresh request on each tick builds a backlog that
   * eventually times out — requests failing because they waited, not because
   * they were slow. `useLiveQuery` keeps at most one of each in flight.
   */
  const { data: result, loading } = useLiveQuery(async () => {
    const response = await invoke(IpcChannel.ScanQueryFiles, filter)

    if (!response.ok) {
      toast.error(response.error.message, response.error.details)
      return null
    }

    return response.data
  }, [filter, revision])

  const { data: folderData } = useLiveQuery(async () => {
    const response = await invoke(IpcChannel.ScanListFolders, { sessionId })
    return response.ok ? response.data : null
  }, [sessionId, revision])

  // An unanswered query and an empty result render the same way, and the tree
  // needs a list either way.
  const folders: readonly FolderNode[] = folderData ?? []

  // The summary is re-derived from the database rather than counted locally, so
  // "select all" stays accurate across millions of rows the page never holds.
  useEffect(() => {
    void (async () => {
      if (isSelectionEmpty(selection)) {
        setSelectionSummary({ count: 0, totalSizeBytes: 0 })
        return
      }

      const response = await invoke(IpcChannel.ScanSummariseSelection, selection)
      if (response.ok) setSelectionSummary(response.data)
    })()
  }, [selection])

  const files = result?.files ?? []
  const range = useVirtualRows(scrollRef, { count: files.length, rowHeight: ROW_HEIGHT })

  const categorySegments = useMemo<Array<Segment<FileCategory | 'all'>>>(() => {
    const counts: Partial<Record<FileCategory, number>> = result?.categoryCounts ?? {}
    const present = FILE_CATEGORY_ORDER.filter((value) => (counts[value] ?? 0) > 0)

    return [
      { value: 'all', label: t('scan.categoryAll'), count: result?.total ?? 0 },
      ...present.map((value) => ({
        value,
        label: categoryLabel(value, t),
        count: counts[value] ?? 0,
      })),
    ]
  }, [result, t])

  const toggleSort = useCallback(
    (field: FileFilter['sortBy']) => {
      if (field === sortBy) {
        setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
        return
      }
      setSortBy(field)
      // Size and date are most useful largest/newest first; text is not.
      setSortDirection(field === 'size' || field === 'modified' ? 'desc' : 'asc')
    },
    [sortBy],
  )

  const clearAdvanced = useCallback(() => {
    setQualities([])
    setMinSize('')
    setMaxSize('')
    setModifiedAfter('')
    setModifiedBefore('')
    setExtensions('')
  }, [])

  if (recoveryJob !== null) {
    return (
      <RecoveryProgressPanel
        job={recoveryJob}
        onDone={() => {
          setRecoveryJob(null)
          setSelection(emptySelection(filter))
        }}
      />
    )
  }

  if (recoveryOpen) {
    return (
      <RecoveryDialog
        selection={selection}
        summary={selectionSummary}
        onStarted={(job) => {
          setRecoveryOpen(false)
          setRecoveryJob(job)
        }}
        onClose={() => {
          setRecoveryOpen(false)
        }}
      />
    )
  }

  return (
    <div
      className={cn(
        'grid gap-4',
        previewId === null ? 'lg:grid-cols-[16rem_1fr]' : 'lg:grid-cols-[14rem_1fr_20rem]',
      )}
    >
      <Card className="hidden max-h-[36rem] overflow-y-auto lg:block">
        <FolderTree
          folders={folders}
          selectedPath={folderPath}
          onSelect={setFolderPath}
          totalFiles={folders.reduce((total, folder) => total + folder.fileCount, 0)}
        />
      </Card>

      <Card flush className="min-w-0 overflow-hidden">
        <div className="space-y-3 border-b border-line p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
              placeholder={t('scan.searchPlaceholder')}
              aria-label={t('scan.searchPlaceholder')}
              className="min-w-[12rem] flex-1"
            />

            <Switch
              checked={deletedOnly}
              onCheckedChange={setDeletedOnly}
              label={t('scan.filterDeleted')}
            />
          </div>

          <FilterPanel
            open={filtersOpen}
            onOpenChange={setFiltersOpen}
            qualities={qualities}
            onQualitiesChange={setQualities}
            minSize={minSize}
            maxSize={maxSize}
            onMinSizeChange={setMinSize}
            onMaxSizeChange={setMaxSize}
            modifiedAfter={modifiedAfter}
            modifiedBefore={modifiedBefore}
            onModifiedAfterChange={setModifiedAfter}
            onModifiedBeforeChange={setModifiedBefore}
            extensions={extensions}
            onExtensionsChange={setExtensions}
            activeCount={countActiveFilters(advanced)}
            onClear={clearAdvanced}
          />

          {categorySegments.length > 1 && (
            <SegmentedControl
              value={category}
              segments={categorySegments}
              onValueChange={setCategory}
              ariaLabel={t('scan.resultsTitle')}
              size="sm"
            />
          )}

          {result !== null && (
            <p className="text-numeric text-[12px] text-ink-muted">
              {t('scan.resultsSummary', {
                count: result.total,
                size: format.bytes(result.totalSizeBytes),
              })}
            </p>
          )}
        </div>

        <SelectionBar
          summary={selectionSummary}
          empty={isSelectionEmpty(selection)}
          onRecover={() => {
            setRecoveryOpen(true)
          }}
          onSelectAll={() => {
            // Exclude mode with no exclusions means "everything the filter
            // matches", which needs no ids at all.
            setSelection({ mode: 'exclude', ids: [], filter })
          }}
          onClear={() => {
            setSelection(emptySelection(filter))
          }}
        />

        <HeaderRow sortBy={sortBy} sortDirection={sortDirection} onSort={toggleSort} />

        {loading && result === null ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            className="py-14"
            icon={<FileSearch size={22} />}
            title={t('scan.noResults')}
            description={t('scan.noResultsHint')}
          />
        ) : (
          <>
            <div ref={scrollRef} className="max-h-[26rem] overflow-y-auto">
              <div style={{ paddingTop: range.paddingTop, paddingBottom: range.paddingBottom }}>
                {files.slice(range.startIndex, range.endIndex).map((file) => (
                  <ResultRow
                    key={file.id}
                    file={file}
                    checked={isSelected(selection, file.id)}
                    active={file.id === previewId}
                    onToggle={() => {
                      setSelection((current) => toggleSelection(current, file.id))
                    }}
                    onOpen={() => {
                      setPreviewId(file.id)
                    }}
                  />
                ))}
              </div>
            </div>

            {result !== null && files.length < result.total && (
              <button
                type="button"
                className="w-full border-t border-line py-2.5 text-[12.5px] font-medium text-accent hover:bg-surface-2"
                onClick={() => {
                  setLimit((current) => Math.min(current + PAGE_SIZE, MAX_PAGE))
                }}
              >
                {t('scan.loadMore')}
              </button>
            )}
          </>
        )}
      </Card>

      <PreviewPane
        fileId={previewId}
        onClose={() => {
          setPreviewId(null)
        }}
      />
    </div>
  )
}

function SelectionBar({
  summary,
  empty,
  onSelectAll,
  onClear,
  onRecover,
}: {
  summary: SelectionSummary
  empty: boolean
  onSelectAll: () => void
  onClear: () => void
  onRecover: () => void
}) {
  const { t } = useTranslation()
  const format = useFormatters()

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2">
      <Button size="sm" variant="ghost" onClick={onSelectAll}>
        {t('scan.selectAll')}
      </Button>

      {!empty && (
        <>
          <span className="text-numeric text-[12px] font-medium text-ink">
            {t('scan.selectedSummary', {
              count: summary.count,
              size: format.bytes(summary.totalSizeBytes),
            })}
          </span>

          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('scan.clearSelection')}
          </Button>

          <Button size="sm" className="ml-auto" onClick={onRecover}>
            {t('scan.recoverSelected')}
          </Button>
        </>
      )}
    </div>
  )
}

function HeaderRow({
  sortBy,
  sortDirection,
  onSort,
}: {
  sortBy: FileFilter['sortBy']
  sortDirection: FileFilter['sortDirection']
  onSort: (field: FileFilter['sortBy']) => void
}) {
  const { t } = useTranslation()

  const columns: Array<{ field: FileFilter['sortBy']; label: string; className: string }> = [
    { field: 'name', label: t('scan.colName'), className: 'flex-1 min-w-0 text-left' },
    {
      field: 'path',
      label: t('scan.colPath'),
      className: 'w-40 shrink-0 hidden xl:block text-left',
    },
    { field: 'size', label: t('scan.colSize'), className: 'w-24 shrink-0 text-right' },
    {
      field: 'modified',
      label: t('scan.colModified'),
      className: 'w-32 shrink-0 hidden md:block text-left',
    },
    { field: 'quality', label: t('scan.colQuality'), className: 'w-24 shrink-0 text-left' },
  ]

  return (
    <div className="flex items-center gap-3 bg-surface-2 px-4 py-2 text-[11.5px] tracking-wide text-ink-subtle uppercase">
      {/* Spacer matching the row checkbox, so headings line up with their data. */}
      <span className="w-4 shrink-0" aria-hidden />

      {columns.map((column) => (
        <button
          key={column.field}
          type="button"
          onClick={() => {
            onSort(column.field)
          }}
          aria-sort={
            sortBy === column.field
              ? sortDirection === 'asc'
                ? 'ascending'
                : 'descending'
              : 'none'
          }
          className={cn(
            'font-medium transition-colors hover:text-ink',
            column.className,
            sortBy === column.field && 'text-ink',
          )}
        >
          {column.label}
          {sortBy === column.field && (
            <span aria-hidden>{sortDirection === 'asc' ? ' ↑' : ' ↓'}</span>
          )}
        </button>
      ))}
    </div>
  )
}

function ResultRow({
  file,
  checked,
  active,
  onToggle,
  onOpen,
}: {
  file: RecoveredFile
  checked: boolean
  active: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const format = useFormatters()
  const CategoryIcon = categoryIcon(file.category)

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-line/60 px-4 text-[12.5px]',
        active ? 'bg-accent-soft/50' : 'hover:bg-surface-2/60',
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={t('scan.selectRow', { name: file.name })}
        className="size-4 shrink-0 accent-[var(--rx-accent)]"
      />

      {/* The name opens the preview. A button rather than a row-level click
          handler, so keyboard users reach it in the normal tab order. */}
      <button
        type="button"
        onClick={onOpen}
        title={t('preview.open', { name: file.name })}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {/* Colour and shape identify the kind of file before the name is
            read at all, which is what makes a list of this length scannable. */}
        <CategoryIcon
          size={14}
          aria-hidden
          className={cn('shrink-0', categoryTextClass(file.category))}
        />
        {file.isDeleted && (
          <Trash2 size={13} aria-label={t('scan.deletedBadge')} className="shrink-0 text-warning" />
        )}
        <span className="truncate text-ink">{file.name}</span>
      </button>

      <span className="hidden w-40 shrink-0 truncate text-ink-muted xl:block">
        {file.path.length > 0 ? file.path : '—'}
      </span>

      <span className="text-numeric w-24 shrink-0 text-right text-ink-muted">
        {format.bytes(file.sizeBytes)}
      </span>

      <span className="text-numeric hidden w-32 shrink-0 text-ink-muted md:block">
        {file.modifiedAt === null ? '—' : format.timestamp(file.modifiedAt)}
      </span>

      {/* The tooltip carries the evidence behind the score, so a bare adjective
          is never the only thing the user has to go on. */}
      <span className="w-24 shrink-0" title={qualityHint(file.quality, t)}>
        <Badge dense tone={qualityTone(file.quality)}>
          {qualityLabel(file.quality, t)}
        </Badge>
      </span>
    </div>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

/**
 * Explicit mapping rather than an interpolated key: the translation types are
 * derived from the English locale, and a computed key defeats that check.
 */
function categoryLabel(category: FileCategory, t: Translate): string {
  switch (category) {
    case 'image':
      return t('scan.categoryImage')
    case 'video':
      return t('scan.categoryVideo')
    case 'audio':
      return t('scan.categoryAudio')
    case 'document':
      return t('scan.categoryDocument')
    case 'spreadsheet':
      return t('scan.categorySpreadsheet')
    case 'presentation':
      return t('scan.categoryPresentation')
    case 'archive':
      return t('scan.categoryArchive')
    case 'database':
      return t('scan.categoryDatabase')
    case 'email':
      return t('scan.categoryEmail')
    case 'code':
      return t('scan.categoryCode')
    case 'cad':
      return t('scan.categoryCad')
    case 'design':
      return t('scan.categoryDesign')
    case 'executable':
      return t('scan.categoryExecutable')
    case 'other':
      return t('scan.categoryOther')
  }
}

function qualityLabel(quality: RecoveryQuality, t: Translate): string {
  switch (quality) {
    case 'excellent':
      return t('scan.qualityExcellent')
    case 'good':
      return t('scan.qualityGood')
    case 'fair':
      return t('scan.qualityFair')
    case 'poor':
      return t('scan.qualityPoor')
    case 'unknown':
      return t('scan.qualityUnknown')
  }
}

function qualityHint(quality: RecoveryQuality, t: Translate): string {
  switch (quality) {
    case 'excellent':
      return t('scan.qualityHintExcellent')
    case 'good':
      return t('scan.qualityHintGood')
    case 'fair':
      return t('scan.qualityHintFair')
    case 'poor':
      return t('scan.qualityHintPoor')
    case 'unknown':
      return t('scan.qualityHintUnknown')
  }
}

function qualityTone(quality: RecoveryQuality): BadgeTone {
  switch (quality) {
    case 'excellent':
      return 'success'
    case 'good':
      return 'accent'
    case 'fair':
      return 'warning'
    case 'poor':
      return 'danger'
    case 'unknown':
      return 'neutral'
  }
}
