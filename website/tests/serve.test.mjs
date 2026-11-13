/* eslint-disable @typescript-eslint/no-floating-promises -- node:test's describe() and it() return promises that the test runner itself awaits. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The preview server, run the way it is run by hand: as its own process, on
 * a free port. What matters most is that no request can end it — a crash
 * shows up as a refused connection on the request after the one that caused
 * it, so each test asks again after a miss and checks the process is still
 * running.
 */

const SERVE = join(dirname(fileURLToPath(import.meta.url)), '..', 'serve.mjs')

/** @type {Array<() => void>} */
const cleanups = []
after(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

/**
 * A temporary folder holding `files` (path → content).
 *
 * @param {Record<string, string>} files
 */
function folder(files) {
  const directory = mkdtempSync(join(tmpdir(), 'recoverx-serve-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return directory
}

/**
 * Start serve.mjs on `directory` and resolve once it is listening.
 *
 * @param {string} directory
 */
function start(directory) {
  const child = spawn(process.execPath, [SERVE, '--port', '0', '--dir', directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanups.push(() => child.kill())

  return /** @type {Promise<{ url: (path: string) => string, running: () => boolean }>} */ (
    new Promise((resolve, reject) => {
      let output = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (/** @type {string} */ chunk) => {
        output += chunk
        const base = /at (http:\/\/127\.0\.0\.1:\d+)\//u.exec(output)?.[1]
        if (base !== undefined) {
          resolve({ url: (path) => `${base}${path}`, running: () => child.exitCode === null })
        }
      })
      child.stderr.on('data', (/** @type {string} */ chunk) => {
        output += chunk
      })
      child.on('exit', (code) => {
        reject(new Error(`serve.mjs exited (${String(code)}) before listening:\n${output}`))
      })
    })
  )
}

/**
 * GET `url` and read the whole answer. Redirects are not followed.
 *
 * @param {string} url
 * @returns {Promise<{ status: number, type: string | undefined, location: string | undefined, body: string }>}
 */
function get(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (/** @type {string} */ chunk) => {
        body += chunk
      })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          type: response.headers['content-type'],
          location: response.headers.location,
          body,
        })
      })
      response.on('error', reject)
    }).on('error', reject)
  })
}

describe('serve.mjs', () => {
  it('answers a miss in plain text when the folder has no 404.html, and keeps serving', async () => {
    const server = await start(folder({ 'index.html': '<!doctype html><title>Home</title>' }))

    // Browsers ask for /favicon.ico on their own: the first miss of any preview.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await get(server.url('/favicon.ico'))
      assert.equal(response.status, 404)
      assert.equal(response.type, 'text/plain; charset=utf-8')
      assert.equal(response.body, 'Not found\n')
    }

    const home = await get(server.url('/'))
    assert.equal(home.status, 200)
    assert.match(home.body, /<title>Home<\/title>/u)
    assert.ok(server.running(), 'the server must still be running')
  })

  it("serves the build's 404.html for a miss when there is one", async () => {
    const server = await start(
      folder({ 'index.html': '<!doctype html>', '404.html': '<!doctype html><h1>Lost</h1>' }),
    )

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await get(server.url('/no-such-page/'))
      assert.equal(response.status, 404)
      assert.equal(response.type, 'text/html; charset=utf-8')
      assert.match(response.body, /<h1>Lost<\/h1>/u)
    }
    assert.ok(server.running(), 'the server must still be running')
  })

  it('serves /name/ from its index.html and redirects /name to it', async () => {
    const server = await start(
      folder({
        'index.html': '<!doctype html>',
        'buy/index.html': '<!doctype html><h1>Buy</h1>',
        'assets/site.css': 'p{}',
      }),
    )

    const page = await get(server.url('/buy/'))
    assert.equal(page.status, 200)
    assert.match(page.body, /<h1>Buy<\/h1>/u)

    const bare = await get(server.url('/buy'))
    assert.equal(bare.status, 301)
    assert.equal(bare.location, '/buy/')

    // A folder without an index.html is a miss, not a listing.
    const empty = await get(server.url('/assets/'))
    assert.equal(empty.status, 404)
    assert.ok(server.running(), 'the server must still be running')
  })
})
