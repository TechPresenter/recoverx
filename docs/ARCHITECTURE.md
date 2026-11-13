# Architecture

RecoverX is a 64-bit Electron desktop application for Windows 10 and 11. This
document describes how it is put together and, more importantly, _why_ — the
decision records at the end capture the trade-offs that are not obvious from the
code.

---

## 1. Process model

Electron gives three execution contexts. RecoverX treats the boundary between
them as a genuine security boundary, not an implementation detail, because the
main process runs with an Administrator token and opens raw block devices.

```
┌─────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS — Node 24, elevated                                │
│                                                                 │
│  app/          bootstrap, lifecycle, windows, menu, metrics     │
│  config/       path and environment resolution                  │
│  database/     SQLite connection, migrations, repositories      │
│  ipc/          registry + handlers (validated dispatch)         │
│  logging/      Winston sinks, JSONL reader, live broadcaster    │
│  security/     app:// protocol, session hardening, path safety  │
│  services/     settings, system info, diagnostics               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ ipcMain.handle / webContents.send
┌───────────────────────────┴─────────────────────────────────────┐
│ PRELOAD — sandboxed, ~2 kB, zero dependencies                   │
│                                                                 │
│  contextBridge.exposeInMainWorld('recoverx', {                  │
│    invoke,      // channel-allowlisted, timeout-bounded         │
│    subscribe,   // event-allowlisted                            │
│  })                                                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │ window.recoverx
┌───────────────────────────┴─────────────────────────────────────┐
│ RENDERER — Chromium, sandboxed, no Node                         │
│                                                                 │
│  app/          router, error boundary                           │
│  components/   layout shell + UI primitives                     │
│  features/     one directory per screen                         │
│  hooks/ lib/ stores/ i18n/ styles/                              │
└─────────────────────────────────────────────────────────────────┘

              ┌───────────────────────────────────┐
              │ SHARED — compiled into all three  │
              │  ipc/       channels + contracts  │
              │  types/     Zod schemas           │
              │  utils/     result, errors, fmt   │
              │  constants/                       │
              └───────────────────────────────────┘
```

`src/shared` is enforced isomorphic by an ESLint rule: it may not import
Electron, Node built-ins or React. That guarantee is what lets the same schema
validate a payload on both sides of the bridge.

## 2. The IPC contract

Every channel is declared once, in `src/shared/ipc/`, with a Zod schema for its
request and its response:

```ts
[IpcChannel.SettingsUpdate]: {
  request: z.object({ patch: AppSettingsPatchSchema }),
  response: AppSettingsSchema,
}
```

TypeScript types are _inferred from those schemas_, so validation and
compilation cannot drift apart:

```ts
export type IpcRequest<C extends IpcChannelName> = z.infer<IpcContractMap[C]['request']>
```

`IpcRegistry` applies four guarantees uniformly, so no handler can forget one:

1. The sender is a window this process created.
2. The request matches its schema — malformed payloads are rejected before any
   handler code runs.
3. Thrown errors become `{ ok: false, error }`. The renderer never sees a
   rejected promise, and a stack trace never crosses the boundary.
4. Slow calls (>750 ms) are logged.

At the end of boot, `assertComplete()` fails startup if any declared channel has
no handler — turning a whole class of bug into a development-time crash.

### Errors are values

Nothing that crosses the bridge throws. Handlers return `Result<T>`:

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: SerializedError }
```

The renderer cannot read `.data` without narrowing on `.ok` first, which makes
failure handling a compile-time obligation rather than a convention.

## 3. Security model

The renderer displays data extracted from failed and potentially hostile disk
images — file names, EXIF metadata, document properties. It is assumed to be
compromisable, and confined accordingly.

| Control                                         | Implementation                                       |
| ----------------------------------------------- | ---------------------------------------------------- |
| Sandbox, context isolation, no Node integration | `window-manager.ts`                                  |
| Custom `app://` scheme instead of `file://`     | `security/app-protocol.ts`                           |
| Content Security Policy                         | `security/session-hardening.ts`, applied as a header |
| All device permissions denied                   | `session-hardening.ts`                               |
| Outbound requests blocked                       | `session-hardening.ts`                               |
| Navigation and `window.open` blocked            | `security/navigation-guard.ts`                       |
| External links host-allowlisted                 | `ALLOWED_EXTERNAL_HOSTS`                             |
| Path traversal guard on asset serving           | `app-protocol.ts`                                    |
| Write-probe validation of recovery targets      | `security/path-safety.ts`                            |

Two details worth calling out:

