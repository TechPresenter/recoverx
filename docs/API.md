# IPC API reference

The complete surface the renderer can reach. Anything not listed here is
unreachable from the renderer by construction — there is no `ipcRenderer`, no
`require`, and no Node integration in the sandboxed context.

Source of truth: `src/shared/ipc/channels.ts` and `src/shared/ipc/contracts.ts`.
This document describes them; the schemas define them.

---

## Calling convention

```ts
import { invoke, subscribe } from '@/lib/ipc-client'
import { IpcChannel, IpcEvent } from '@shared/ipc/channels'

const result = await invoke(IpcChannel.SettingsGetAll, undefined)

if (result.ok) {
  console.log(result.data.theme) // fully typed from the channel's schema
} else {
  console.error(result.error.code, result.error.message)
}
```

`invoke` **never rejects**. Every failure — validation, handler error, timeout,
missing bridge — arrives as `{ ok: false, error }`.

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: SerializedError }

interface SerializedError {
  code: ErrorCode
  message: string // safe to show to the user
  details?: string // operator detail; never contains user data
  retryable: boolean
}
```

Requests time out after **30 s**, except `app:pick-directory`, which blocks on a
modal dialog and is intentionally unbounded.

---

## Error codes

| Code                 | Meaning                                                         | Retryable |
| -------------------- | --------------------------------------------------------------- | --------- |
| `VALIDATION`         | Payload failed its schema, or the merged state would be invalid | No        |
| `NOT_FOUND`          | Requested path, file or entity does not exist                   | No        |
| `PERMISSION_DENIED`  | The OS refused — usually a missing elevation token              | No        |
| `DATABASE`           | SQLite failure: constraint, corruption, lock                    | Yes       |
| `IO`                 | Filesystem or block-device failure                              | Yes       |
| `UNSUPPORTED`        | Not supported on this platform or filesystem                    | No        |
| `CONFLICT`           | Conflicts with current state                                    | No        |
| `TIMEOUT`            | Exceeded its deadline                                           | Yes       |
| `CANCELLED`          | Cancelled by the user                                           | No        |
| `SECURITY_VIOLATION` | Refused by a guard (host allowlist, untrusted sender)           | No        |
| `UNKNOWN`            | Unclassified                                                    | No        |

---

## Application

### `app:get-info` → `AppInfo`

Static build identity. No payload.

```ts
{
  name: string
  version: string
  isPackaged: boolean
  channel: 'latest' | 'beta' | 'alpha'
  platform: string
  arch: string
  locale: string
  runtime: {
    electron: string
    chrome: string
    node: string
    v8: string
  }
}
```

### `app:get-diagnostics` → `Diagnostics`

Live health of the application's own infrastructure. No payload.

```ts
{
  startupMs: number // process start to first paint
  userDataDir: string
  databasePath: string
  databaseSizeBytes: number // includes WAL and SHM
  schemaVersion: number
  appliedMigrations: number
  logDirectory: string
  logSizeBytes: number
  logFileCount: number
}
```

### `app:open-external` → `void`

`{ url: string }` — opens in the OS browser.

Refused with `SECURITY_VIOLATION` unless the URL is `https:`, carries no embedded
credentials, and its host is in `ALLOWED_EXTERNAL_HOSTS`. The same policy governs
links opened through `window.open`.

### `app:reveal-path` → `void`

`{ path: string }` — reveals in Explorer. `NOT_FOUND` if the path is unreadable.

### `app:pick-directory` → `{ path: string | null }`

`{ title?: string; defaultPath?: string }` — modal folder picker. `path` is
`null` when dismissed. Not subject to the request timeout.

### `app:validate-path` → `PathValidation`

`{ path: string }` — inspects a candidate recovery destination.

```ts
{
  path: string
  exists: boolean
  isDirectory: boolean
  isWritable: boolean // by write probe, not fs.access — see below
  freeBytes: number
  totalBytes: number
}
```

`isWritable` is determined by creating and deleting a probe file.
`fs.access(W_OK)` on Windows reflects only the read-only attribute and ignores
ACLs, so it reports directories as writable that are not.

### `app:relaunch` → `void`

Restarts the application. The reply is delivered before the process exits, so the
caller is not left reporting a failure for an operation that succeeded.

---

## Window

The window is frameless; these replace the OS title bar controls.

| Channel                  | Payload | Response      |
| ------------------------ | ------- | ------------- |
| `window:minimize`        | —       | `void`        |
| `window:toggle-maximize` | —       | `WindowState` |
| `window:close`           | —       | `void`        |
| `window:get-state`       | —       | `WindowState` |

```ts
interface WindowState {
  isMaximized: boolean
  isMinimized: boolean
  isFullScreen: boolean
  isFocused: boolean
}
```

State can also change without a click (snap-to-edge, OS restore), so the
authoritative source is the `evt:window-state-changed` event.

---

## Settings

### `settings:get-all` → `AppSettings`

Served from the main process's in-memory cache; no database round trip.

### `settings:update` → `AppSettings`

`{ patch: Partial<AppSettings> }`. Returns the complete, merged settings.

- Only keys present in the patch are written. A key explicitly set to
  `undefined` means "leave unchanged".
- The merged object is validated as a whole before anything is persisted.
- `defaultRecoveryPath` is additionally checked against the real filesystem:
  `NOT_FOUND`, `VALIDATION` or `PERMISSION_DENIED` if it cannot receive files.
- A patch that changes nothing is a no-op — no write, no broadcast.

### `settings:reset` → `AppSettings`

Restores factory defaults.

### The settings object

| Key                         | Type                                                   | Default                        |
| --------------------------- | ------------------------------------------------------ | ------------------------------ |
| `theme`                     | `'system' \| 'light' \| 'dark'`                        | `system`                       |
| `accent`                    | `'blue' \| 'violet' \| 'emerald' \| 'amber' \| 'rose'` | `blue`                         |
| `language`                  | `'en' \| 'es'`                                         | `en`                           |
| `compactDensity`            | `boolean`                                              | `false`                        |
| `reduceMotion`              | `boolean`                                              | `false`                        |
| `byteUnitSystem`            | `'binary' \| 'decimal'`                                | `binary`                       |
| `defaultRecoveryPath`       | `string`                                               | `Documents\RecoverX Recovered` |
| `confirmDestructiveActions` | `boolean`                                              | `true`                         |
| `logLevel`                  | `'error' \| 'warn' \| 'info' \| 'debug'`               | `info`                         |
| `logRetentionDays`          | `number` (1–90)                                        | `14`                           |
| `telemetryEnabled`          | `boolean`                                              | `false`                        |
| `autoCheckUpdates`          | `boolean`                                              | `true`                         |
| `hardwareAcceleration`      | `boolean`                                              | `true`                         |
| `launchMinimized`           | `boolean`                                              | `false`                        |

`hardwareAcceleration` requires a restart: Chromium reads it while creating the
GPU process, before any window exists.

`autoCheckUpdates` lets a directly installed copy check for an update once,
about 15 seconds after start-up (later if a scan or recovery is running), and
again shortly after the setting is turned on. It never downloads anything.

`telemetryEnabled` is reserved: nothing reads it and Settings no longer shows
it, because the application sends no diagnostics. It stays in the schema so the
settings contract does not change under existing installations.

---

## System

### `system:get-snapshot` → `SystemSnapshot`

Host telemetry. Cheap enough to poll — the Dashboard samples every 2 s while
visible.

```ts
{
  capturedAt: number
  os:      { platform, distro, release, arch, hostname, uptimeMs }
  cpu:     { model, logicalCores, speedMhz, utilizationPercent: number | null }
  memory:  { totalBytes, freeBytes, usedBytes, usagePercent }
  process: { uptimeMs, rssBytes, heapUsedBytes, heapTotalBytes, externalBytes }
  isElevated: boolean
}
```

`cpu.utilizationPercent` is `null` on the first call. `os.cpus()` exposes
cumulative tick counters since boot, so a single reading describes the machine's
entire uptime; a delta between two samples is the only meaningful figure.

`isElevated` is probed once per session (a process token cannot change) by
running `fltmc.exe`, which refuses to execute without elevation.

---

## Logs

### `logs:list-files` → `LogFileInfo[]`

Newest first. `isActive` marks the file currently being appended to.

### `logs:query` → `LogQueryResult`

```ts
// request
{
  file?: string          // defaults to the active file
  levels?: LogLevel[]    // omit or empty for all
  search?: string        // case-insensitive, matches message + scope + metadata
  sinceEpochMs?: number
  untilEpochMs?: number
  limit: number          // 1–2000
  offset: number         // >= 0
}

