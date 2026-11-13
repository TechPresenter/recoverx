# Deployment guide

How RecoverX is packaged, installed and updated on Windows 10 and 11 (x64).

---

## Producing an installer

```bash
npm run package:win
```

This runs `npm run build` (type-check + all three bundles), then electron-builder.
Output lands in `release/<version>/`:

```
RecoverX-Setup-0.1.0-x64.exe    NSIS installer
latest.yml                      auto-update manifest
*.blockmap                      differential-download index
```

Because the project ships **no native addons**, packaging needs no rebuild step
and no C++ toolchain — on a developer machine or a CI runner.

For a release, use `npm run package:store` instead: the same installer, signed
and verified, plus the Microsoft Store copy in `release/<version>/store/` (see
[Microsoft Store](#microsoft-store)).

## Installer configuration

Defined in `electron-builder.yml`.

| Setting                    | Value                  | Reason                                  |
| -------------------------- | ---------------------- | --------------------------------------- |
| `target`                   | NSIS, x64              | 64-bit only, as specified               |
| `oneClick`                 | `false`                | Users choose the install location       |
| `perMachine`               | `true`                 | Pairs with the elevation requirement    |
| `requestedExecutionLevel`  | `requireAdministrator` | See below                               |
| `deleteAppDataOnUninstall` | `false`                | Preserves the licence activation record |
| `include`                  | `build/installer.nsh`  | Opt-in data removal on uninstall        |
| `signExts`                 | six Electron DLLs      | Every PE file signed (Store 10.2.9)     |
| `signingHashAlgorithms`    | `sha256`               | One signature per file; no Windows 7    |
| `differentialPackage`      | `true`                 | Updates download only changed blocks    |
| `compression`              | `maximum`              | Installer size over packaging time      |
| `asar`                     | `true`                 | One archive; nothing needs unpacking    |

An interactive uninstall asks whether to remove `%APPDATA%\RecoverX` as well
(default No, Store Policy 10.2.7). A silent uninstall (`/S`) and the uninstall
an update performs never remove it.

Source maps are excluded from the installer. They are uploaded to the crash-report
symbol store separately during release.

### Why the application requires elevation

Reading deleted data means opening the raw block device (`\\.\PhysicalDriveN`)
and locking volumes. Both require an Administrator token, which is fixed at
process creation and cannot be acquired later.

The alternative — starting unelevated and relaunching when the user reaches a
scan — produces a half-initialised session where the device list is silently
empty. Requesting elevation up front is the model every commercial recovery suite
uses, and the Dashboard states the current state plainly either way.

`isElevated` on `system:get-snapshot` reports it; the title bar shows
**Administrator** or **Limited access** on every screen.

## Code signing

An unsigned installer triggers a SmartScreen warning that reads, to a customer,
as "this may be malware" — unacceptable for paid recovery software.

An **OV** certificate from a CA in the Microsoft Trusted Root Program is enough:
since 2024 EV certificates no longer bypass SmartScreen reputation, and the
Microsoft Store accepts OV. New certificates come on a USB token or in a cloud
HSM, not as a `.pfx`.

The certificate is selected per build, never committed:

| Variable                                | Certificate                                         |
| --------------------------------------- | --------------------------------------------------- |
| `WIN_CSC_SHA1` / `WIN_CSC_SUBJECT_NAME` | Token or KSP-backed HSM, from the certificate store |
| `WIN_SIGN_HOOK` + `WIN_PUBLISHER_NAME`  | Cloud HSM signed through its own tool               |
| `CSC_LINK` + `CSC_KEY_PASSWORD`         | Legacy `.pfx` (path or base64)                      |

`WIN_CSC_*` and `WIN_SIGN_HOOK` are applied by `npm run package:store`; plain
`npm run package:win` honours only `CSC_LINK`. Setup for each is in
[BUILDING.md › Code signing](BUILDING.md#code-signing). In CI the `.pfx`
comes from repository secrets (`WINDOWS_CERT_BASE64`, `WINDOWS_CERT_PASSWORD`).
Never commit certificate material — `build/*.pfx`, `*.p12` and `*.key` are
git-ignored.

`npm run package:store` verifies every PE file with `Get-AuthenticodeSignature`
after building and fails on anything unsigned or untimestamped. To check a
single file by hand:

```powershell
Get-AuthenticodeSignature "release\0.1.0\RecoverX-Setup-0.1.0-x64.exe" | Format-List Status, SignerCertificate, TimeStamperCertificate
```

## Microsoft Store

RecoverX is listed in the Microsoft Store as an **MSI/EXE app**: the Store
installs this same signed NSIS installer silently (`/S`) from an immutable,
versioned HTTPS URL, and installed copies keep updating through the feed below.
`npm run package:store` produces the Store copy and the Partner Center
submission sheet in `release/<version>/store/`. The full runbook — account,
certificate, hosting, listing, certification, and the optional MSIX route — is
[MICROSOFT-STORE.md](MICROSOFT-STORE.md).

## Installed layout

```
C:\Program Files\RecoverX\
  RecoverX.exe
  resources\app.asar          main, preload and renderer bundles
  Uninstall RecoverX.exe

%APPDATA%\RecoverX\
  recoverx.db                 settings, window state, licence, history
  recoverx.db-wal
  recoverx.db-shm
  logs\recoverx-YYYY-MM-DD.log
  temp\                       preview and extraction scratch
```

The data directory survives uninstall unless the user chooses otherwise in an
interactive uninstall, so a reinstall does not cost them their activation.
`RecoverX Recovered` in Documents (the default recovery destination) is never
touched by the uninstaller.

## Auto-update

`electron-updater` against a generic feed:

```yaml
publish:
  - provider: generic
    url: https://recoverx.snapkio.com/updates/win/${channel}
    channel: latest
```

The channel is derived from the version string, so a pre-release build cannot
publish to the stable feed:

| Version         | Channel  |
| --------------- | -------- |
| `1.2.0`         | `latest` |
| `1.2.0-beta.1`  | `beta`   |
| `1.2.0-alpha.3` | `alpha`  |

**Hosting requirements.** Any static host works, but it must support HTTP range
requests — differential updates depend on them. Serve `latest.yml`, the `.exe`
and the `.blockmap` from the same directory, over HTTPS.

The feed is a directory on the website's host (Apache on AWS EC2, which serves range
requests); [website/README.md](../website/README.md) says where it sits beside
the site's own files.

When the app contacts the feed:

- **Once per start, automatically**, about 15 seconds after the window opens,
  while Settings → "Check for updates automatically" (`autoCheckUpdates`) is on.
  It is on by default. A check that falls due during a scan or a recovery waits
  until that work has ended. Turning the setting on checks again a moment later.
  There is no periodic check.
- **On request**, when the user clicks **Check now** under **Updates** on the
  About screen.
- **Never** from a development build or a copy installed as an MSIX package
  (the Store updates those).

A check only asks; downloads happen only when the user asks, and are never
installed without confirmation. The privacy policy and the Store notes describe
exactly this, so change them first if it changes
(`src/main/updates/update.service.ts`).

## Release checklist

1. `npm run verify` — clean.
2. `npm run build && npm run test:e2e` — clean.
3. Bump `version` in `package.json`; update the changelog.
4. Tag `vX.Y.Z` as an **annotated** tag (`git tag -a`; see RELEASE.md) and push.
   CI packages tagged builds automatically — through the Store pipeline when
   signing material is configured.
5. `npm run package:store` (or the CI artefact) has verified every signature;
   keep its `store/signature-report.json` with the release.
6. Smoke-test the installer on a clean Windows 11 VM:
   - installs without a SmartScreen block
   - launches with the UAC prompt and reaches the Dashboard
   - **Administrator** badge is shown
   - Settings persist across a restart
   - a silent uninstall (`/S`) leaves `%APPDATA%\RecoverX` intact; an
     interactive one asks first, defaulting to keeping it
7. Publish `latest.yml`, the installer and the blockmap to the feed.
8. Verify an existing installation offers the update.
9. Host the Store copy at its new versioned URL and submit it in Partner Center
   ([MICROSOFT-STORE.md › Every later release](MICROSOFT-STORE.md#9-every-later-release)).

Full procedure and rollback: [RELEASE.md](RELEASE.md).

## Environment matrix

|                          | Supported                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Windows 11 (all builds)  | Yes                                                                                                        |
| Windows 10 21H2+ x64     | Yes                                                                                                        |
| Windows 10 32-bit        | No — 64-bit only                                                                                           |
| Windows Server 2019/2022 | Untested; expected to work                                                                                 |
| Windows on ARM           | Not built — an `arm64` target can be added to `electron-builder.yml` when demand justifies the test burden |

Virtual machines and remote-desktop sessions occasionally render incorrectly
under GPU compositing. Settings → Application → **Hardware acceleration** turns
it off; the change requires a restart because Chromium reads the switch before
any window exists.
