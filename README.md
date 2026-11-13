# RecoverX

Professional data recovery for Windows 10 and Windows 11.

RecoverX recovers deleted, formatted and otherwise lost files from hard disks,
SSDs, USB drives, SD cards and camera media. Every scan is strictly read-only:
the source device is never written to, and recovered files are always restored to
a different volume.

> **Status — recovery, licensing and the Microsoft Store pipeline are in place.**
> Device detection, quick and deep scanning, preview, recovery, partition
> search and drive health are implemented, alongside the foundation (shell,
> persistence, IPC, security, settings, diagnostics), licence activation with
> its server, and the signed Store packaging. Nothing in this repository is a
> stub or placeholder — what is here, works.

---

## What is implemented today

| Area                                                                                    | State                                     |
| --------------------------------------------------------------------------------------- | ----------------------------------------- |
| Application shell, custom window chrome, routing                                        | Complete                                  |
| Theme system (light/dark/system, 5 accents, reduced motion, density)                    | Complete                                  |
| Settings — validated, persisted to SQLite, live-synced across processes                 | Complete                                  |
| SQLite persistence with migrations and corruption recovery                              | Complete                                  |
| Typed, schema-validated IPC layer                                                       | Complete                                  |
| Security model (sandbox, CSP, custom protocol, navigation guard)                        | Complete                                  |
| Diagnostics logging + in-app log viewer with live tail                                  | Complete                                  |
| Internationalisation (English, Spanish)                                                 | Complete                                  |
| System health dashboard                                                                 | Complete                                  |
| Disk detection — physical devices, MBR/GPT partition tables, file-system identification | Complete                                  |
| Quick scan — NTFS (MFT), FAT12/16/32 and exFAT directory records                        | Complete                                  |
| Deep scan — signature-based carving of 21 file types                                    | Complete                                  |
| Preview and content verification                                                        | Complete                                  |
| Recovery — read-only source, destination guard, folder-structure restore                | Complete                                  |
| Lost-partition search                                                                   | Complete                                  |
| Drive health — SMART and Windows storage reliability counters                           | Complete                                  |
| Licence activation (online/offline), Free-edition limit, licence server                 | Complete                                  |
| Updates (electron-updater; checks at start-up if allowed, downloads only on request)    | Complete                                  |
| Microsoft Store release (signed MSI/EXE listing)                                        | Pipeline and runbook ready; not submitted |

## Quick start

```bash
npm install
```

```bash
npm run dev
```

