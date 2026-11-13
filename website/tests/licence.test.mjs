/* eslint-disable @typescript-eslint/no-floating-promises -- node:test's describe() and it() return promises that the test runner itself awaits. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { countLicenceSections, renderLicence } from '../lib/licence.mjs'
import { countMarkdownHeadings, renderMarkdown } from '../lib/markdown.mjs'

/**
 * The plain-text licence renderer, and the two real documents the site
 * publishes. The real ones are read from the repository on purpose: they are
 * edited by people who will never run the website build, and these tests are
 * what tells them a change broke the published page.
 */

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')

const SAMPLE = `Product — End User Licence Agreement
Copyright © 2026 Example Ltd.

1. GRANT OF LICENCE
   You may use the software in accordance with your edition:

     Free        Evaluation use. Recovery is capped at 1 GiB of restored
                 data, in total.
     Professional Unlimited recovery on personal devices.
     Business    Unlimited recovery for one organisation.

2. RESTRICTIONS
   You may not:
   (a) sell the software;
   (b) remove notices.
   3. This numbered sentence is indented, so it is not a heading.

10. CONTACT
Contact: legal@example.com or https://example.com/terms.
`

describe('plain-text licence', () => {
  const rendered = renderLicence(SAMPLE)
  const out = rendered.html.value

  it('finds the title and every numbered section', () => {
    assert.deepEqual(
      rendered.headings.map((heading) => heading.text),
      [
        'Product — End User Licence Agreement',
        '1. GRANT OF LICENCE',
        '2. RESTRICTIONS',
        '10. CONTACT',
      ],
    )
    assert.equal(countLicenceSections(SAMPLE), 3)
    assert.ok(out.includes('<h2 id="section-10">10. CONTACT</h2>'))
  })

  it('reads the aligned edition table, including a term that fills its column', () => {
    assert.ok(out.includes('<dt>Professional</dt><dd>Unlimited recovery on personal devices.</dd>'))
    assert.ok(
      out.includes(
        '<dt>Free</dt><dd>Evaluation use. Recovery is capped at 1 GiB of restored data, in total.</dd>',
      ),
    )
  })

  it('rejoins hard-wrapped paragraphs and keeps clause letters', () => {
    assert.ok(out.includes('<p>You may use the software in accordance with your edition:</p>'))
    assert.ok(out.includes('<li>(a) sell the software;</li>'))
  })

  it('links addresses and escapes everything else', () => {
    assert.ok(out.includes('<a href="mailto:legal@example.com">legal@example.com</a>'))
    assert.ok(out.includes('<a href="https://example.com/terms">https://example.com/terms</a>.'))
    const hostile = renderLicence('Title\n\n1. TERMS\n   <script>x</script> *not emphasis*\n').html
      .value
    assert.ok(hostile.includes('&lt;script&gt;x&lt;/script&gt; *not emphasis*'))
  })

  it('does not mistake a paragraph with a double space for a table', () => {
    const prose = renderLicence(
      'Title\n\n1. TERMS\n   The first sentence ends here.  The second one\n   continues on the next line.\n',
    ).html.value
    assert.ok(
      prose.includes(
        '<p>The first sentence ends here.  The second one continues on the next line.</p>',
      ),
    )
  })

  it('hands a markdown licence to the markdown converter', () => {
    const markdown = renderLicence('# Terms\n\n## 1. Grant\n\n**Bold** text.')
    assert.equal(markdown.headings.length, 2)
    assert.ok(markdown.html.value.includes('<strong>Bold</strong>'))
  })
})

describe('the documents the site publishes', () => {
  it('renders every section of LICENSE', () => {
    const source = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8')
    const rendered = renderLicence(source)
    assert.equal(rendered.headings.length, countLicenceSections(source) + 1)
    assert.ok(countLicenceSections(source) >= 5, 'LICENSE should have numbered sections')
  })

  it('renders every heading of the privacy policy', () => {
    const source = readFileSync(join(REPO_ROOT, 'docs', 'store', 'privacy-policy.md'), 'utf8')
    const rendered = renderMarkdown(source)
    assert.equal(rendered.headings.length, countMarkdownHeadings(source))
    assert.equal(rendered.headings.filter((heading) => heading.level === 1).length, 1)
  })
})
