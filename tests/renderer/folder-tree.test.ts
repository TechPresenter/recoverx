import { describe, expect, it } from 'vitest'
import { buildTree } from '@/features/scan/FolderTree'
import type { FolderNode } from '@shared/types/scan'

const SEP = '\\'

function folder(path: string, fileCount: number, totalSizeBytes = fileCount * 100): FolderNode {
  return {
    path,
    name: path.split(SEP).at(-1) ?? '',
    fileCount,
    deletedCount: 0,
    totalSizeBytes,
  }
}

describe('buildTree', () => {
  it('nests folders by path segment', () => {
    const roots = buildTree([
      folder('Pictures', 2),
      folder(`Pictures${SEP}2025`, 3),
      folder('Documents', 1),
    ])

    expect(roots.map((node) => node.name)).toEqual(['Documents', 'Pictures'])

    const pictures = roots.find((node) => node.name === 'Pictures')
    expect(pictures?.children.map((child) => child.name)).toEqual(['2025'])
  })

  it('creates intermediate branches that hold no files of their own', () => {
    // After a recursive delete, only the leaf carries results — but the path to
    // it must still be navigable.
    const roots = buildTree([folder(`Users${SEP}Anna${SEP}Pictures`, 5)])

    expect(roots).toHaveLength(1)
    expect(roots[0]?.name).toBe('Users')
    expect(roots[0]?.ownFiles).toBe(0)

    const anna = roots[0]?.children[0]
    expect(anna?.name).toBe('Anna')

    const pictures = anna?.children[0]
    expect(pictures?.name).toBe('Pictures')
    expect(pictures?.ownFiles).toBe(5)
  })

  it('rolls totals up to every ancestor', () => {
    const roots = buildTree([
      folder('Pictures', 2, 200),
      folder(`Pictures${SEP}2025`, 3, 300),
      folder(`Pictures${SEP}2025${SEP}Raw`, 4, 400),
    ])

    const pictures = roots[0]
    expect(pictures?.totalFiles).toBe(9)
    expect(pictures?.totalBytes).toBe(900)

    const year = pictures?.children[0]
    expect(year?.totalFiles).toBe(7)
    expect(year?.totalBytes).toBe(700)

    const raw = year?.children[0]
    expect(raw?.totalFiles).toBe(4)
  })

  it('does not merge folders that merely share a name prefix', () => {
    const roots = buildTree([folder('Pictures', 1), folder('PicturesOld', 1)])

    expect(roots.map((node) => node.name)).toEqual(['Pictures', 'PicturesOld'])
    expect(roots.every((node) => node.children.length === 0)).toBe(true)
  })

  it('skips the volume root, which the All folders entry represents', () => {
    const roots = buildTree([folder('', 7), folder('Pictures', 1)])

    expect(roots.map((node) => node.name)).toEqual(['Pictures'])
  })

  it('sorts siblings by name at every depth', () => {
    const roots = buildTree([
      folder(`Media${SEP}zeta`, 1),
      folder(`Media${SEP}alpha`, 1),
      folder('Zoo', 1),
      folder('Apple', 1),
    ])

    expect(roots.map((node) => node.name)).toEqual(['Apple', 'Media', 'Zoo'])
    expect(roots[1]?.children.map((child) => child.name)).toEqual(['alpha', 'zeta'])
  })

  it('returns nothing for an empty result set', () => {
    expect(buildTree([])).toEqual([])
  })
})
