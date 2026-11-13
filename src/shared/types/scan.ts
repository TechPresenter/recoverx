import { z } from 'zod'

/**
 * Scan results.
 *
 * One `RecoveredFile` per recoverable item, whatever produced it — an NTFS MFT
 * record, a FAT directory entry, or a carved signature. Keeping a single shape
 * across sources is what lets the results grid, the preview pane and the
 * recovery pipeline stay unaware of which filesystem a file came from.
 */

/** Broad file class, used for filtering, icons and preview selection. */
export const FileCategorySchema = z.enum([
  'image',
  'video',
  'audio',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'database',
  'email',
  'code',
  'cad',
  'design',
  'executable',
  'other',
])
export type FileCategory = z.infer<typeof FileCategorySchema>

/**
 * How likely this file is to come back intact.
 *
 * This is the single most useful column in a recovery product: it is the
 * difference between a user restoring forty files that work and four hundred
 * that do not. It is derived from concrete evidence — whether the metadata
 * survived, whether the clusters are still marked free, whether the record was
 * damaged — never from a guess.
 */
export const RecoveryQualitySchema = z.enum(['excellent', 'good', 'fair', 'poor', 'unknown'])
export type RecoveryQuality = z.infer<typeof RecoveryQualitySchema>

/** Which subsystem produced the entry. Drives how recovery reads the data. */
export const RecoverySourceSchema = z.enum([
  'ntfs-mft',
  'ntfs-resident',
  'fat-directory',
  'exfat-directory',
  'carved',
])
export type RecoverySource = z.infer<typeof RecoverySourceSchema>

/** One contiguous extent of the device holding part of a file. */
export const FileExtentSchema = z.object({
  offsetBytes: z.number(),
  lengthBytes: z.number(),
})
export type FileExtent = z.infer<typeof FileExtentSchema>

export const RecoveredFileSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** File name without a path. */
  name: z.string(),
  /** Reconstructed parent path, `\` separated. Empty for the volume root. */
  path: z.string(),
  /** Lower-case, without the dot. Empty when the name has no extension. */
  extension: z.string(),
  category: FileCategorySchema,
  sizeBytes: z.number(),
  isDeleted: z.boolean(),
  isDirectory: z.boolean(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  accessedAt: z.number().nullable(),
  quality: RecoveryQualitySchema,
  source: RecoverySourceSchema,
  /**
   * Where the contents live, in device-absolute byte offsets.
   *
   * Empty for a directory, or for a file whose extents could not be
   * reconstructed — the latter is still worth listing, because its name and
   * size tell the user what was lost even when the data is gone.
   */
  extents: z.array(FileExtentSchema),
  /** Content stored inside the metadata record itself (small NTFS files). */
  hasResidentData: z.boolean(),
  isFragmented: z.boolean(),
  isCompressed: z.boolean(),
  isEncrypted: z.boolean(),
})

export type RecoveredFile = z.infer<typeof RecoveredFileSchema>

// --- Extension classification ----------------------------------------------

/**
 * Extension to category.
 *
 * Deliberately broad rather than exhaustive: the categories exist so a user can
 * narrow "everything on a 2 TB drive" down to "my photos", and an unrecognised
 * extension landing in `other` is a far better outcome than a mis-filed one.
 */
const CATEGORY_BY_EXTENSION: Readonly<Record<string, FileCategory>> = {
  // Images, including the RAW formats a camera-card user is looking for.
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  webp: 'image',
  heic: 'image',
  heif: 'image',
  avif: 'image',
  svg: 'image',
  ico: 'image',
  cr2: 'image',
  cr3: 'image',
  nef: 'image',
  arw: 'image',
  dng: 'image',
  orf: 'image',
  raf: 'image',
  rw2: 'image',
  pef: 'image',
  srw: 'image',
  raw: 'image',

  // Video
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  wmv: 'video',
  flv: 'video',
  webm: 'video',
  m4v: 'video',
  mpg: 'video',
  mpeg: 'video',
  '3gp': 'video',
  mts: 'video',
  m2ts: 'video',
  insv: 'video',

  // Audio
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  wma: 'audio',
  m4a: 'audio',
  aiff: 'audio',
  opus: 'audio',
  mid: 'audio',

  // Documents
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  txt: 'document',
  md: 'document',
  pages: 'document',
  epub: 'document',

  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  ods: 'spreadsheet',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  numbers: 'spreadsheet',

  ppt: 'presentation',
  pptx: 'presentation',
  odp: 'presentation',
  key: 'presentation',

  // Archives
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  iso: 'archive',
  cab: 'archive',
  dmg: 'archive',

  // Databases
  db: 'database',
  sqlite: 'database',
  sqlite3: 'database',
  mdb: 'database',
  accdb: 'database',
  sql: 'database',
  bak: 'database',
  dbf: 'database',

  // Email
  pst: 'email',
  ost: 'email',
  eml: 'email',
  msg: 'email',
  mbox: 'email',

  // Source code
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  cs: 'code',
  go: 'code',
  rs: 'code',
  rb: 'code',
  php: 'code',
  swift: 'code',
  kt: 'code',
  html: 'code',
  css: 'code',
  json: 'code',
  xml: 'code',
  yml: 'code',
  yaml: 'code',
  sh: 'code',
  ps1: 'code',

  // CAD and design
  dwg: 'cad',
  dxf: 'cad',
  step: 'cad',
  stp: 'cad',
  iges: 'cad',
  stl: 'cad',
  skp: 'cad',
  rvt: 'cad',
  psd: 'design',
  ai: 'design',
  indd: 'design',
  xd: 'design',
  fig: 'design',
  sketch: 'design',
  afphoto: 'design',
  afdesign: 'design',
  cdr: 'design',

  // Executables
  exe: 'executable',
  dll: 'executable',
  msi: 'executable',
  apk: 'executable',
  deb: 'executable',
  rpm: 'executable',
  app: 'executable',
}

