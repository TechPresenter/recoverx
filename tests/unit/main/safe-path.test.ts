import { describe, expect, it } from 'vitest'
import {
  FALLBACK_NAME,
  buildTargetSegments,
  isInsideRoot,
  sanitizeRelativePath,
  sanitizeSegment,
  uniqueName,
} from '@main/recovery/safe-path'

describe('sanitizeSegment', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitizeSegment('holiday photo.jpg')).toBe('holiday photo.jpg')
    expect(sanitizeSegment('Rapport financier — 2025.pdf')).toBe('Rapport financier — 2025.pdf')
  })

  it('replaces characters Windows forbids', () => {
    expect(sanitizeSegment('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt')
  })

  it('strips control characters', () => {
    // A partially overwritten name record decodes to these routinely.
    expect(sanitizeSegment('re\u0000port\u0007.txt')).toBe('re_port_.txt')
  })

  it('removes trailing dots and spaces', () => {
    // Windows drops them silently, which would collide two distinct files.
    expect(sanitizeSegment('report.  ')).toBe('report')
    expect(sanitizeSegment('name...')).toBe('name')
  })

  it('rejects relative components outright', () => {
    // The traversal vector. Must never survive as a usable segment.
    expect(sanitizeSegment('..')).toBe('')
    expect(sanitizeSegment('.')).toBe('')
  })

  it('escapes reserved device names, with or without an extension', () => {
    expect(sanitizeSegment('CON')).toBe('_CON')
    expect(sanitizeSegment('con.txt')).toBe('_con.txt')
    expect(sanitizeSegment('LPT1.log')).toBe('_LPT1.log')
    // Not reserved: only the exact device names are.
    expect(sanitizeSegment('console.log')).toBe('console.log')
  })

  it('returns empty when nothing usable remains', () => {
    expect(sanitizeSegment('   ')).toBe('')
    expect(sanitizeSegment('')).toBe('')
  })

  it('truncates an over-long name but keeps its extension', () => {
    // The extension decides which application opens the recovered file.
    const long = `${'a'.repeat(400)}.jpg`
    const result = sanitizeSegment(long)

    expect(result.length).toBeLessThanOrEqual(255)
    expect(result.endsWith('.jpg')).toBe(true)
  })

  it('truncates plainly when the trailing dot is not an extension', () => {
    const result = sanitizeSegment('b'.repeat(300))

    expect(result).toHaveLength(255)
  })
})

describe('sanitizeRelativePath', () => {
  it('splits on either separator', () => {
    expect(sanitizeRelativePath('Users\\Anna/Pictures')).toEqual(['Users', 'Anna', 'Pictures'])
  })

  it('drops traversal components rather than escaping them', () => {
    // The single most important assertion in this file: a recovered path must
    // never be able to climb above the destination the user chose.
    expect(sanitizeRelativePath('..\\..\\Windows\\System32')).toEqual(['Windows', 'System32'])
    expect(sanitizeRelativePath('../../../etc/passwd')).toEqual(['etc', 'passwd'])
    expect(sanitizeRelativePath('..')).toEqual([])
  })

  it('drops empty segments from doubled separators', () => {
    expect(sanitizeRelativePath('a\\\\b')).toEqual(['a', 'b'])
    expect(sanitizeRelativePath('')).toEqual([])
  })

  it('sanitises each segment independently', () => {
    expect(sanitizeRelativePath('my:folder\\CON')).toEqual(['my_folder', '_CON'])
  })
})