**Why `app://` and not `file://`.** A `file://` document has an opaque origin, so
`default-src 'self'` matches nothing useful and CSP becomes decorative. A
registered standard scheme gives the renderer a real origin, makes CSP
meaningful, keeps the async Clipboard API available, and confines every asset
request to the bundle directory.

**Why the protocol handler sets its own CSP header.** `webRequest.onHeadersReceived`
does not fire for responses produced by a `protocol.handle` handler. Relying on
it alone would leave the packaged build — and only the packaged build — running
with no policy. Both paths derive the policy from one function,
`buildContentSecurityPolicy`.

### Data-safety rules

These are product requirements, enforced in code:

- Source devices are opened read-only. Nothing is ever written to a device being
  recovered.
- The recovery destination is validated to exist, be a directory, and be
  genuinely writable — by creating and deleting a probe file, because
  `fs.access(W_OK)` on Windows reflects only the read-only attribute and ignores
  ACLs entirely.
- `isOnDifferentVolume()` is the precondition for any recovery job. Writing
  output to the source can overwrite the very sectors still holding unrecovered
  data.

## 4. Persistence

SQLite via `node:sqlite`, one file under `%APPDATA%\RecoverX\`.

- WAL journalling so a long read (the Logs screen) never blocks a write.
- Migrations are validated _before_ execution — contiguous, ascending, starting
  at 1 — and each runs in a transaction together with its own bookkeeping row,
  making a half-applied upgrade impossible.
- A database that fails `quick_check` is renamed aside and recreated. A user
  whose drive just failed is the most likely person to hold a corrupt settings
  file, and refusing to start is the worst possible response for them.

See [DATABASE.md](DATABASE.md).

## 5. Rendering and state

- **Routing** — `createHashRouter`. There is no server behind `app://`, so a
  history router would 404 on reload; the URL is invisible in a frameless window
  anyway.
- **State** — Zustand. Settings are mirrored from the main process, which owns
  the authoritative copy and broadcasts changes.
- **Theming** — CSS custom properties in OKLCH, mapped into Tailwind with
  `@theme inline`. Switching theme is one class change on `<html>`: no
  re-render, no flash.
- **Virtualisation** — a hand-written fixed-height virtualiser
  (`useVirtualRows`). Scan results will reach millions of rows.

### Startup budget

Target: interactive window in under 3 seconds cold. Measured on the development
machine: **~880 ms**, reported on the About screen so a regression is visible.

Boot is deliberately two-phase, because Chromium reads the hardware-acceleration
switch while creating the GPU process — before any window exists:

```
phase 1 (before app.whenReady)   paths → logging → SQLite → migrate → settings
                                 → apply Chromium switches → register app://
phase 2 (after app.whenReady)    session hardening → protocol handler → menu
                                 → window → IPC surface
```

Opening SQLite synchronously in phase 1 costs a few milliseconds and removes
every race between "the app is starting" and "settings are readable".

## 6. Recovery engine

The recovery engine is RecoverX's own TypeScript, in the main process. No
third-party recovery tool is wrapped, shipped or started: an early plan to drive
PhotoRec, TestDisk, The Sleuth Kit, smartmontools and ddrescue as child
processes was dropped, and nothing in the application depends on them.

| Layer            | Where                                         | What it does                                                                                                                            |
| ---------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Block access     | `disk/block-device.ts`                        | Opens `\\.\PhysicalDriveN` and volume handles read-only and hides sector alignment from callers. Nothing in it can write.               |
| Partition tables | `disk/mbr.ts`, `gpt.ts`, `partition-table.ts` | Parses MBR and GPT and identifies each partition's file system from its boot sector.                                                    |
| Lost partitions  | `disk/partition-finder.ts`                    | Finds NTFS, FAT, exFAT and ext volume headers at their fixed offsets and checks them against their backup copies. Never writes a table. |
| Quick scan       | `scan/ntfs/`, `scan/fat/`                     | Reads the NTFS Master File Table and FAT12/16/32 and exFAT directory entries, deleted ones included.                                    |
| Deep scan        | `scan/carve/`                                 | Signature carving of 21 file types, for when the file system's records are gone.                                                        |
| Preview          | `preview/`                                    | Bounded reads, content verification and a hex dump, before anything is recovered.                                                       |
| Recovery         | `recovery/`                                   | Writes only to a destination the guard has shown is not on the source device.                                                           |
| Drive health     | `health/`                                     | SMART and reliability counters from Windows' own providers (`MSStorageDriver_*`, `MSFT_PhysicalDisk`), queried through PowerShell.      |

Owning the engine is what lets every layer keep the same guarantees: one
read-only block reader under all of them, results streamed into SQLite as they
are found, and scans that pause and cancel cleanly. It also keeps the licensing
position simple — everything the installer ships is permissively licensed, as
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists. Bringing in a copyleft
engine later would change that position for the whole product, and needs
counsel before it is designed, not after.

