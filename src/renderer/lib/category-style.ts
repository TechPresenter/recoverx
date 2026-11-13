import {
  Archive,
  Binary,
  Code,
  Database,
  DraftingCompass,
  FileText,
  Film,
  Image,
  Mail,
  Music,
  Palette,
  Presentation,
  Table,
  type LucideIcon,
} from 'lucide-react'
import type { FileCategory } from '@shared/types/scan'

/**
 * Colour and icon per file category.
 *
 * This is legibility rather than decoration. A results list runs to tens of
 * thousands of rows, and it is read by scanning down a column looking for one
 * thing — holiday photos, a spreadsheet, a video. Colour and shape are
 * pre-attentive: the eye finds a red row without reading it, and finds the word
 * "image" only by reading every row it passes. Giving each category a fixed
 * hue turns a linear read into a glance.
 *
 * Fourteen categories share six hues, grouped by what a user is actually
 * looking for. Fourteen distinguishable hues do not exist — past about eight,
 * neighbouring colours become confusable and the whole scheme stops working, so
 * grouping is the honest choice rather than inventing more shades.
 */

export type CategoryTone = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other'

interface CategoryStyle {
  readonly icon: LucideIcon
  readonly tone: CategoryTone
}

const STYLES: Readonly<Record<FileCategory, CategoryStyle>> = {
  image: { icon: Image, tone: 'image' },
  design: { icon: Palette, tone: 'image' },
  video: { icon: Film, tone: 'video' },
  audio: { icon: Music, tone: 'audio' },
  document: { icon: FileText, tone: 'document' },
  spreadsheet: { icon: Table, tone: 'document' },
  presentation: { icon: Presentation, tone: 'document' },
  email: { icon: Mail, tone: 'document' },
  archive: { icon: Archive, tone: 'archive' },
  database: { icon: Database, tone: 'archive' },
  code: { icon: Code, tone: 'other' },
  cad: { icon: DraftingCompass, tone: 'other' },
  executable: { icon: Binary, tone: 'other' },
  other: { icon: FileText, tone: 'other' },
}

/*
 * Written out rather than interpolated. Tailwind resolves class names by
 * scanning the source text, so a name built at runtime — `text-cat-${tone}` —
 * compiles to nothing at all and the colour silently disappears in the packaged
 * build while working perfectly in development.
 */
const FOREGROUND: Readonly<Record<CategoryTone, string>> = {
  image: 'text-cat-image',
  video: 'text-cat-video',
  audio: 'text-cat-audio',
  document: 'text-cat-document',
  archive: 'text-cat-archive',
  other: 'text-cat-other',
}

const CHIP: Readonly<Record<CategoryTone, string>> = {
  image: 'bg-cat-image-soft text-cat-image',
  video: 'bg-cat-video-soft text-cat-video',
  audio: 'bg-cat-audio-soft text-cat-audio',
  document: 'bg-cat-document-soft text-cat-document',
  archive: 'bg-cat-archive-soft text-cat-archive',
  other: 'bg-cat-other-soft text-cat-other',
}

export function categoryIcon(category: FileCategory): LucideIcon {
  return STYLES[category].icon
}

/** Text colour for an icon shown inline in a dense row. */
export function categoryTextClass(category: FileCategory): string {
  return FOREGROUND[STYLES[category].tone]
}

/** Filled chip, for the larger icon beside a heading or a filter. */
export function categoryChipClass(category: FileCategory): string {
  return CHIP[STYLES[category].tone]
}