describe('buildTargetSegments', () => {
  it('places the file at the root when structure is not restored', () => {
    expect(
      buildTargetSegments('photo.jpg', 'Pictures\\2025', { restoreFolderStructure: false }),
    ).toEqual(['photo.jpg'])
  })

  it('recreates the folder hierarchy when asked', () => {
    expect(
      buildTargetSegments('photo.jpg', 'Pictures\\2025', { restoreFolderStructure: true }),
    ).toEqual(['Pictures', '2025', 'photo.jpg'])
  })

  it('groups by category when requested', () => {
    expect(
      buildTargetSegments('photo.jpg', 'Pictures', {
        restoreFolderStructure: false,
        groupByCategory: 'Images',
      }),
    ).toEqual(['Images', 'photo.jpg'])
  })

  it('combines grouping with structure', () => {
    expect(
      buildTargetSegments('photo.jpg', 'Pictures', {
        restoreFolderStructure: true,
        groupByCategory: 'Images',
      }),
    ).toEqual(['Images', 'Pictures', 'photo.jpg'])
  })

  it('never lets a hostile path escape, even with structure enabled', () => {
    expect(
      buildTargetSegments('x.dll', '..\\..\\Windows\\System32', { restoreFolderStructure: true }),
    ).toEqual(['Windows', 'System32', 'x.dll'])
  })

  it('falls back to a placeholder when the name sanitises away', () => {
    expect(buildTargetSegments('...', '', { restoreFolderStructure: false })).toEqual([
      FALLBACK_NAME,
    ])
  })
})

describe('uniqueName', () => {
  it('returns the name unchanged when it is free', () => {
    expect(uniqueName(new Set(), 'photo.jpg')).toBe('photo.jpg')
  })

  it('suffixes a collision in the Windows style', () => {
    // Two deleted files genuinely can share a name: created, deleted, created
    // again leaves two records. Overwriting one would silently lose it.
    expect(uniqueName(new Set(['photo.jpg']), 'photo.jpg')).toBe('photo (2).jpg')
  })

  it('keeps counting past an existing suffix', () => {
    const taken = new Set(['photo.jpg', 'photo (2).jpg', 'photo (3).jpg'])

    expect(uniqueName(taken, 'photo.jpg')).toBe('photo (4).jpg')
  })

  it('compares case-insensitively, as Windows does', () => {
    expect(uniqueName(new Set(['photo.jpg']), 'PHOTO.JPG')).toBe('PHOTO (2).JPG')
  })

  it('handles a name with no extension', () => {
    expect(uniqueName(new Set(['readme']), 'readme')).toBe('readme (2)')
  })

  it('handles a dotfile without treating it as an extension', () => {
    expect(uniqueName(new Set(['.gitignore']), '.gitignore')).toBe('.gitignore (2)')
  })
})

describe('isInsideRoot', () => {
  it('accepts a path genuinely under the root', () => {
    expect(isInsideRoot('D:\\Recovered', 'D:\\Recovered\\photo.jpg')).toBe(true)
    expect(isInsideRoot('D:\\Recovered', 'D:\\Recovered\\Pictures\\2025\\photo.jpg')).toBe(true)
  })

  it('rejects a sibling folder sharing a name prefix', () => {
    // Without the separator check, "D:\Recovered" would appear to contain
    // "D:\RecoveredElsewhere".
    expect(isInsideRoot('D:\\Recovered', 'D:\\RecoveredElsewhere\\x.txt')).toBe(false)
  })

  it('rejects an escape above the root', () => {
    expect(isInsideRoot('D:\\Recovered', 'D:\\Windows\\System32\\x.dll')).toBe(false)
    expect(isInsideRoot('D:\\Recovered', 'C:\\Recovered\\x.txt')).toBe(false)
  })

  it('rejects the root itself, which is a directory rather than a target', () => {
    expect(isInsideRoot('D:\\Recovered', 'D:\\Recovered')).toBe(false)
  })

  it('is case-insensitive and separator-agnostic, as Windows is', () => {
    expect(isInsideRoot('D:\\Recovered', 'd:\\recovered\\photo.jpg')).toBe(true)
    expect(isInsideRoot('D:/Recovered', 'D:\\Recovered\\photo.jpg')).toBe(true)
  })

  it('tolerates a trailing separator on the root', () => {
    expect(isInsideRoot('D:\\Recovered\\', 'D:\\Recovered\\photo.jpg')).toBe(true)
  })
})
