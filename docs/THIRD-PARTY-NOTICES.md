# Third-party notices

RecoverX incorporates open-source software. Those components remain licensed
under their own terms, and nothing in the RecoverX licence limits the rights
those licences grant you.

Every component listed here is under a permissive licence (MIT, ISC, BSD,
BlueOak-1.0.0, Python-2.0, or public domain). None is under the GPL or another
copyleft licence.

---

## The recovery engine is RecoverX's own

Everything that touches a disk is RecoverX's own TypeScript, in `src/main`:
read-only block-device access and the MBR/GPT parsers (`disk/`), the
lost-partition search (`disk/partition-finder.ts`), the NTFS, FAT12/16/32 and
exFAT scanners and the signature carver (`scan/`), previews and content
verification (`preview/`), and the recovery writer with its destination guard
(`recovery/`). [ARCHITECTURE.md › Recovery engine](ARCHITECTURE.md#6-recovery-engine)
describes how they fit together.

No third-party recovery tool — PhotoRec, TestDisk, The Sleuth Kit,
smartmontools, GNU ddrescue, ntfs-3g, exfatprogs or any other — is shipped,
linked or started by the application.

The application does start three programs that are part of Windows itself, and
ships none of them: `powershell.exe` to list storage devices and to read drive
health from Windows' own SMART (`MSStorageDriver_*`) and storage reliability
(`MSFT_PhysicalDisk`) providers, `reg.exe` to read the `MachineGuid` the
licence's computer identifier is derived from, and `fltmc.exe`, whose refusal
to run without elevation is how the application tells whether it has
Administrator rights.

---

## Bundled components

### Runtime, installed with the application

| Component                     | Licence                 | Role                                     |
| ----------------------------- | ----------------------- | ---------------------------------------- |
| Electron                      | MIT                     | Application runtime                      |
| Chromium                      | BSD-3-Clause and others | Rendering engine                         |
| Node.js (incl. `node:sqlite`) | MIT                     | Runtime embedded in Electron             |
| SQLite                        | Public domain           | Embedded database, compiled into Node.js |

Electron's installer copies their licence texts into the installation folder:
`LICENSE.electron.txt`, and `LICENSES.chromium.html`, which also covers the
third-party code inside Chromium and Node.js.

### Main process — `dependencies` in package.json, shipped inside `app.asar`

| Component                                             | Licence | Role                       |
| ----------------------------------------------------- | ------- | -------------------------- |
| electron-updater, builder-util-runtime                | MIT     | Update checks and download |
| Winston, winston-daily-rotate-file, winston-transport | MIT     | Logging                    |
| Zod                                                   | MIT     | Schema validation          |

And what those pull in, all MIT unless stated: `@colors/colors`,
`@dabh/diagnostics`, `@so-ric/colorspace`, `async`, `color`, `color-convert`,
`color-name`, `color-string`, `debug`, `enabled`, `fecha`, `file-stream-rotator`,
`fn.name`, `fs-extra`, `is-stream`, `js-yaml`, `jsonfile`, `kuler`, `lazy-val`,
`lodash.escaperegexp`, `lodash.isequal`, `logform`, `moment`, `ms`,
`object-hash`, `one-time`, `readable-stream`, `safe-buffer`,
`safe-stable-stringify`, `stack-trace`, `string_decoder`, `text-hex`,
`tiny-typed-emitter`, `triple-beam`, `universalify`, `util-deprecate`;
`graceful-fs`, `inherits` and `semver` (ISC); `argparse` (Python-2.0, via
js-yaml); `sax` (BlueOak-1.0.0, via builder-util-runtime). Each keeps its own
licence file inside `app.asar`.

### Interface — compiled into the renderer bundle

| Component                               | Licence | Role                 |
| --------------------------------------- | ------- | -------------------- |
| React, React DOM                        | MIT     | User interface       |
| React Router                            | MIT     | Routing              |
| Zustand                                 | MIT     | State management     |
| i18next, react-i18next                  | MIT     | Internationalisation |
| Chart.js, react-chartjs-2               | MIT     | Charting             |
| lucide-react                            | ISC     | Icons                |
| clsx, tailwind-merge                    | MIT     | Class composition    |
| Tailwind CSS (the generated stylesheet) | MIT     | Styling              |
| Zod                                     | MIT     | Schema validation    |

With their own dependencies, all MIT: `scheduler`, `cookie`,
`set-cookie-parser`, `use-sync-external-store`, `html-parse-stringify`,
`@babel/runtime` helpers and `@kurkle/color`.

The bundler strips licence comments from this code, so this file is the notice
for it. It is not yet shown inside the application or on the website; until it
is, it is available on request from info@appsgain.in.

### Build and development only — not distributed

TypeScript (Apache-2.0), Vite (MIT), electron-vite (MIT), electron-builder (MIT),
ESLint (MIT), Prettier (MIT), Vitest (MIT), Playwright (Apache-2.0), Husky (MIT).

---

## Keeping this file true

Re-check it whenever `dependencies` change and before every release. List the
main-process closure, with each package's licence, from the repository root:

```bash
npx license-checker --production --summary
```

The interface libraries are `devDependencies` (the renderer is bundled at build
time), so that command does not see them; compare the table above with the
imports under `src/renderer` instead.

---

Questions about licensing: info@appsgain.in
