# Release guide

## Versioning

Semantic versioning, with a product-specific reading of what counts as breaking:

| Change                                              | Bump      |
| --------------------------------------------------- | --------- |
| New module, new recovery capability                 | **minor** |
| Bug fix, UI refinement, performance                 | **patch** |
| Database schema change requiring migration          | **minor** |
| Licence-tier enforcement change                     | **major** |
| Dropping a supported OS, filesystem or device class | **major** |

Pre-releases use `-alpha.N` and `-beta.N`. The update channel is derived from the
version string, so a pre-release cannot reach stable users by mistake.

## Branching

- `main` is always releasable. CI must be green.
- Feature work happens on `feature/<module>` branches, merged by pull request.
- A release is a tag on `main` — there are no long-lived release branches.

## Cutting a release

### 1. Verify

```bash
npm run verify
```

```bash
npm run build && npm run test:e2e
```

Both must be clean. Do not release past a skipped test.

### 2. Version and changelog

```bash
npm version minor --no-git-tag-version
```

Update `CHANGELOG.md`. Write it for customers, not for the commit log:

```markdown
## 0.2.0 — 2026-08-14

### Added

- Disk detection: physical devices, volumes and partition tables are now listed
  with capacity, filesystem and health at a glance.

### Fixed

- The recovery destination no longer accepts a folder on the source drive.
```

### 3. Tag

```bash
git commit -am "release: 0.2.0" && git tag -a v0.2.0 -m "release 0.2.0" && git push --follow-tags
```

The tag must be **annotated** (`-a`): `--follow-tags` pushes annotated tags only,
so a lightweight `git tag v0.2.0` stays on your machine and CI never sees the
release. If one slipped through, push it explicitly: `git push origin v0.2.0`.

CI packages tagged builds. With signing material in the repository secrets and a
stable (non-pre-release) tag, it runs the Microsoft Store pipeline and uploads
`release/<version>/store/` as the `recoverx-microsoft-store` artefact. With a
certificate on a USB token, build on the machine it is plugged into instead:

```powershell
npm run package:store
```

(the signing variables are described in [BUILDING.md › Code signing](BUILDING.md#code-signing)).

### 4. Verify the artefact

`package:store` has already checked every PE file — the app, its DLLs,
`elevate.exe`, the installer and the uninstaller inside it — with
`Get-AuthenticodeSignature`, and refuses to stage anything unsigned or
untimestamped. Read `release/<version>/store/signature-report.json` and keep it
with the release.

Confirm the installer size is in the expected range — a sudden jump usually means
source maps or `node_modules` leaked into `files`.

### 5. Smoke-test on a clean VM

Never on a developer machine: it has state that hides first-run bugs.

- [ ] Installs without a SmartScreen block
- [ ] UAC prompt appears; the app launches to the Dashboard
- [ ] Title bar shows **Administrator**
- [ ] Start-up time on the About screen is under 3 s
- [ ] Settings persist across a restart
- [ ] Logs screen shows this session's records
- [ ] Silent install (`setup.exe /S`) exits 0 and shows nothing but UAC
- [ ] Silent uninstall (`"Uninstall RecoverX.exe" /S`) preserves `%APPDATA%\RecoverX`
- [ ] Interactive uninstall asks before removing it, with No preselected
- [ ] Reinstall retains settings and activation

### 6. Publish

Upload to the channel directory on the website's host — `public_html/updates/win/latest/`
on the AWS server (see [deploy/aws-ec2/README.md](../deploy/aws-ec2/README.md#deploying)) — **manifest
last**:

```
https://recoverx.snapkio.com/updates/win/latest/
  RecoverX-Setup-0.2.0-x64.exe
  RecoverX-Setup-0.2.0-x64.exe.blockmap
  latest.yml
```

Publishing `latest.yml` before the binary offers an update that cannot be
downloaded.

Then the Microsoft Store, which has its own, immutable copy:

1. Upload `release/<version>/store/RecoverX-Setup-<version>-x64.exe` to the
   versioned URL printed in `store/submission.md`
   (`https://recoverx.snapkio.com/downloads/win/<version>/…`, which is
   `public_html/downloads/win/<version>/` on the host). Never overwrite a file
   at a URL that has been submitted.
2. Partner Center → new submission → Packages: the new URL; update "What's new";
   mint fresh test keys for the Notes for certification; submit.
3. Point the website's download page and release notes at the new version
   (`website/content/release.json` and `releases.json`), rebuild the site and
   upload it — [website/README.md](../website/README.md).

The Store copy and the feed copy are the same bytes. Existing users, including
those who installed from the Store, update through the feed; the Store only
serves new installs. Step by step: [MICROSOFT-STORE.md › Every later release](MICROSOFT-STORE.md#9-every-later-release).

### 7. Confirm the update path

Install the previous version on a clean VM, launch it, and confirm it detects,
downloads and applies the update — then verify the About screen reports the new
version and schema.

## Staged rollout

For a release touching scanning or recovery, stage it:

1. Publish to `beta` and hold for 48 hours.
2. Watch crash reports and the error rate.
3. Promote to `latest` only if both are flat.

## Rollback

Auto-update has no downgrade path — `electron-updater` will not install an older
version, and **a downgrade is refused by the database migrator anyway**: a schema
version above what the build understands means old code would be reading a newer
schema, which is silent corruption.

To withdraw a release:

1. Restore the previous `latest.yml` (keep the last three) so no further clients
   are offered the bad build. In Partner Center, submit an update whose package
   URL is the previous version's — still hosted, because Store URLs are never
   removed — so new Store installs stop receiving the bad build too.
2. Leave the bad installer in place — clients mid-download will complete rather
   than fail, and it is already installed for some users.
3. Fix forward with a patch release. This is the only real remedy.
4. If the release corrupted data, ship a patch that detects the condition and
   repairs it on start-up, and notify affected customers directly.

**Practical implication:** a migration is effectively irreversible in the field.
Review schema changes with that in mind.

## Hotfix

For a crash or data-safety defect in production:

```bash
git checkout -b hotfix/0.2.1 v0.2.0
```

Fix, add a regression test that fails without the fix, then run the full
verification and release as a patch. Merge back to `main` immediately — a hotfix
that only exists on a tag will be lost by the next release.

## Post-release

- Watch crash reports for 72 hours.
- Confirm update adoption is climbing.
- Record anything that surprised you in this document. The release process is
  only as good as the last incident it learned from.
