import { describe, expect, it } from 'vitest'
import { createRedactor } from '@main/diagnostics/redaction'
import { normaliseNotes } from '@main/updates/release-notes'

/**
 * Crash-report redaction and release-note sanitising.
 *
 * Both are boundaries where text from somewhere else reaches a place it should
 * not: a stack trace carries the user's identity out of the machine, and
 * release notes carry a server's markup into a privileged page.
 */

describe('crash report redaction', () => {
  const redact = createRedactor('C:\\Users\\jsmith', 'jsmith')

  it('removes the home directory from a stack trace', () => {
    // Every bundled file's path contains it, and it contains the user's name.
    const trace = 'at load (C:\\Users\\jsmith\\AppData\\Local\\RecoverX\\out\\main\\index.js:12)'

    expect(redact(trace)).toBe('at load (<home>\\AppData\\Local\\RecoverX\\out\\main\\index.js:12)')
  })

  it('removes the home directory whichever separator produced it', () => {
    // Node writes backslashes on Windows; Chromium frequently writes forward
    // slashes for the same path, and a redactor that only knows one leaks.
    expect(redact('at x (C:/Users/jsmith/app/index.js:1)')).toContain('<home>')
  })

  it('ignores the case Windows does not care about', () => {
    expect(redact('c:\\users\\JSmith\\file.js')).toBe('<home>\\file.js')
  })

  it('removes the account name outside the home directory', () => {
    // Temporary paths sit under C:\Windows\Temp and never touch the home
    // directory, but still carry the account name.
    expect(redact('C:\\Windows\\Temp\\jsmith\\scan.tmp')).toBe(
      'C:\\Windows\\Temp\\<user>\\scan.tmp',
    )
  })

  it('does not shred a word that merely contains the account name', () => {
    // A username like "sam" would otherwise corrupt every "same" in a trace.
    const shortRedact = createRedactor('', 'sam')

    expect(shortRedact('the same value')).toBe('the same value')
    expect(shortRedact('at C:\\Temp\\sam\\x.js')).toContain('<user>')
  })

  it('leaves a trace with nothing private in it alone', () => {
    const trace = 'TypeError: Cannot read property of undefined\n    at readMft (ntfs.js:412:9)'

    expect(redact(trace)).toBe(trace)
  })

  it('survives a home directory containing regular expression characters', () => {
    // Not exotic: a Windows account name can legitimately contain a dot or
    // parentheses, and an unescaped one would silently match the wrong text.
    const odd = createRedactor('C:\\Users\\a.b (work)', 'a.b')

    expect(odd('C:\\Users\\a.b (work)\\file.js')).toBe('<home>\\file.js')
    expect(odd('C:\\Users\\axb (work)\\file.js')).toContain('axb')
  })

  it('does nothing when it knows nothing to remove', () => {
    const none = createRedactor('', '')

    expect(none('C:\\Users\\someone\\file.js')).toBe('C:\\Users\\someone\\file.js')
  })

  it('removes every occurrence, not just the first', () => {
    const trace = 'C:\\Users\\jsmith\\a.js\n  C:\\Users\\jsmith\\b.js'

    expect(redact(trace)).not.toContain('jsmith')
  })
})

describe('release notes', () => {
  it('strips markup rather than rendering it', () => {
    // Release notes come from an update server. A page with IPC access must not
    // treat a server as a trusted source of markup.
    const notes = '<h2>Fixes</h2><p>Faster NTFS scanning</p><script>steal()</script>'

    const text = normaliseNotes(notes) ?? ''

    expect(text).not.toContain('<')
    expect(text).not.toContain('script')
    expect(text).toContain('Faster NTFS scanning')
  })

  it('joins the per-version entries some feeds return', () => {
    const text = normaliseNotes([
      { version: '1.1.0', note: 'Second change' },
      { version: '1.0.1', note: 'First change' },
    ])

    expect(text).toContain('Second change')
    expect(text).toContain('First change')
  })

  it('decodes the entities a stripped tag leaves behind', () => {
    expect(normaliseNotes('Fixed a &lt;div&gt; crash &amp; a leak')).toBe(
      'Fixed a <div> crash & a leak',
    )
  })

  it('reports nothing when there is nothing to say', () => {
    expect(normaliseNotes(null)).toBeNull()
    expect(normaliseNotes('')).toBeNull()
    expect(normaliseNotes('<p></p>')).toBeNull()
  })

  it('handles an entry with no note at all', () => {
    expect(normaliseNotes([{ version: '1.0.0', note: null }])).toBeNull()
  })
})
