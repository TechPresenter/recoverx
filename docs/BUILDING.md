# Building RecoverX

How to turn the source in this repository into an installable Windows
application, and what each step actually does.

---

## What you need

| Requirement | Version     | Why                                                 |
| ----------- | ----------- | --------------------------------------------------- |
| Node.js     | 24 or newer | The database uses `node:sqlite`, built into Node 24 |
| npm         | 10 or newer | Ships with Node                                     |
| Windows     | 10 or 11    | The installer target                                |
| Git         | any         | Only to clone the repository                        |

**You do not need Visual Studio, the Windows SDK, or any C++ toolchain.**
RecoverX ships zero native addons — SQLite comes from the Node runtime that
Electron already embeds — so there is nothing to compile and nothing to rebuild
against Electron's ABI. If a build ever asks you for `node-gyp`, something has
pulled in a native dependency that does not belong.

Check what you have:

```bash
node --version
```

---

## First time

```bash
npm install
```

Then generate the application icon. It is drawn by a script rather than
committed as a binary, so it is not in a fresh clone:

```bash
npm run icon
```

That writes `build/icon.ico` (7 sizes, 16–256 px) and `build/icon.png`, plus the
Microsoft Store artwork in `build/store/` and `build/appx/`, all from the same
drawing.

---

## Build the installer

```bash
npm run package:win
```

This runs three things in order: a type check across both processes, the
production bundle, then `electron-builder`. When it finishes you will have:

```
release/0.1.0/RecoverX-Setup-0.1.0-x64.exe
```

That single file is the installer. It is what you give to a customer.

The first run downloads the Electron binaries and the NSIS installer toolchain
(roughly 200 MB) into a cache outside the project. Later builds reuse the cache
and take well under a minute.

---

## What the installer does

Set in `electron-builder.yml`, and worth knowing because two of these affect
customers directly:

- **Requests Administrator rights on every launch.** Reading a raw block device
  (`\\.\PhysicalDrive0`) and locking a volume both require an elevated token.
  Without it the scanner sees no drives at all, so asking up front is better
  than a half-working session. Windows will show a UAC prompt each time the
  application starts — that is expected, and every commercial recovery tool
  behaves the same way.
- **Keeps user data on uninstall unless asked not to.** Settings, recovery
  history and the licence activation live under `%APPDATA%\RecoverX`.
  Deleting a paid activation because someone uninstalled to reinstall would be
  a bad day for both of you, so an interactive uninstall asks — defaulting to
  No — and a silent one or an update never removes it (`build/installer.nsh`).
- Installs per machine, lets the user choose the directory, and creates both a
  desktop and a Start menu shortcut.

---

## Running it during development

```bash
npm run dev
```

Hot reload for the renderer, automatic restart for the main process.

One thing to know: a development run is **not** elevated, so Windows refuses
every raw disk read and every SMART query. The Devices, Scan, Partitions and
Health screens will all correctly report that they need Administrator rights.
That is the application behaving properly, not a bug. To exercise those paths,
either build the installer and run the installed copy, or start your terminal
with "Run as administrator" before `npm run dev`.

---

## Before you ship

```bash
npm run verify
```

Formatting, lint, a strict type check of both processes, and the full test
suite. This is what CI runs; if it passes locally it will pass there.

```bash
npm run test:e2e
```

Launches the packaged application and drives it, including the checks that the
preload bridge exposes only what it should and that navigation away from the
app origin is refused.

---

## Code signing

The build above produces an **unsigned** installer. It works, but Windows
SmartScreen will warn every customer that the publisher is unknown, a fair
number of them will not click through it, and the Microsoft Store refuses it
outright: Store Policy 10.2.9 requires the installer **and every PE file inside
it** to be signed by a CA in the Microsoft Trusted Root Program.

`electron-builder.yml` already says _what_ to sign — the six Electron DLLs that
ship unsigned (`win.signExts`), every `.exe`, SHA-256 only, RFC 3161
timestamped — and deliberately holds no certificate, so `npm run package:win`
keeps working unsigned on any machine. The certificate is chosen per build by
environment variables, and `npm run package:store` (below) refuses to run unless
exactly one is set.

