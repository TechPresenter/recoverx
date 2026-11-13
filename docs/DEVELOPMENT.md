# Development guide

## Prerequisites

| Tool    | Version              | Notes                                                                       |
| ------- | -------------------- | --------------------------------------------------------------------------- |
| Node.js | 22+ (24 recommended) | Must match Electron's embedded runtime family — `node:sqlite` depends on it |
| npm     | 10+                  |                                                                             |
| Git     | any                  | Husky hooks are installed on `npm install`                                  |
| Python  | 3.10+                | **Only** to regenerate `build/icon.ico`; not needed to build                |

No C++ compiler, no Visual Studio Build Tools, no `node-gyp`. The project ships
zero native addons — see
[ADR-001](ARCHITECTURE.md#adr-001-nodesqlite-over-better-sqlite3).

## Setup

```bash
npm install
```

```bash
npm run dev
```

`electron-vite dev` serves the renderer with HMR on port 5273 and restarts the
main process on change.

### Environment overrides

Copy `.env.example` to `.env`. Every variable is honoured **only in unpackaged
builds** — a shipped installation must behave identically for every user.

| Variable                   | Effect                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `RECOVERX_LOG_LEVEL`       | `error` \| `warn` \| `info` \| `debug`                                                               |
| `RECOVERX_OPEN_DEVTOOLS`   | Opens DevTools detached on launch                                                                    |
| `RECOVERX_USER_DATA_DIR`   | Redirects the data directory — use this so a dev session cannot migrate an installed copy's database |
| `RECOVERX_UPDATE_FEED_URL` | Points auto-update at a QA feed                                                                      |

## Commands

| Command                 | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `npm run dev`           | Development with HMR                                        |
| `npm run build`         | Type-check, then build all three bundles into `out/`        |
| `npm run preview`       | Run the built bundles without packaging                     |
| `npm run verify`        | **The pre-push gate**: format, lint, type-check, unit tests |
| `npm test`              | Unit and component tests                                    |
| `npm run test:watch`    | Tests in watch mode                                         |
| `npm run test:coverage` | Tests with coverage thresholds                              |
| `npm run test:e2e`      | End-to-end suite (run `build` first)                        |
| `npm run lint:fix`      | Auto-fix lint violations                                    |
| `npm run format`        | Format everything                                           |
| `npm run clean`         | Remove build output and caches                              |
| `npm run package:win`   | Build the NSIS installer into `release/`                    |

Git hooks: `pre-commit` runs lint-staged; `pre-push` runs type-check and tests.

## Project layout

```
src/
  main/          Electron main process — Node, elevated
    app/         bootstrap, lifecycle, window manager, menu, startup metrics
    config/      path and environment resolution
    database/    connection, migrations, repositories, driver wrapper
    ipc/         registry + one handler module per domain
    logging/     Winston sinks, JSONL parser/reader, live broadcaster
    security/    app:// protocol, session hardening, navigation, path safety
    services/    settings, system info, diagnostics
  preload/       context bridge — tiny, dependency-free
  renderer/      React application
    app/         router, error boundary
    components/  layout/ (shell chrome) + ui/ (design-system primitives)
    features/    one directory per screen
    hooks/ lib/ stores/ i18n/ styles/ types/
  shared/        compiled into all three — must stay isomorphic
tests/
  unit/          Node: shared kernel, persistence, pure main-process cores
  renderer/      jsdom: components, hooks, stores
  e2e/           Playwright + Electron
```

### Import boundaries

Enforced by ESLint, not convention:

- `src/shared/**` may not import Electron, Node built-ins, or React.
- `src/main/**` and `src/preload/**` may not import renderer code.
- `src/renderer/**` may not import Electron, Node built-ins, or main-process
  code. Its only route to the main process is `@/lib/ipc-client`.

Path aliases: `@shared/*`, `@main/*`, `@/*` (renderer).

## Conventions

**TypeScript is maximally strict.** `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax` and friends are all on. This
is disk-recovery software; a silent `undefined` can mean unrecoverable user data.

Two consequences worth knowing:

- With `exactOptionalPropertyTypes`, `{ ...base, ...patch }` where `patch` has
  optional keys widens the result type. Build the object explicitly, skipping
  `undefined` values (see `applyPatch` in `settings.store.ts`).
- With `verbatimModuleSyntax`, type-only imports must say `import type`. This is
  load-bearing for bundle size: it is what keeps Zod out of the renderer.

**Errors.** Throw `AppError` with an `ErrorCode` from services; the IPC registry
serialises it. Never let an `Error` cross a process boundary.

**JSON.** Bare `JSON.parse` is banned by lint. Use `parseJson(raw, schema)` from
`@shared/utils/json`, so a corrupted persisted value cannot become an object of
an unexpected shape. The few sanctioned exceptions carry an inline
`eslint-disable` with a justification.

**Comments** explain _why_, not _what_. If a line needs a comment to say what it
does, rename something instead.

## Testing strategy

Split by runtime, not by layer — see
[ADR-005](ARCHITECTURE.md#adr-005--testing-split-by-runtime-not-by-layer).

| Suite            | Runtime       | Covers                                                                       |
| ---------------- | ------------- | ---------------------------------------------------------------------------- |
| `tests/unit`     | Node          | Shared kernel, **real SQLite** persistence, pure main-process cores          |
| `tests/renderer` | jsdom         | Components, hooks, stores                                                    |
| `tests/e2e`      | Real Electron | Protocol handler, hardening, bridge, IPC registry, persistence across reload |

Because SQLite comes from `node:sqlite`, the unit suite drives a **real database
file** — migrations, transactions, savepoint nesting, rollback and corruption
quarantine are all genuinely executed, not mocked.

Coverage thresholds (80%) apply to the modules a Node or jsdom process can
actually exercise. Electron-coupled modules are excluded and covered end-to-end
instead; including them would report permanently-zero files and make the number
meaningless.

### Writing a test

- Assert on **behaviour**, not implementation. Prefer accessible queries
  (`getByRole`) over test IDs.
- Name the test after the property being protected, not the function being
  called: _"reverts the optimistic value when the write fails"_.
- Cover the failure path. Most of this codebase's value is in what it does when
  something goes wrong.

## Adding a module

The project is built one module at a time; each is finished before the next
begins. A module is done when all of the following are true:

1. **Contract** — channels in `channels.ts`, schemas in `contracts.ts`.
2. **Schema** — a new migration if it persists anything, plus tests.
3. **Main** — services under `src/main/services/`, with pure logic extracted
   into separately testable modules.
4. **Handlers** — registered in `src/main/ipc/handlers/`.
5. **Renderer** — a directory under `src/renderer/features/`, a route, a sidebar
   entry.
6. **i18n** — strings added to `en.ts` _and_ every other locale. A missing key is
   a compile error, by design.
7. **Tests** — unit for logic, component for UI, e2e for the workflow.
8. **Docs** — [API.md](API.md), [DATABASE.md](DATABASE.md), and the README table.
9. **Gates** — `npm run verify`, `npm run build`, `npm run test:e2e` all clean.

Never add a navigation entry for a screen that does not work. A disabled
"coming soon" row in a paid product reads as an unfinished build.

## Performance notes

Things that were measured, and are easy to regress:

- **Bundle size.** `npm run build` prints the chunk table. The entry chunk should
  stay well under 100 kB. If it jumps, check for a runtime import from a module
  that defines Zod schemas.
- **Startup.** Shown on the About screen. Target under 3 s cold; currently
  ~880 ms. Work added to `prepareApplication` lands directly on this number.
- **Virtualise long lists.** `useVirtualRows` for anything that can exceed a few
  hundred rows.
- **Batch IPC.** A scan emits thousands of log records per second; the
  broadcaster batches at 400 ms. Apply the same discipline to scan progress.

## Troubleshooting

**The window is blank and the log says `Blocked outbound renderer request`.**
The outbound filter in `session-hardening.ts` cancelled a request. It allows only
the `app://` origin, the dev server, `blob:` and `data:`. If you add a resource
source, allow it explicitly — do not relax the filter.

**`ERR_UNEXPECTED` loading `app://recoverx/index.html`.**
`out/renderer/` is missing or stale. Run `npm run build`.

**Settings changes do not persist.**
Check the log for `settings` scope entries. An invalid merge is rejected as a
whole and the previous value is kept — by design.

**A test cannot import a main-process module.**
It probably imports `electron`. Extract the pure logic into its own module and
test that; cover the Electron-coupled part end-to-end.