No C++ toolchain, Python or native rebuild step is required — see
[Architecture decisions](docs/ARCHITECTURE.md#adr-001-nodesqlite-over-better-sqlite3).

### Everyday commands

| Command                 | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `npm run dev`           | Run with hot module replacement                                     |
| `npm run build`         | Type-check and build all three bundles into `out/`                  |
| `npm run verify`        | Format check, lint, type-check and unit tests — the pre-push gate   |
| `npm test`              | Unit and component tests                                            |
| `npm run test:coverage` | Tests with a coverage report                                        |
| `npm run test:e2e`      | End-to-end suite against a real Electron window (run `build` first) |
| `npm run package:win`   | Produce the NSIS installer in `release/`                            |
| `npm run package:store` | Signed, verified installer plus the Microsoft Store submission kit  |

## Architecture at a glance

Three isolated processes, connected by one typed contract:

```
┌──────────────────────────────┐
│ Renderer  (sandboxed)        │  React 19 · TypeScript · Tailwind 4 · Zustand
│  no Node, no filesystem      │
└──────────────┬───────────────┘
               │  window.recoverx — invoke() / subscribe()
┌──────────────┴───────────────┐
│ Preload   (context bridge)   │  ~2 kB, no dependencies
└──────────────┬───────────────┘
               │  ipcMain.handle, Zod-validated both ways
┌──────────────┴───────────────┐
│ Main      (elevated)         │  SQLite · Winston · device access
└──────────────────────────────┘
```

The renderer is treated as hostile. It runs sandboxed with context isolation, no
Node integration, a Content Security Policy applied at the network layer, and a
custom `app://` scheme instead of `file://`. Its only capability is calling
channels that are declared in a shared contract and validated on arrival.

Full detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Documentation

| Document                                           | Contents                                               |
| -------------------------------------------------- | ------------------------------------------------------ |
| [Architecture](docs/ARCHITECTURE.md)               | Process model, layering, security, decision records    |
| [API reference](docs/API.md)                       | Every IPC channel, payload and error code              |
| [Database schema](docs/DATABASE.md)                | Tables, migrations, corruption handling                |
| [Development guide](docs/DEVELOPMENT.md)           | Setup, conventions, testing strategy, adding a module  |
| [Building](docs/BUILDING.md)                       | Toolchain, installer build, code signing, licence keys |
| [Deployment guide](docs/DEPLOYMENT.md)             | Packaging, installer, elevation, auto-update           |
| [Release guide](docs/RELEASE.md)                   | Versioning, signing, channels, rollback                |
| [Licence server](docs/LICENSE-SERVER.md)           | Activation service: HTTP contract, Node reference      |
| [PHP licence server](server-php/README.md)         | The production server, on the website's host           |
| [Website](website/README.md)                       | recoverx.snapkio.com: build, upload, publish a release |
| [Microsoft Store](docs/MICROSOFT-STORE.md)         | Store runbook: certificate, Partner Center, listing    |
| [Contributing](docs/CONTRIBUTING.md)               | Workflow, commit conventions, review standards         |
| [Third-party notices](docs/THIRD-PARTY-NOTICES.md) | Bundled open-source components and licences            |

## Technology

Electron 43 · React 19 · TypeScript 5.9 (strict) · Vite 7 · Tailwind CSS 4 ·
Zustand 5 · Chart.js 4 · Zod 4 · Winston 3 · i18next 26 · Vitest 4 · Playwright 1.62

SQLite is provided by Node's built-in `node:sqlite`, so the project ships **zero
native addons**.

## Roadmap

Modules are built one at a time; each is finished, tested and free of known
defects before the next begins.

1. ~~**Foundation** — shell, persistence, IPC, security, settings, logging~~ ✅
2. ~~**Disk detection** — physical devices, partition tables, file systems~~ ✅
3. ~~**Quick scan** — NTFS, FAT and exFAT directory-record recovery~~ ✅
4. ~~**Deep scan** — signature-based carving~~ ✅
5. ~~**Preview** — images, text and raw bytes, with content verification~~ ✅
6. ~~**Recovery** — selection, folder-structure restore, partial-file marking~~ ✅
7. ~~**Partition search**, **drive health**, **updates**~~ ✅
8. ~~**Licensing and activation** — licence keys, online and offline activation,
   seat limits, the [licence server](docs/LICENSE-SERVER.md)~~ ✅
9. **Microsoft Store release** — signed MSI/EXE listing; pipeline and runbook in
   [docs/MICROSOFT-STORE.md](docs/MICROSOFT-STORE.md)

The recovery engine is RecoverX's own TypeScript, in `src/main`: block-device
access and the MBR/GPT parsers in `disk/`, the NTFS, FAT and exFAT scanners and
the carver in `scan/`, previews in `preview/`, the writer and its destination
guard in `recovery/`, and drive health read from Windows' own SMART and storage
reliability providers in `health/`. No third-party recovery tool (PhotoRec,
TestDisk, The Sleuth Kit, smartmontools, ddrescue) is invoked or bundled — see
[docs/ARCHITECTURE.md › Recovery engine](docs/ARCHITECTURE.md#6-recovery-engine).

## Licence

Commercial. See [LICENSE](LICENSE). Bundled open-source components remain under
their own licences — see [docs/THIRD-PARTY-NOTICES.md](docs/THIRD-PARTY-NOTICES.md).

Made by Appsgain Technologies Private Limited — https://appsgain.in.
Website: https://recoverx.snapkio.com/ · Support: info@appsgain.in