**Where the key lives.** Since June 2023 CAs issue code-signing keys only on
hardware: a USB token (SafeNet and similar) or a cloud HSM (DigiCert KeyLocker,
SSL.com eSigner, Certum SimplySign, …). A `.pfx` file is therefore the legacy
case. An OV certificate is enough — since 2024 EV no longer buys immediate
SmartScreen reputation — and Azure Artifact Signing is not offered in India.
Buying advice for this vendor is in [MICROSOFT-STORE.md › Code-signing certificate](MICROSOFT-STORE.md#32-code-signing-certificate).

### USB token, or a cloud HSM with a Windows key provider

The certificate appears in the Windows certificate store once the token driver
(or the HSM's KSP client, e.g. DigiCert's `smctl` with its KSP, or Certum's
SimplySign Desktop) is installed. Select it by thumbprint:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter
$env:WIN_CSC_SHA1 = '<thumbprint>'          # or WIN_CSC_SUBJECT_NAME = '<part of the subject>'
npm run package:store
```

`package-store.mjs` passes these to electron-builder as
`win.signtoolOptions.certificateSha1` / `certificateSubjectName`; signtool then
signs through the vendor's key provider, which asks for the token PIN. If your
HSM vendor requires a recent signtool, install the Windows SDK and point
`SIGNTOOL_PATH` at its `signtool.exe`.

### Cloud HSM with its own signing tool

Some services sign through their own CLI instead of a Windows key provider
(SSL.com CodeSignTool, jsign with a cloud KMS). Write a small module that signs
one file in place **and timestamps it** and point `WIN_SIGN_HOOK` at it.
electron-builder calls it once per file with `configuration.path` (and
`configuration.hash`, always `sha256` here). electron-builder's
`rfc3161TimeStampServer` is not applied to a hook's signatures, so the hook's
tool must timestamp them itself; `package-store` fails any file that is not
timestamped.

```js
// sign-hook.cjs — keep credentials in the environment, never in this file
const { execFileSync } = require('node:child_process')

exports.default = async function sign(configuration) {
  // CodeSignTool is a .bat. Since Node 18.20.2 / 20.12.2 (CVE-2024-27980) a
  // .bat or .cmd cannot be started without a shell — execFileSync throws
  // EINVAL — so run it through cmd.exe. The command is quoted for cmd, and the
  // path inside it because a path can contain spaces ("Uninstall RecoverX.exe",
  // or a build folder under a user profile such as "First Last"). (A build
  // path containing ", %, & or ^ would need escaping for cmd as well.)
  // CodeSignTool must be on PATH, or write its full path.
  const command = `CodeSignTool.bat sign "-input_file_path=${configuration.path}" -override`
  execFileSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    stdio: 'inherit',
    windowsVerbatimArguments: true,
  })
}
```

```powershell
$env:WIN_SIGN_HOOK = 'C:\signing\sign-hook.cjs'
# The certificate subject's CN exactly as the CA issued it — legal suffix and
# all, e.g. 'Appsgain Technologies Private Limited' — or its full DN.
$env:WIN_PUBLISHER_NAME = '<certificate CN>'
npm run package:store
```

`WIN_PUBLISHER_NAME` is required with a hook: electron-builder never sees the
certificate then, and the name is written to `resources\app-update.yml`, where
`electron-updater` checks every downloaded update's signer against it. A name
that differs from the certificate's CN by a single word produces a release that
installs fine and then refuses **every** later update. `package-store` therefore
compares it with the signer Windows reports for the built installer and fails
the build on any mismatch. With a `.pfx`, the certificate store or Azure the
name is taken from the certificate (or `AZURE_SIGN_PUBLISHER_NAME`), and
`WIN_PUBLISHER_NAME` is ignored — the same check still runs.

`package-store` also signs the NSIS plug-in DLLs that the installer and
uninstaller unpack while they run (`nsis7z.dll`, `System.dll`, …), which
electron-builder leaves unsigned; they cost seven extra signing operations per
build, through the same certificate and hook.

### Legacy .pfx

```bash
export CSC_LINK=/path/to/certificate.pfx     # or its base64
export CSC_KEY_PASSWORD=your-password
```

electron-builder picks them up with no config change, for `package:win` and
`package:store` alike. CI uses this route from the `WINDOWS_CERT_BASE64` /
`WINDOWS_CERT_PASSWORD` secrets, which it gives only to the signing steps —
never at job level, where `npm ci`'s dependency install scripts could read them.

### Never in a `RECOVERX_*` variable

electron-vite compiles every `RECOVERX_*` environment variable into the app
bundle (that is how the licensing values get in). Signing credentials therefore
use other names, and nothing secret may ever be given that prefix.

---

## Microsoft Store build

```bash
npm run package:store
```

Draws the icon and Store artwork, builds, then runs `scripts/package-store.mjs`:
a preflight (licensing values compiled in, stable version, signing configured),
the signed NSIS build, an Authenticode check of every PE file including the
uninstaller, and `release/<version>/store/` with a copy of the verified
installer, its SHA-256 and the Partner Center submission sheet. The full
procedure — accounts, certificate, hosting, Partner Center — is
[MICROSOFT-STORE.md](MICROSOFT-STORE.md). `node scripts/package-store.mjs --help`
lists every option, including the `--unsigned` / `--allow-unlicensed` dry runs
for testing the pipeline itself.

`npm run icon` also writes the Store's box art and logo to `build/store/` and
the MSIX tile set to `build/appx/`; `npm run store:screenshots` captures listing
screenshots from the built app.

---

## Licensing keys

Activation is verified against a public key compiled into the build. Generate
the pair once:

```bash
npm run licensing:keys
```

Put the printed public key in your build environment:

```
RECOVERX_LICENSE_PUBLIC_KEY=<the base64 value it prints>
RECOVERX_ACTIVATION_URL=https://your-server/v1/activate
```

Move the private key it writes (`license-signing-key.pem`) to your activation
server and delete the local copy. It is gitignored, but it is worth being
deliberate: anyone holding it can mint a licence for any edition, and replacing
it invalidates every licence you have already sold.

A build with neither variable set still works. It runs as the Free edition and
says so — it does not silently unlock everything, and it does not silently
refuse valid licences. `npm run package:store` refuses such a build, since a
release without them would reject every key a customer buys. Both values are
read at build time — from the environment or from `.env`, `.env.local`,
`.env.production` or `.env.production.local` — so rebuild after changing them.

---

## Updates

`electron-builder.yml` publishes to a generic provider at
`https://recoverx.snapkio.com/updates/win/latest`, a directory of the website's
host. To release an update, upload the installer, its blockmap and the
`latest.yml` that electron-builder writes beside it to that URL
([RELEASE.md › Publish](RELEASE.md#6-publish)). The application checks once
shortly after start-up while "Check for updates automatically" is on, and
whenever the user clicks **Check now**; it downloads only when the user asks,
and refuses to install while a scan or recovery is running.

---

## Troubleshooting

**`npm install` fails on a native module.** Nothing in this project needs one.
Check whether a dependency was added that pulls one in.

**The icon is the default Electron one.** Run `npm run icon`; `build/icon.ico`
is generated, not committed.

**"No drives found" in the installed application.** Confirm the UAC prompt was
accepted. If it never appeared, the installer was built without
`requestedExecutionLevel: requireAdministrator`.

**`Cannot create symbolic link : A required privilege is not held by the client`**
while electron-builder unpacks `winCodeSign`. Harmless: the two links are macOS
libraries, and the Windows tools are extracted. Enabling Windows Developer Mode
silences it.

**`package-store` fails with "PE file(s) failed verification".** A `NotSigned`
DLL after an Electron upgrade means a new unsigned file ships: add its name to
`win.signExts` in `electron-builder.yml`. `UnknownError` means a signature that
does not chain to a trusted root — the wrong certificate was used.

**The MSIX build fails with `spawn UNKNOWN`.** `makeappx.exe` could not start;
the Application event log shows a SideBySide error. Install the Windows SDK and
set `ELECTRON_BUILDER_WINDOWS_KITS_PATH` to its `bin\<version>\x64` folder.

**The build succeeds but the window is blank.** Almost always a renderer error
before first paint. Run the packaged binary from a terminal to see the console
output, or check the diagnostics log under `%APPDATA%\RecoverX\logs`.
