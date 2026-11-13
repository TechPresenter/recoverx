import type { UpdateInfo } from 'electron-updater'

/**
 * Reduce release notes to plain text.
 *
 * The updater hands back a string, or an array of per-version entries, or null,
 * depending on the feed. The renderer displays this, so anything HTML-shaped is
 * stripped rather than rendered — release notes come from a server, and a
 * server is not a trusted source of markup for a page with IPC access.
 */
export function normaliseNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (notes === null || notes === undefined) return null

  const raw =
    typeof notes === 'string' ? notes : notes.map((entry) => entry.note ?? '').join('\n\n')

  const text = raw
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

  return text.length === 0 ? null : text
}
