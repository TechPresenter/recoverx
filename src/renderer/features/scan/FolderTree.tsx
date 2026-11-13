import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, FolderOpen, HardDrive } from 'lucide-react'
import type { FolderNode } from '@shared/types/scan'
import { useFormatters } from '@/hooks/useFormatters'
import { cn } from '@/lib/cn'

/**
 * Folder navigation for scan results.
 *
 * The repository returns a flat list of distinct paths; the hierarchy is rebuilt
 * here. Doing it in the renderer keeps the SQL a single `GROUP BY` and means
 * intermediate folders that contain no files of their own — common after a
 * recursive delete — still appear as branches rather than vanishing.
 */

const PATH_SEPARATOR = '\\'

interface TreeNode {
  readonly path: string
  readonly name: string
  readonly children: TreeNode[]
  /** Files directly in this folder. */
  ownFiles: number
  /** Files in this folder and everything beneath it. */
  totalFiles: number
  totalBytes: number
}

export interface FolderTreeProps {
  readonly folders: readonly FolderNode[]
  readonly selectedPath: string | null
  readonly onSelect: (path: string | null) => void
  readonly totalFiles: number
}

export function FolderTree({ folders, selectedPath, onSelect, totalFiles }: FolderTreeProps) {
  const { t } = useTranslation()
  const roots = useMemo(() => buildTree(folders), [folders])

  return (
    <nav aria-label={t('scan.folderTree')} className="text-[12.5px]">
      <FolderButton
        label={t('scan.allFolders')}
        count={totalFiles}
        depth={0}
        icon={<HardDrive size={14} aria-hidden />}
        selected={selectedPath === null}
        onSelect={() => {
          onSelect(null)
        }}
      />

      {roots.map((node) => (
        <TreeBranch
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </nav>
  )
}

function TreeBranch({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  // Top-level folders start open; deeper ones do not, so a deeply nested scan
  // does not present a wall of rows on first render.
  const [expanded, setExpanded] = useState(depth === 0)
  const format = useFormatters()

  const hasChildren = node.children.length > 0

  return (
    <div>
      <FolderButton
        label={node.name}
        count={node.totalFiles}
        detail={format.bytes(node.totalBytes)}
        depth={depth}
        selected={selectedPath === node.path}
        icon={
          hasChildren ? (
            <ChevronRight
              size={13}
              aria-hidden
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
          ) : (
            <span className="w-[13px]" aria-hidden />
          )
        }
        leading={
          expanded && hasChildren ? (
            <FolderOpen size={14} aria-hidden className="text-ink-subtle" />
          ) : (
            <Folder size={14} aria-hidden className="text-ink-subtle" />
          )
        }
        onSelect={() => {
          onSelect(node.path)
        }}
        onToggle={
          hasChildren
            ? () => {
                setExpanded((value) => !value)
              }
            : undefined
        }
        expanded={hasChildren ? expanded : undefined}
      />

      {expanded &&
        node.children.map((child) => (
          <TreeBranch
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
    </div>
  )
}

function FolderButton({
  label,
  count,
  detail,
  depth,
  selected,
  icon,
  leading,
  onSelect,
  onToggle,
  expanded,
}: {
  label: string
  count: number
  detail?: string
  depth: number
  selected: boolean
  icon?: React.ReactNode
  leading?: React.ReactNode
  onSelect: () => void
  // Explicitly `| undefined`: under exactOptionalPropertyTypes an optional prop
  // does not accept an explicitly-passed undefined without it.
  onToggle?: (() => void) | undefined
  expanded?: boolean | undefined
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md pr-2 transition-colors',
        selected ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2',
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      {onToggle !== undefined ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={label}
          className="grid size-5 shrink-0 place-items-center text-ink-subtle hover:text-ink"
        >
          {icon}
        </button>
      ) : (
        <span className="grid size-5 shrink-0 place-items-center text-ink-subtle">{icon}</span>
      )}

      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
      >
        {leading}
        <span className={cn('truncate', selected ? 'font-medium' : 'text-ink')}>{label}</span>
        <span className="text-numeric ml-auto shrink-0 text-[11.5px] text-ink-subtle">
          {detail === undefined ? count : `${count} · ${detail}`}
        </span>
      </button>
    </div>
  )
}

/**
 * Rebuild the folder hierarchy from flat paths.
 *
 * Intermediate segments are created on demand, so a result at
 * `Users\Anna\Pictures` produces `Users` and `Users\Anna` as branches even when
 * neither directly contains a file. Totals are rolled up to every ancestor.
 */
export function buildTree(folders: readonly FolderNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  const ensure = (path: string): TreeNode => {
    const existing = byPath.get(path)
    if (existing !== undefined) return existing

    const segments = path.split(PATH_SEPARATOR)
    const node: TreeNode = {
      path,
      name: segments.at(-1) ?? path,
      children: [],
      ownFiles: 0,
      totalFiles: 0,
      totalBytes: 0,
    }

    byPath.set(path, node)

    if (segments.length === 1) {
      roots.push(node)
    } else {
      ensure(segments.slice(0, -1).join(PATH_SEPARATOR)).children.push(node)
    }

    return node
  }

  for (const folder of folders) {
    // The root has an empty path and is represented by the "All folders" entry.
    if (folder.path.length === 0) continue

    const node = ensure(folder.path)
    node.ownFiles = folder.fileCount

    // Roll the totals up through every ancestor.
    const segments = folder.path.split(PATH_SEPARATOR)
    for (let depth = segments.length; depth > 0; depth -= 1) {
      const ancestor = byPath.get(segments.slice(0, depth).join(PATH_SEPARATOR))
      if (ancestor === undefined) continue

      ancestor.totalFiles += folder.fileCount
      ancestor.totalBytes += folder.totalSizeBytes
    }
  }

  const sortRecursive = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const node of nodes) sortRecursive(node.children)
  }

  sortRecursive(roots)

  return roots
}