// response
{
  file: string
  entries: LogEntry[]    // newest first
  total: number          // matches before pagination
  scannedBytes: number
  truncated: boolean     // only the file's tail was read
  malformedLines: number
}
```

`file` is validated against the logger's own rotation pattern before any path is
opened — it is renderer-supplied and therefore untrusted.

Reads are capped at **8 MiB** from the end of the file. When the cap applies,
`truncated` is `true` and the UI says so, so a partial view is never mistaken for
a complete history.

### `logs:open-folder` → `void`

### `logs:clear` → `{ removedFiles: number; freedBytes: number }`

Deletes every log file except the active one. Removing the active file would
leave the rotate transport holding a deleted inode and silently discard every
subsequent record.

### `logs:write` → `void`

Forwards a renderer event into the main-process log, tagged `renderer:<scope>`.

```ts
{
  level: LogLevel
  scope: string
  message: string
  meta: string | null
}
```

Fire-and-forget: a logging call never makes a component wait.

---

## Events (main → renderer)

```ts
const unsubscribe = subscribe(IpcEvent.SettingsChanged, (settings) => { … })
```

| Event                      | Payload                            | Fired when                               |
| -------------------------- | ---------------------------------- | ---------------------------------------- |
| `evt:settings-changed`     | `AppSettings`                      | Any setting changes, from any source     |
| `evt:window-state-changed` | `WindowState`                      | Maximise, minimise, restore, focus, blur |
| `evt:system-theme-changed` | `{ shouldUseDarkColors: boolean }` | OS theme changes                         |
| `evt:log-appended`         | `LogEntry[]`                       | New records, batched every 400 ms        |

Log records are batched because a scan emits thousands per second; one IPC
message each would saturate the channel and starve the UI thread. The buffer is
capped at 500 records, dropping oldest first.

---

## Adding a channel

1. Add the name to `IpcChannel` in `src/shared/ipc/channels.ts`.
2. Add request and response schemas to `IPC_CONTRACTS` in `contracts.ts`.
3. Implement a handler under `src/main/ipc/handlers/` and register it.
4. Add it to this document.

Step 3 is not optional: `assertComplete()` fails startup if a declared channel
has no handler.
