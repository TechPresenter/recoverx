/* eslint-disable @typescript-eslint/no-floating-promises -- node:test's describe() and it() return promises that the test runner itself awaits. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countMarkdownHeadings, isSafeUrl, renderInline, renderMarkdown } from '../lib/markdown.mjs'

/**
 * The markdown converter publishes a legal document to the open web, so the
 * tests that matter most are the ones about what it refuses to do.
 *
 * Run with `node --test website/tests/`.
 */

/** @param {string} source */
const html = (source) => renderMarkdown(source).html.value

describe('markdown: safety', () => {
  it('prints raw HTML as text', () => {
    const out = html('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>')
    assert.ok(!out.includes('<script'))
    assert.ok(!out.includes('<img'))
    assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  })

  it('drops the target of a javascript: or data: link and keeps its text', () => {
    assert.equal(html('[click](javascript:alert(1))'), '<p>click</p>')
    assert.equal(html('[x](data:text/html,hi)'), '<p>x</p>')
    assert.equal(isSafeUrl('//evil.example/path'), false)
    assert.equal(isSafeUrl('JavaScript:alert(1)'), false)
  })

  it('cannot break out of an href', () => {
    const out = html('[x](https://example.com/"onmouseover=alert(1))')
    assert.ok(!/href="[^"]*"onmouseover/u.test(out))
    assert.ok(out.includes('&quot;onmouseover'))
  })

  it('cannot forge its own placeholders', () => {
    const out = renderInline('a 0 b `code`')
    assert.equal(out, 'a 0 b <code>code</code>')
  })

  it('removes HTML comments, which are notes to editors', () => {
    assert.equal(html('Public <!-- private note --> text'), '<p>Public  text</p>')
  })
})

describe('markdown: blocks', () => {
  it('gives every heading a unique id and reports it', () => {
    const doc = renderMarkdown('# Title\n\n## Data\n\n## Data\n\n### 4.1 Licence & keys')
    assert.deepEqual(
      doc.headings.map((heading) => [heading.level, heading.id]),
      [
        [1, 'title'],
        [2, 'data'],
        [2, 'data-2'],
        [3, '4-1-licence-keys'],
      ],
    )
    assert.ok(doc.html.value.includes('<h3 id="4-1-licence-keys">4.1 Licence &amp; keys</h3>'))
  })

  it('counts headings independently, ignoring fenced code', () => {
    const source = '# One\n\n```\n# not a heading\n```\n\n## Two\n\n#hashtag is not one'
    assert.equal(countMarkdownHeadings(source), 2)
    assert.equal(renderMarkdown(source).headings.length, 2)
  })

  it('keeps line breaks inside a paragraph', () => {
    assert.equal(
      html('**Effective date:** 1 May\n**Last updated:** 2 May'),
      '<p><strong>Effective date:</strong> 1 May<br>\n<strong>Last updated:</strong> 2 May</p>',
    )
  })

  it('renders tables with alignment, escaped pipes, and a label from the heading above', () => {
    const out = html('## Kept\n\n| Data | Days |\n| --- | ---: |\n| a \\| b | 30 |\n| short |')
    assert.ok(out.includes('aria-labelledby="kept"'))
    assert.ok(out.includes('<th scope="col" class="align-right">Days</th>'))
    assert.ok(out.includes('<td>a | b</td><td class="align-right">30</td>'))
    // A short row is padded, not shifted.
    assert.ok(out.includes('<td>short</td><td class="align-right"></td>'))
  })

  it('renders tight and nested lists, and ordered lists that do not start at 1', () => {
    const out = html('- one\n- two\n  - nested\n- three\n\n3. third\n4. fourth')
    assert.equal(
      out,
      '<ul>\n<li>one</li>\n<li>two\n<ul>\n<li>nested</li>\n</ul></li>\n<li>three</li>\n</ul>\n' +
        '<ol start="3">\n<li>third</li>\n<li>fourth</li>\n</ol>',
    )
  })

  it('wraps the items of a loose list in paragraphs', () => {
    assert.equal(html('- one\n\n- two'), '<ul>\n<li><p>one</p></li>\n<li><p>two</p></li>\n</ul>')
  })

  it('renders blockquotes and fenced code', () => {
    assert.equal(
      html('> **Note** one\n>\n> two\n\n```\n<b>x</b>\n```'),
      '<blockquote>\n<p><strong>Note</strong> one</p>\n<p>two</p>\n</blockquote>\n<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>',
    )
  })
})

describe('markdown: inline', () => {
  it('handles emphasis without touching identifiers', () => {
    assert.equal(
      renderInline('**bold**, *em*, _em_ and snake_case_name'),
      '<strong>bold</strong>, <em>em</em>, <em>em</em> and snake_case_name',
    )
  })

  it('keeps code spans literal', () => {
    assert.equal(
      renderInline('`%APPDATA%\\RecoverX\\*logs*`'),
      '<code>%APPDATA%\\RecoverX\\*logs*</code>',
    )
  })

  it('links bare URLs without the sentence punctuation around them', () => {
    assert.equal(
      renderInline('See https://example.com/a. Or (https://example.com/b).'),
      'See <a href="https://example.com/a">https://example.com/a</a>. Or (<a href="https://example.com/b">https://example.com/b</a>).',
    )
  })

  it('links email addresses', () => {
    assert.equal(
      renderInline('Write to info@appsgain.in.'),
      'Write to <a href="mailto:info@appsgain.in">info@appsgain.in</a>.',
    )
  })

  it('renders links with inline markup in their text', () => {
    assert.equal(
      renderInline('[the **policy**](/privacy/)'),
      '<a href="/privacy/">the <strong>policy</strong></a>',
    )
  })
})
