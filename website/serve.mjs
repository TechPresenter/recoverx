#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath } from 'node:url'

/**
 * Preview the built website locally.
 *
 *     node website/serve.mjs [--port 4173] [--dir dist/website]
 *
 * Serves the build the way the live host does for the parts that matter to
 * how pages look and link: `/name/` serves `/name/index.html`, `/name`
 * redirects to `/name/` (as Apache's mod_dir does), and anything missing gets
 * `404.html` with a 404 status — or a plain-text "Not found" when the folder
 * has no 404.html, so any folder with an index.html can be previewed.
 * Listens on 127.0.0.1 only (`--port 0` picks a free port). For previewing,
 * not hosting: there is no caching, compression or range support.
 */

const WEBSITE_DIR = dirname(fileURLToPath(import.meta.url))

const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
})

/**
 * @param {readonly string[]} argv
 */
function parseArguments(argv) {
  let port = 4173
  let directory = join(dirname(WEBSITE_DIR), 'dist', 'website')

  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1]
    if (argv[index] === '--port' && value !== undefined) port = Number(value)
    else if (argv[index] === '--dir' && value !== undefined) directory = resolve(value)
    else {
      process.stderr.write('Usage: node website/serve.mjs [--port 4173] [--dir dist/website]\n')
      process.exit(1)
    }
  }

  return { port, directory }
}

const { port, directory } = parseArguments(process.argv.slice(2))

if (!existsSync(join(directory, 'index.html'))) {
  process.stderr.write(`No build in ${directory}. Run \`npm run website:build\` first.\n`)
  process.exit(1)
}

/**
 * Map a request path to a file inside the build, or `null`. Never outside it:
 * the path is normalised and must still start with the build directory.
 *
 * @param {string} pathname
 * @returns {string | null}
 */
function fileFor(pathname) {
  const target = normalize(join(directory, pathname))
  if (target !== directory && !target.startsWith(directory + sep)) return null
  return target
}

const server = createServer((request, response) => {
  /** @param {number} status @param {string} text */
  const sendText = (status, text) => {
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(`${text}\n`)
  }

  /**
   * Stream `file` with `status`. The headers wait for the file to open, so a
   * file that cannot be read — a folder with no 404.html (a design mock-up,
   * say, where the browser's own /favicon.ico request is the first miss), a
   * file deleted since it was looked up, one without read permission — is
   * answered in plain text instead of raising an unhandled stream 'error'
   * that would end the whole process. A read that fails after the headers
   * have gone out can only cut the response short.
   *
   * @param {number} status @param {string} file
   */
  const send = (status, file) => {
    const stream = createReadStream(file)
    stream.on('open', () => {
      response.writeHead(status, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      stream.pipe(response)
    })
    stream.on('error', (error) => {
      if (response.headersSent) {
        response.destroy()
        return
      }
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (code === 'ENOENT' || code === 'ENOTDIR') sendText(404, 'Not found')
      else sendText(500, `Cannot read the file: ${code ?? error.message}`)
    })
    // A client that goes away mid-file leaves nothing open behind it.
    response.on('close', () => stream.destroy())
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  } catch {
    pathname = '/'
  }

  const target = fileFor(pathname)
  if (target !== null && existsSync(target)) {
    if (statSync(target).isDirectory()) {
      if (!pathname.endsWith('/')) {
        response.writeHead(301, { Location: `${pathname}/` })
        response.end()
        return
      }
      const index = join(target, 'index.html')
      if (existsSync(index)) {
        send(200, index)
        return
      }
    } else {
      send(200, target)
      return
    }
  }

  // The site's own 404 page when the build has one; a plain "Not found"
  // otherwise (see `send`).
  send(404, join(directory, '404.html'))
})

server.on('error', (error) => {
  const busy = /** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE'
  process.stderr.write(
    busy
      ? `Port ${port} is already in use. Try --port <another>.\n`
      : `Cannot serve: ${error.message}\n`,
  )
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  // The port actually bound, so `--port 0` (any free port, as the tests use)
  // prints a usable address.
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  process.stdout.write(`Serving ${directory} at http://127.0.0.1:${bound}/\n`)
})
