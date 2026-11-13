# Notes for certification

Paste the text inside the block below into **Partner Center → your app → the submission → Submission options (or Product declarations) → Notes for certification**. The field takes at most **2,000 characters**. This text is **1,961** characters with the placeholders as written, and **1,975** once both are replaced by real keys (`RECX-XXXXX-XXXXX-XXXXX-XXXXX`, 28 characters each) — 25 to spare. Re-check after any edit (command at the end).

Before every submission:

1. Mint two keys on the production licence server — the PHP one at https://recoverx.snapkio.com ([server-php/README.md](../../server-php/README.md)) — one per edition, valid for 60 days and usable on any number of test machines, and tagged so they are easy to find and revoke afterwards. In the admin panel, https://recoverx.snapkio.com/admin/ → create licences, twice:

   | Field         | Professional key              | Business key                  |
   | ------------- | ----------------------------- | ----------------------------- |
   | Edition       | Professional                  | Business                      |
   | Registered to | Microsoft Store certification | Microsoft Store certification |
   | Seats         | unlimited                     | unlimited                     |
   | Expiry        | 60 days                       | 60 days                       |
   | Order ref     | `MS-CERT-<version>-PRO`       | `MS-CERT-<version>-BIZ`       |
   | Notes         | Certification test key        | Certification test key        |

   The order reference makes a repeat idempotent: the same order gives back the same key. Revoke both keys (reason "certification finished") once the submission is published. Against the Node reference server instead, the admin CLI does the same — `create --edition professional --seats unlimited --days 60 --to "Microsoft Store certification" --order MS-CERT-<version>-PRO --notes "Certification test key"`, see [LICENSE-SERVER.md › Admin CLI cookbook](../LICENSE-SERVER.md#admin-cli-cookbook).

2. Replace `<PROFESSIONAL-TEST-KEY>` and `<BUSINESS-TEST-KEY>` below.
3. Confirm `https://recoverx.snapkio.com/healthz` answers `{"ok":true}`, and keep the server up until the submission is published. Certification can take several days, and a tester whose activation fails will fail the submission (Store Policy 10.3).
4. Re-check the length (command below) if you edit the text.

```text
RecoverX recovers deleted files. It reads disks directly (\\.\PhysicalDriveN) and locks volumes, which Windows allows only to an elevated process, so it installs per-machine and asks for Administrator rights (UAC) at every launch. It installs no drivers, NT services or scheduled tasks, and starts nothing at sign-in.

The source disk is only ever read. Recovered files must be saved to a different drive; the app refuses the source drive.

Safe test (5 minutes):
1. Copy a few photos to a USB stick, delete them, leave the stick plugged in.
2. Start RecoverX and accept UAC. The title bar shows "Administrator".
3. Scan > "I deleted files" > pick the USB stick's volume > Start quick scan.
4. Select the deleted photos, preview one, then Recover selected and save to a folder on C:.
A scan can be paused or stopped at any time.

Free edition: no key or account needed. Scanning and preview are unlimited; recovery is limited to 1 GB in total, and the app says so before a recovery starts.

Paid editions remove the limit. To test them: Licence > Online > enter a key > Activate.
Professional: <PROFESSIONAL-TEST-KEY>
Business: <BUSINESS-TEST-KEY>
Both work on any number of machines for 60 days. Activation sends the key and a hashed machine ID to https://recoverx.snapkio.com, which stays online during certification. "Remove from this computer" releases the seat.

Purchases are made on our website, opened in the browser from Licence > "Buy a licence" after installation. Nothing is sold or registered in the installer, and the app does not use Microsoft commerce.

Silent install: /S. Uninstall from Settings > Apps, or run "Uninstall RecoverX.exe" /S from the install folder. An interactive uninstall asks whether to also delete settings, history and licence data (default: No); a silent one keeps them.

Updates: checked once after each start unless turned off in Settings, and on About > Check now; downloaded only when asked.

Contact: info@appsgain.in
```

## Checking the length

Partner Center counts characters, not bytes, and counts a line break as one. From the repository root:

```bash
node -e "const t=require('fs').readFileSync('docs/store/certification-notes.md','utf8').replace(/\r\n/g,'\n');const b=t.split('\`\`\`text\n')[1].split('\n\`\`\`')[0];console.log([...b].length,'characters')"
```

It must print 2000 or less.

## Why each paragraph is there

- **Elevation, drivers, services** — Store Policy 10.2.4 generally disallows non-Microsoft drivers and NT services and asks for any to be disclosed here; saying "none" up front stops a reviewer from looking for them. The UAC prompt is permitted for MSI/EXE apps (10.2.9), but a reviewer meeting it on every launch deserves the reason.
- **Read-only source** — a data-recovery tool that wrote to the disk it is recovering from would be the "unexpected" behaviour 10.2.2 forbids. The destination guard (src/main/recovery/destination-guard.ts) enforces it.
- **Safe test** — certifiers run apps on real hardware and VMs; a test that needs only a USB stick and never touches the system disk is one they can complete.
- **Free edition and keys** — 10.3 requires that a tester can reach all functionality; 10.8.4 that limits of a free tier are stated. The 1 GB ceiling (exactly 1 GiB) is enforced in the main process (src/main/licensing/license.service.ts) and announced in the recovery dialog.
- **Purchases** — 10.8.2 allows third-party commerce for a non-game PC app provided nothing is sold in the installer and the use is declared; this restates the declaration.
- **Uninstall** — 10.2.7. The prompt is build/installer.nsh.

## Restricted capabilities (MSIX product only)

The MSIX product "RecoverX Data Recovery" (9P7VHFQ36L0B) declares `runFullTrust` and `allowElevation`. After the package is uploaded, paste this under **Submission options → Restricted capabilities** (897 characters):

```text
RecoverX is a data-recovery tool. To recover deleted and lost files it reads storage devices at sector level: it opens raw block devices (\.\PhysicalDriveN) and locks volumes. Windows allows both only to an elevated process, and there is no brokered API for this, so the main executable declares requireAdministrator and the package declares allowElevation. runFullTrust is needed because RecoverX is a Win32 (Electron) desktop app.
How elevation is used: Windows shows its standard UAC prompt once, when the user starts the app. No elevated disk work happens until the user picks a drive and starts a scan. The source disk is only read, never written. Recovered files are written only to a different drive that the user chooses.
RecoverX installs no drivers or services. It works offline; its only network use is licence activation over HTTPS.
Reviewer test steps are in Notes for certification.
```

### Notes for the MSIX product

For the MSIX product the notes go under **Supplemental info → Additional Testing Information** (product level). That page asks for keys to go under **Credentials**, not in the description. The EXE text above does not fit MSIX: there is no `/S` installer, no NSIS uninstall prompt, and no self-updater. The text saved on 13 November 2026 is the block above with these changes:

- The first paragraph ends "…so it asks for Administrator rights (UAC) at every launch; this is why the package declares allowElevation."
- Step 2 is just "Start RecoverX and accept UAC."
- The key lines are replaced by: "Every feature can be tested in [the Free edition] … Paid editions only remove that limit. If you need a paid test licence key, email info@appsgain.in and we will send one the same day." Partner Center treats keys as credentials, and Claude does not type credentials into it. The vendor can add the two keys under **Credentials** (New credential) at any time.
- The silent-install and update paragraphs are replaced by "Updates come only from the Microsoft Store; the app's own updater is switched off in the Store package. Uninstalling removes the app and its data."

Submission 1 was submitted for certification on 13 November 2026. Its test keys were minted the same day, valid until 12 January 2027: order references `MS-CERT-1.0.0-PRO` and `MS-CERT-1.0.0-BIZ`. Revoke both once the app is published.
