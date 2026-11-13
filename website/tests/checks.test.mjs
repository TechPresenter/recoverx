/* eslint-disable @typescript-eslint/no-floating-promises -- node:test's describe() and it() return promises that the test runner itself awaits. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { checkWellFormed, verifySite } from '../lib/checks.mjs'
import { compareVersions } from '../lib/content.mjs'
import { markup, trusted } from '../lib/html.mjs'

/** A minimal page that passes every structural check, around `body`. */
/** @param {string} body */
const page = (body) =>
  `<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Title</h1>${body}</main></body></html>`

describe('markup', () => {
  it('escapes strings, keeps markup, flattens arrays and skips empty values', () => {
    const name = 'Tom & "Jerry" <b>'
    const out = markup`<p title="${name}">${name}${trusted('<br>')}${[1, ['a', false]]}${null}</p>`
    assert.equal(
      out.value,
      '<p title="Tom &amp; &quot;Jerry&quot; &lt;b&gt;">Tom &amp; &quot;Jerry&quot; &lt;b&gt;<br>1a</p>',
    )
  })

  it('refuses to print an object', () => {
    assert.throws(() => markup`${[{}]}`, TypeError)
  })
})

describe('checkWellFormed', () => {
  it('accepts a well-formed page, with self-closing SVG children', () => {
    const svg = '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'
    assert.deepEqual(checkWellFormed(page(`<h2 id="a">A</h2><p>x &amp; y</p>${svg}`)), [])
  })

  for (const [name, body, expected] of /** @type {const} */ ([
    ['an unclosed element', '<div><p>x</p>', 'unclosed'],
    ['misnesting', '<p><strong>x</p></strong>', 'closes <strong>'],
    ['a bare ampersand', '<p>R&D</p>', 'bare "&"'],
    ['a stray <', '<p>1 < 2</p>', 'does not start a tag'],
    ['a duplicate id', '<p id="x">a</p><p id="x">b</p>', 'duplicate id'],
    ['a block inside a paragraph', '<p><div>x</div></p>', 'inside <p>'],
    ['a skipped heading level', '<h3>x</h3>', 'skipped'],
    ['a self-closed HTML element', '<div/>', 'not a void element'],
    ['a repeated attribute', '<a href="/" href="/x">x</a>', 'repeats href'],
    ['an inline style', '<p style="color:red">x</p>', 'has style='],
    ['an event handler', '<a href="/" onclick="x()">x</a>', 'has onclick='],
    ['a script element', '<script>x()</script>', '<script>'],
    ['a style element', '<style>p{}</style>', '<style>'],
  ])) {
    it(`reports ${name}`, () => {
      const problems = checkWellFormed(page(body))
      assert.ok(
        problems.some((problem) => problem.includes(expected)),
        `expected "${expected}" in ${JSON.stringify(problems)}`,
      )
    })
  }
})

describe('verifySite', () => {
  const root = mkdtempSync(join(tmpdir(), 'rx-site-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  /** @param {string} file @param {string} content */
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }

  const origin = 'https://example.test'
  put(
    'index.html',
    page('<h2 id="top">x</h2><a href="/buy/">buy</a><a href="/buy/#plans">plans</a>'),
  )
  put(
    'buy/index.html',
    page('<h2 id="plans">Plans</h2><a href="/downloads/win/1.0.0/a.exe">dl</a>'),
  )
  put('robots.txt', `Sitemap: ${origin}/sitemap.xml\n`)
  put(
    'sitemap.xml',
    `<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/buy/</loc></url></urlset>`,
  )

  it('passes a consistent site, without checking separately published downloads', () => {
    assert.deepEqual(verifySite(root, origin).problems, [])
  })

  it('finds broken links, missing anchors, missing slashes, reserved paths and sitemap gaps', () => {
    put(
      'support/index.html',
      page(
        '<a href="/nowhere/">a</a><a href="/buy/#missing">b</a><a href="/buy">c</a><a href="javascript:x()">d</a>',
      ),
    )
    put('v1/index.html', page(''))
    const problems = verifySite(root, origin).problems.join('\n')
    assert.match(problems, /"\/nowhere\/" leads nowhere/u)
    assert.match(problems, /#missing, which \/buy\/ does not have/u)
    assert.match(problems, /"\/buy" should end with "\/"/u)
    assert.match(problems, /javascript: target/u)
    assert.match(problems, /reserved path \/v1\//u)
    assert.match(problems, /sitemap.xml does not list \/support\//u)
  })
})

describe('compareVersions', () => {
  it('compares numerically, with pre-releases first', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
    assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0)
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  })
})