---

## Decision records

### ADR-001 — `node:sqlite` over `better-sqlite3`

**Context.** The application needs an embedded, synchronous SQL database.
`better-sqlite3` is the conventional Electron choice.

**Problem.** `better-sqlite3` v13 publishes no Windows prebuilt binaries. Every
`npm install` compiles the SQLite amalgamation from source, requiring a ~6 GB
Visual Studio C++ toolchain on the developer machine and on every CI runner. It
was verified during this project that the install fails outright on a clean
Windows machine without MSVC.

A compiled addon is also bound to one ABI. Rebuilt for Electron it cannot be
loaded by a plain Node process, which forces all database coverage out of the
fast unit suite and into a slow end-to-end harness.

**Decision.** Use `node:sqlite`, compiled into the Node runtime Electron already
embeds.

**Verification.** Probed directly against Electron 43.2.0 / Node 24.18.0: WAL
journalling, `synchronous`, `foreign_keys`, `busy_timeout`, `temp_store`,
`cache_size`, prepared statements, transactions, upserts, `quick_check` and
`wal_checkpoint(TRUNCATE)` all behave as required.

**Consequences.**

- No native addons ship. No `postinstall` rebuild, no `asarUnpack`, no toolchain
  prerequisite, materially faster CI.
- The unit suite exercises the _real_ database — 31 integration tests covering
  migrations, transactions, rollback, savepoint nesting and corruption recovery.
- The API is narrower: no `.pragma()` or `.transaction()` helper and untyped
  result rows. `src/main/database/sqlite.ts` supplies all three.
- `node:sqlite` is marked experimental in Node. It is pinned to the Electron
  version the app ships and verified per upgrade; the single wrapper module
  keeps any future migration contained.

### ADR-002 — Zod schemas as the single source of truth

**Decision.** Declare IPC payloads and settings as Zod schemas; infer TypeScript
types from them.

**Rationale.** A hand-written type alongside a hand-written validator drifts. The
inference direction makes drift impossible: adding a field to the schema
immediately makes every incomplete construction a compile error.

**Consequence.** Zod is a runtime dependency of the main process. It is
deliberately kept _out_ of the renderer bundle: `RESTART_REQUIRED_SETTINGS` lives
in `shared/constants/settings-meta.ts` rather than beside the schemas, because
importing any runtime value from a schema module pulled 271 kB of Zod into the
renderer, which never validates anything.

### ADR-003 — Immediate-write settings, no Save button

**Decision.** Each settings control writes on change, through a validated IPC
round trip that either persists or reverts.

**Rationale.** A form-wide Save introduces a state where the screen and the
database disagree. For `defaultRecoveryPath` that is a data-safety problem, not a
cosmetic one — the recovery pipeline trusts that value. Optimistic application
keeps the UI instantaneous; the write remains authoritative, and a failure
restores the previous value so a control can never claim something that was not
stored.

### ADR-004 — Renderer bundle discipline

**Context.** First paint is on the startup budget.

**Findings during Module 0.** The initial build emitted an 811 kB entry chunk.
Sourcemap analysis identified three distinct causes:

1. electron-vite does not enable minification by default — the _unminified_
   production React build was shipping (~4× the bytes to parse).
2. Rollup's object-form `manualChunks` resolves one entry module per name, so
   `react-dom/client` and `scheduler` fell back into the entry chunk.
3. Zod was reachable from the renderer (see ADR-002).

**Decision.** Explicit `minify`/`cssMinify`; a function-form `manualChunks` that
matches exact package names; Zod removed from the renderer; Chart.js lazy-loaded.

**Result.** Entry chunk 811 kB → 70.7 kB. Charting (154 kB) moved off the
first-paint path entirely.

**Guard.** `npm run build` prints the chunk table; a chunk crossing 900 kB warns.

### ADR-005 — Testing split by runtime, not by layer

**Decision.**

- **Vitest (node)** — the shared kernel, the real SQLite persistence layer, and
  the pure cores extracted from the main process (`settings-codec`,
  `log-parser`, `migration-plan`).
- **Vitest (jsdom)** — components, hooks and stores.
- **Playwright + Electron** — everything that needs a live runtime: the `app://`
  handler, session hardening, the preload bridge, the IPC registry, real
  persistence across a reload.

**Rationale.** Coverage thresholds are scoped to what a Node or jsdom process can
genuinely exercise. Including Electron-coupled modules would report a block of
permanently-zero files and make the number meaningless.

**Current state.** 134 node tests, 33 renderer tests, 10 end-to-end tests.