/** Extract a lower-case extension, without the dot. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')

  // A leading dot is a hidden file, not an extension: ".gitignore" has none.
  if (dot <= 0 || dot === fileName.length - 1) return ''

  return fileName.slice(dot + 1).toLowerCase()
}

/** Classify a file by its extension. */
export function categoryOf(fileName: string): FileCategory {
  return CATEGORY_BY_EXTENSION[extensionOf(fileName)] ?? 'other'
}

/** Every category, in the order the filter UI presents them. */
export const FILE_CATEGORY_ORDER: readonly FileCategory[] = [
  'image',
  'video',
  'audio',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'database',
  'email',
  'code',
  'cad',
  'design',
  'executable',
  'other',
]

// --- Scan sessions ---------------------------------------------------------

/** Metadata scan (fast, filesystem-driven) versus signature carving. */
export const ScanTypeSchema = z.enum(['quick', 'deep'])
export type ScanType = z.infer<typeof ScanTypeSchema>

export const ScanStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
])
export type ScanStatus = z.infer<typeof ScanStatusSchema>

export const ScanSessionSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  /** `null` when the whole device was scanned rather than one partition. */
  partitionId: z.string().nullable(),
  deviceModel: z.string(),
  volumeLabel: z.string().nullable(),
  fileSystem: z.string(),
  scanType: ScanTypeSchema,
  status: ScanStatusSchema,
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  filesFound: z.number(),
  /** Total size of everything found, for the "recoverable" headline figure. */
  bytesFound: z.number(),
  processed: z.number(),
  total: z.number(),
  errorMessage: z.string().nullable(),
})

export type ScanSession = z.infer<typeof ScanSessionSchema>

export const ScanProgressSchema = z.object({
  sessionId: z.string(),
  status: ScanStatusSchema,
  processed: z.number(),
  total: z.number(),
  filesFound: z.number(),
  bytesFound: z.number(),
  elapsedMs: z.number(),
  /** `null` until the sample is large enough to be meaningful. */
  estimatedRemainingMs: z.number().nullable(),
  filesPerSecond: z.number(),
})

export type ScanProgress = z.infer<typeof ScanProgressSchema>

// --- Result queries --------------------------------------------------------

export const FileSortFieldSchema = z.enum(['name', 'path', 'size', 'modified', 'quality'])
export type FileSortField = z.infer<typeof FileSortFieldSchema>

export const FileFilterSchema = z.object({
  sessionId: z.string(),
  /** Case-insensitive substring match on the file name. */
  search: z.string().optional(),
  categories: z.array(FileCategorySchema).optional(),
  qualities: z.array(RecoveryQualitySchema).optional(),
  extensions: z.array(z.string()).optional(),
  /**
   * Restrict to a folder and everything beneath it.
   *
   * Empty string means the volume root, which matches everything — so it is
   * treated as "no folder filter" rather than as a literal prefix.
   */
  pathPrefix: z.string().optional(),
  deletedOnly: z.boolean().optional(),
  includeDirectories: z.boolean().optional(),
  minSizeBytes: z.number().optional(),
  maxSizeBytes: z.number().optional(),
  modifiedAfter: z.number().optional(),
  modifiedBefore: z.number().optional(),
  sortBy: FileSortFieldSchema,
  sortDirection: z.enum(['asc', 'desc']),
  limit: z.number().int().min(1).max(2000),
  offset: z.number().int().min(0),
})

export type FileFilter = z.infer<typeof FileFilterSchema>

export const FileQueryResultSchema = z.object({
  files: z.array(RecoveredFileSchema),
  /** Matches before pagination. */
  total: z.number(),
  /** Count per category across the whole filtered set, for the sidebar chips. */
  categoryCounts: z.record(FileCategorySchema, z.number()),
  totalSizeBytes: z.number(),
})

export type FileQueryResult = z.infer<typeof FileQueryResultSchema>

// --- Folder tree -----------------------------------------------------------

export const FolderNodeSchema = z.object({
  /** Full path from the volume root, `\` separated. Empty for the root. */
  path: z.string(),
  /** Final segment, for display. */
  name: z.string(),
  /** Files directly in this folder, excluding sub-folders. */
  fileCount: z.number(),
  deletedCount: z.number(),
  totalSizeBytes: z.number(),
})

export type FolderNode = z.infer<typeof FolderNodeSchema>

// --- Selection -------------------------------------------------------------

/**
 * Which results the user has chosen.
 *
 * Two modes, because "select all" on a scan that found two million files cannot
 * mean shipping two million ids to the main process and back:
 *
 *  - `include` — the listed ids, and nothing else. Used for hand-picking.
 *  - `exclude` — everything matching `filter`, minus the listed ids. Used after
 *    "select all", so unticking a handful stays cheap.
 *
 * The set is resolved in SQL at the moment it is needed, which also means a
 * selection stays correct while a scan is still adding rows.
 */
export const SelectionSchema = z.object({
  mode: z.enum(['include', 'exclude']),
  /** Bounded so a hostile or runaway renderer cannot send an unbounded list. */
  ids: z.array(z.string()).max(50_000),
  /** The filter in force when the selection was made. */
  filter: FileFilterSchema,
})

export type Selection = z.infer<typeof SelectionSchema>

export const SelectionSummarySchema = z.object({
  count: z.number(),
  totalSizeBytes: z.number(),
})

export type SelectionSummary = z.infer<typeof SelectionSummarySchema>

/** An empty selection in include mode — nothing chosen. */
export function emptySelection(filter: FileFilter): Selection {
  return { mode: 'include', ids: [], filter }
}

/** `true` when the selection cannot match anything. */
export function isSelectionEmpty(selection: Selection): boolean {
  return selection.mode === 'include' && selection.ids.length === 0
}

/**
 * Whether a specific file is part of the selection.
 *
 * Pure, so the results grid can render tick states without a round trip.
 */
export function isSelected(selection: Selection, id: string): boolean {
  const listed = selection.ids.includes(id)
  return selection.mode === 'include' ? listed : !listed
}

/** Toggle one file, keeping the mode intact. */
export function toggleSelection(selection: Selection, id: string): Selection {
  const listed = selection.ids.includes(id)

  return {
    ...selection,
    ids: listed ? selection.ids.filter((value) => value !== id) : [...selection.ids, id],
  }
}

// --- Preview ---------------------------------------------------------------

/** How the renderer should present the content it was given. */
export const PreviewKindSchema = z.enum(['image', 'text', 'media', 'binary'])
export type PreviewKind = z.infer<typeof PreviewKindSchema>

/**
 * Whether the recovered bytes are what the file name claims.
 *
 * `unknown` is a first-class answer, not a failure: a .txt file has no magic
 * bytes, and reporting it as corrupt would be a lie.
 */
export const ContentVerdictSchema = z.enum(['match', 'mismatch', 'unknown', 'empty'])
export type ContentVerdict = z.infer<typeof ContentVerdictSchema>

export const PreviewFactSchema = z.object({
  label: z.string(),
  value: z.string(),
})
export type PreviewFact = z.infer<typeof PreviewFactSchema>

export const FilePreviewSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  kind: PreviewKindSchema,
  verdict: ContentVerdictSchema,
  /** Format identified from the bytes, independent of the extension. */
  detectedLabel: z.string().nullable(),
  /** `true` when the leading bytes are all zero — the data is gone. */
  isBlank: z.boolean(),
  /** `true` when the extension is one that carries no signature to check. */
  signatureUnavailable: z.boolean(),
  /** `data:` URL the renderer can put straight into an `img`/`video` element. */
  mediaDataUrl: z.string().nullable(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  textEncoding: z.string().nullable(),
  /** Always present: the first bytes, as hex and ASCII. */
  hexDump: z.string(),
  bytesRead: z.number(),
  facts: z.array(PreviewFactSchema),
})

export type FilePreview = z.infer<typeof FilePreviewSchema>
