# Microsoft Store release runbook

How RecoverX goes from this repository to "In the Store", in order, for the publisher **Appsgain Technologies** (India). It is written to be followed step by step the first time and skimmed every release after that.

Everything here was checked against Microsoft Store Policies **v7.20** (published 15 September 2026, effective 22 October 2026) and the Microsoft Learn pages listed in [References](#references). Partner Center's screens change more often than its policies; where a step names a field, check its current wording on the page and in the linked Learn article.

| Piece                       | Where                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Release pipeline            | `npm run package:store` → [scripts/package-store.mjs](../scripts/package-store.mjs)            |
| Installer configuration     | [electron-builder.yml](../electron-builder.yml), [build/installer.nsh](../build/installer.nsh) |
| Optional MSIX configuration | [electron-builder.msix.yml](../electron-builder.msix.yml)                                      |
| Store artwork               | `npm run icon` → `build/store/`, `build/appx/`                                                 |
| Screenshots                 | `npm run store:screenshots` → `release/store-listing/screenshots/`                             |
| Listing text                | [docs/store/listing.en-US.md](store/listing.en-US.md)                                          |
| Notes for certification     | [docs/store/certification-notes.md](store/certification-notes.md)                              |
| Privacy policy              | [docs/store/privacy-policy.md](store/privacy-policy.md), published at `/privacy/`              |
| Website and download host   | [website/README.md](../website/README.md)                                                      |
| Licence server (production) | [server-php/README.md](../server-php/README.md)                                                |
| Licence server (reference)  | [docs/LICENSE-SERVER.md](LICENSE-SERVER.md)                                                    |

---

## Where things stand (12 November 2026)

- **Live (20 November 2026).** The MSIX product **"RecoverX Data Recovery"** (Store ID `9P7VHFQ36L0B`) passed certification, `allowElevation` included, and is in the Microsoft Store: https://apps.microsoft.com/detail/9P7VHFQ36L0B (deep link `ms-windows-store://pdp/?ProductId=9P7VHFQ36L0B`). Store updates go through **Start update** on that product, with a new MSIX built as in section 11. The EXE/MSI product below stays unsubmitted; it only holds the name "RecoverX".
- **Partner Center.** The **Company** account is registered and verified. The product **RecoverX** (EXE or MSI app, product ID `96a12f93-6602-4b98-939a-541e80154823`) was reserved on 12 November 2026, replacing an earlier reservation under the product's former name, since deleted; a reserved name lapses after three months without a submission, so submit by about **10 February 2027**. **Availability**, **Properties** (with the recoverx.snapkio.com URLs) and **Age ratings** are saved; nothing has been submitted.
- **Hosting.** Everything public lives on one host the vendor controls, `recoverx.snapkio.com`: one AWS EC2 server in Mumbai (Apache, PHP 8.3, no CDN; see deploy/aws-ec2/README.md). The installed app links only there and to appsgain.in.

| Path on https://recoverx.snapkio.com                            | What it is                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/`, `/buy/`, `/support/`, `/privacy/`, `/terms/`, `/releases/` | The static website ([website/README.md](../website/README.md))                            |
| `/downloads/win/<version>/`                                     | The installer, at one immutable URL per version (section 6)                               |
| `/updates/win/latest/`                                          | The electron-updater feed, replaced at every release ([RELEASE.md](RELEASE.md#6-publish)) |
| `/v1/activate`, `/v1/deactivate`, `/healthz`, `/admin/`         | The PHP licence server ([server-php/README.md](../server-php/README.md))                  |

---

## 1. Why the MSI/EXE route

The Store accepts desktop apps two ways: as an **MSIX package**, which Microsoft signs, hosts and updates; or as an **MSI/EXE listing** of the vendor's own installer, which Microsoft downloads from the vendor's server (Store Policy 10.2.9). RecoverX uses the MSI/EXE route, listing the same signed NSIS installer the website distributes, because of three properties the product cannot give up:

1. **It runs elevated.** Reading `\\.\PhysicalDriveN` and locking volumes needs an Administrator token, so the executable asks for one at launch (`requestedExecutionLevel: requireAdministrator`). 10.2.9 explicitly allows a UAC prompt. An MSIX app may only elevate with the restricted `allowElevation` capability, which Microsoft approves "under strict criteria" during certification — and an older MSIX guide still says elevated apps "won't be accepted". The vendor chose to try it first anyway, since it needs no certificate (section 11).
2. **It sells its own licences.** 10.8.1 lets a non-game PC app use its own commerce; the licence-key and activation system ([LICENSE-SERVER.md](LICENSE-SERVER.md)) stays as it is. 10.8.2 adds the conditions: no payment or registration step in the installer, a browser hand-off only after installation, and the use declared in Partner Center.
3. **It updates itself.** On the MSI/EXE route the Store never pushes updates ("the app or installer handles updates"), so `electron-updater` keeps serving existing users, Store-installed or not.

The price of the route: the vendor buys a code-signing certificate, signs **every** PE file, hosts the installer at an immutable HTTPS URL, and submits a new URL for every release.

**When MSIX would make sense.** If the app is ever split into a non-elevated interface and a small elevated helper, or Microsoft approves `allowElevation` in advance, MSIX brings free signing and hosting, Store-managed updates and Microsoft commerce. The configuration is ready for that day — see [Optional: the MSIX route](#11-optional-the-msix-route).

## 2. Decisions the vendor must take first

These are not engineering tasks, but each one can fail certification or a later audit.

1. **Prices.** 10.8.4 requires the listing to state what is sold outside the Store and the price range. Decided on 12 November 2026 and filled into the listing: Professional ₹2,499, Business ₹5,999 and Technician ₹14,999 a year, Enterprise on request. Change the listing and https://recoverx.snapkio.com/buy/ together.
2. **Licence terms.** Partner Center requires "Applicable license terms" for MSI/EXE apps. The repository's `LICENSE` names the licensor, Appsgain Technologies Private Limited, with its registered address; the website publishes it at https://recoverx.snapkio.com/terms/.
3. **Privacy policy.** `docs/store/privacy-policy.md` is the live policy, published by the website at https://recoverx.snapkio.com/privacy/. It promises that the activation event log the licence server keeps (which holds IP addresses) is deleted after 13 months, so the live server must enforce that.

## 3. Prerequisites checklist

Tick every line before the first submission.

### 3.1 Partner Center account

- [x] **Company** account (Policy 10.14 requires one for a business), registered free through https://storedeveloper.microsoft.com (the Company registration fee was removed on 7 May 2026).
- [x] Verification documents ready: a D-U-N-S number, or official business documents such as the certificate of incorporation, GST or other government registration, or tax filings; and an email address **on the company's own domain** for employment verification. Verification can take days to weeks — start it first.
- [ ] The publisher display name chosen; it appears on the listing.

### 3.2 Code-signing certificate

- [ ] An **OV (organisation-validated) code-signing certificate** from a CA in the [Microsoft Trusted Root Program](https://learn.microsoft.com/security/trusted-root/participants-list). Self-signed certificates are rejected, and Microsoft does not re-sign an MSI/EXE installer. Budget roughly US$150–300 a year.
- [ ] Bought from a CA whose code-signing root Microsoft trusts: DigiCert, Sectigo, GlobalSign and Certum qualify. **Not eMudhra (emSign)**: Microsoft blocked its code-signing intermediates on 20 Oct 2026 and is removing its roots (MSRC, Oct–Nov 2026). Best fit found on 13 Nov 2026: Certum Standard Code Signing in the Cloud (SimplySign), about €179–209 a year, no token to ship. **Do not use a certificate chaining to the CCA India roots**: those roots are in Microsoft's program without the Code Signing purpose, so the Store would not accept the signature.
- [ ] Organisation validation passed. CAs check the company in a government registry (for India the MCA company master data, or GST registration), a verified telephone number, and sometimes a D-U-N-S entry. Ask each CA (or its Indian reseller) about INR invoicing with GST, and which documents it accepts, before ordering.
- [ ] The key is on hardware. Since June 2023 every CA must generate code-signing keys on hardware certified to FIPS 140-2 Level 2 or Common Criteria EAL4+, so a new certificate arrives on a **USB token** (shipped to India, allow 1–3 weeks) or in a **cloud HSM** (DigiCert KeyLocker, SSL.com eSigner, Certum SimplySign, GlobalSign's equivalent). Cloud HSMs avoid shipping and work from CI; a token ties signing to one machine.
- [ ] EV is not needed: since 2024 EV certificates no longer bypass SmartScreen reputation, and the Store accepts OV.
- [ ] Not applicable: **Azure Artifact Signing** (formerly Trusted Signing) is not offered to organisations in India.

### 3.3 Licensing live

- [ ] The PHP licence server deployed on the website's host, and `GET https://recoverx.snapkio.com/healthz` answers `{"ok":true}` — [server-php/README.md](../server-php/README.md). The Node server in `src/server` is the reference implementation of the same contract, for a VPS or a container ([LICENSE-SERVER.md](LICENSE-SERVER.md)).
- [ ] Signing key pair created once — by the PHP server's one-time `/setup/`, or with `npm run licensing:keys` and imported there — and a backup of the private key kept offline.
- [ ] `RECOVERX_LICENSE_PUBLIC_KEY` (shown by `/setup/`) and `RECOVERX_ACTIVATION_URL` (`https://recoverx.snapkio.com/v1/activate`) set in the build environment (shell, `.env.production`, or the CI repository variables of the same names). They are compiled in at build time; `package-store` refuses to package a build without them, because such a build rejects every key a customer buys.
- [ ] A way to issue keys on purchase. For now a customer buys by emailing info@appsgain.in, and the vendor creates the key in the admin panel (`/admin/`). A payment link whose webhook calls the admin API can replace that later; [LICENSE-SERVER.md › A payment webhook](LICENSE-SERVER.md#a-payment-webhook) describes the contract.

### 3.4 Privacy policy and web pages

- [ ] Privacy policy published at **https://recoverx.snapkio.com/privacy/** — the address compiled into the app (`PRIVACY_URL` in `src/shared/constants/app.ts`) and required by Policy 10.5.1 for every Win32 app, whatever it does online.
- [ ] https://recoverx.snapkio.com/, https://recoverx.snapkio.com/buy/ (the in-app Buy button), https://recoverx.snapkio.com/support/ (the documentation link) and info@appsgain.in working.

### 3.5 Download host

- [ ] The installer hosted under `https://recoverx.snapkio.com/downloads/win/` (static files on the website's AWS EC2 host): valid TLS certificate, no login, no expiring or signed links, no redirect to HTTP, reachable from every market you sell in. The host has no write-once protection, so the rule in section 6 — never replace a published file — is kept by procedure alone.

### 3.6 Build machine

- [ ] Windows 10/11 x64, Node 24+, `npm ci` done.
- [ ] 7-Zip installed (`winget install 7zip.7zip`): the pipeline extracts the uninstaller from the installer to check its signature. GitHub's `windows-latest` runner already has it.
- [ ] The token's driver (e.g. SafeNet Authentication Client) or the cloud HSM's client tools installed, and the certificate visible in `certmgr.msc` → Personal → Certificates.

## 4. Build, sign and verify

```powershell
$env:RECOVERX_LICENSE_PUBLIC_KEY = '<base64 from npm run licensing:keys>'
$env:RECOVERX_ACTIVATION_URL     = 'https://recoverx.snapkio.com/v1/activate'
$env:WIN_CSC_SHA1                = '<certificate thumbprint>'      # see below
npm run package:store
```

`package:store` runs `npm run icon`, `npm run build`, then `scripts/package-store.mjs`, which:

1. **Preflight** — fails, listing every problem with its fix, when: the public key or activation URL is missing, malformed, not `https`, or different from what `out/` was built with; the version is a pre-release; no signing material (or more than one kind) is configured; or 7-Zip is missing.
2. **Builds** the NSIS installer (x64) with `forceCodeSigning`, so any file that fails to sign stops the build.
3. **Verifies** every PE file with `Get-AuthenticodeSignature`: everything in `win-unpacked` (detected by content, not extension), `resources\elevate.exe`, the installer, and the uninstaller extracted back out of the installer. Each must be **Valid** and **timestamped**, all by the same certificate. Microsoft's own `d3dcompiler_47.dll` and `dxil.dll` keep Microsoft's signature.
4. **Stages** `release/<version>/store/`:
   - `RecoverX-Setup-<version>-x64.exe` — the verified installer (same name and bytes as electron-builder's `release/<version>/RecoverX-Setup-<version>-x64.exe`),
   - `…exe.sha256`,
   - `submission.md` / `submission.json` — the package URL, architecture, language, `/S`, the return-code table: exactly what Partner Center asks for,
   - `signature-report.json` — the evidence.

`node scripts/package-store.mjs --help` lists every option and variable. `RECOVERX_STORE_DOWNLOAD_BASE` changes the host (default `https://recoverx.snapkio.com/downloads/win`). Dry runs for testing the pipeline itself — `--unsigned`, `--allow-unlicensed`, `--allow-untrusted-signatures`, `--override-version` — write to `release/<version>-NOT-FOR-SUBMISSION/` and stamp every file name and the submission sheet **NOT-FOR-SUBMISSION**.

> Every `RECOVERX_*` variable present during the build is compiled into the app by electron-vite. That is how the licence settings get in, and it is why no secret may ever be put in a variable with that prefix. The signing variables deliberately use other names.

### 4.1 Choosing the signing variables

Set exactly one of these (details and the reasons in [BUILDING.md › Code signing](BUILDING.md#code-signing)):

| Certificate                                                                                         | Variables                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| USB token, or a cloud HSM with a Windows KSP/CSP (DigiCert KeyLocker, Certum SimplySign Desktop, …) | `WIN_CSC_SHA1` = thumbprint (and/or `WIN_CSC_SUBJECT_NAME`)                                                                     |
| Cloud HSM driven by its own command-line tool (SSL.com CodeSignTool, jsign with a cloud KMS, …)     | `WIN_SIGN_HOOK` = path to a signing module, `WIN_PUBLISHER_NAME` = the certificate subject's CN exactly (legal suffix included) |
| Legacy `.pfx` file (certificates issued before June 2023)                                           | `CSC_LINK`, `CSC_KEY_PASSWORD`                                                                                                  |

Find the thumbprint of a token or KSP certificate:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter
```

A token asks for its PIN when signing starts. The build signs eight files, the seven NSIS plug-ins the installer and uninstaller embed, and the installer and uninstaller themselves, one SHA-256 signature each; enable the token client's "single logon" option if it asks every time.

The publisher name matters as much as the signature: electron-builder writes it into the app's `resourcesapp-update.yml`, and every installed copy refuses an update whose signer does not match it. With a token, KSP or `.pfx` it is read from the certificate; with a hook it is `WIN_PUBLISHER_NAME`, which must be the CN exactly as the CA issued it ("Appsgain Technologies Private Limited" is not "Appsgain Technologies"). `package-store` compares it with the installer's actual signer and refuses to stage a build where they differ.

## 5. Smoke-test the installer on a clean VM

Never on a development machine. Use a fresh Windows 11 (24H2 or later) VM, and repeat on Windows 10 22H2, both from a clean snapshot. Copy the staged installer in, then in **Windows PowerShell as Administrator**:

```powershell
$setup = Start-Process .\RecoverX-Setup-<version>-x64.exe -ArgumentList '/S' -Wait -PassThru
$setup.ExitCode                       # 0
Test-Path 'C:\Program Files\RecoverX\RecoverX.exe'                       # True
Get-AuthenticodeSignature 'C:\Program Files\RecoverX\*.exe','C:\Program Files\RecoverX\*.dll' |
  Format-Table Status, Path            # all Valid
```

- [ ] `/S` showed no window apart from the UAC prompt, and did not launch the app (the Store installs exactly this way).
- [ ] The Start menu entry starts the app after a UAC prompt; the title bar shows **Administrator**; the Licence screen shows the Free edition.
- [ ] A test key activates (online), and **Remove from this computer** releases it.
- [ ] The certification test in `docs/store/certification-notes.md` passes end to end with a USB stick.
- [ ] Running the installer again over the installed copy succeeds (exit 0).
- [ ] As a **standard user**: installing asks for an administrator's credentials and succeeds.

Uninstall silently, then interactively on a second snapshot:

```powershell
$un = Start-Process 'C:\Program Files\RecoverX\Uninstall RecoverX.exe' -ArgumentList '/S' -Wait -PassThru
$un.ExitCode                                        # 0
Test-Path 'C:\Program Files\RecoverX'            # False (allow a few seconds)
Test-Path "$env:APPDATA\RecoverX"                # True — a silent uninstall keeps user data
```

- [ ] An interactive uninstall (Settings → Apps → RecoverX → Uninstall) asks whether to remove settings, history and licence data, with **No** preselected; **Yes** removes `%APPDATA%\RecoverX`; recovered files are untouched either way.

## 6. Host the installer at an immutable URL

Upload `release/<version>/store/RecoverX-Setup-<version>-x64.exe` to the URL in `submission.md`:

```
https://recoverx.snapkio.com/downloads/win/<version>/RecoverX-Setup-<version>-x64.exe
```

On the host that is `public_html/downloads/win/<version>/` ([website/README.md](../website/README.md)).

- Serve it as `application/octet-stream` (or `application/x-msdownload`) with a long `Cache-Control`; it never changes.
- Check from outside your network: `curl -sSfIL <url>` returns 200 over HTTPS, and a full download matches the `.sha256`.
- **Never replace, rename or delete a file at a URL that has been submitted.** Partner Center records the URL, certification re-downloads it, and customers mid-install fetch it. A change in place is a different binary under a certified URL. A fix ships as a new version at a new URL.

The update feed lives on the same host in a different directory (`https://recoverx.snapkio.com/updates/win/latest/`, see [RELEASE.md](RELEASE.md)), which is overwritten every release by design. Never mix the two.

## 7. Partner Center, step by step

### 7.1 Reserve the name

Partner Center → **Apps and games** → **New product** → **EXE or MSI app** → reserve **RecoverX**. Names are unique across the Store; reserving does not publish anything. (Learn: _Reserve your app's name_.) **Done on 12 November 2026** (product ID `96a12f93-6602-4b98-939a-541e80154823`); the reservation lapses if nothing is submitted within three months.

### 7.2 Packages

The submission's **Packages** page:

| Field                | Value (from `submission.md`)                                                            |
| -------------------- | --------------------------------------------------------------------------------------- |
| Package URL          | `https://recoverx.snapkio.com/downloads/win/<version>/RecoverX-Setup-<version>-x64.exe` |
| Architecture         | x64                                                                                     |
| Languages            | English (United States)                                                                 |
| App type             | EXE                                                                                     |
| Installer parameters | `/S`                                                                                    |

Add the **installer return codes** from `submission.md`: `0` Installation successful; `1` and `1223` Installation cancelled by user; `2` Miscellaneous. Partner Center checks the URL when you save; it must answer at once.

### 7.3 Properties

A draft is saved (12 November 2026); check it against these values before submitting.

- **Category:** Utilities + tools; subcategory **Backup + manage** if offered.
- **Privacy policy URL:** `https://recoverx.snapkio.com/privacy/`.
- **Website:** `https://recoverx.snapkio.com/`. **Support contact:** `info@appsgain.in`.
- **System requirements:** leave the hardware checkboxes at their defaults; the free-text lines are in the listing file.

### 7.4 Age ratings

A draft is saved (12 November 2026).

Complete the IARC questionnaire honestly: a utility, with no violence, sexual content, gambling or user-to-user communication; it does not share location; it **does** offer digital purchases (licence keys, on the website); it opens the vendor's website in the browser. Expect the lowest rating band (e.g. PEGI 3 / ESRB Everyone).

### 7.5 Product declarations

- **Depends on non-Microsoft drivers or NT services:** No (Policy 10.2.4).
- **Generative AI:** No — no feature in the code uses machine learning or any other AI technique; recovery is file-system parsing and signature carving.
- **Accessibility:** tick only if the app has actually been tested against Microsoft's accessibility guidelines.
- **Notes for certification:** paste the block from [docs/store/certification-notes.md](store/certification-notes.md) after minting the two test keys it describes (≤ 2,000 characters; the file shows how to check).

### 7.6 Pricing and availability

A draft of **Availability** is saved (12 November 2026).

- **Pricing:** **Freemium** — the Free edition is functional with a limit, and paid editions are bought outside the Store. No free trial is needed for Freemium.
- **Third-party commerce:** Policy 10.8.2 requires noting the use of a third-party purchase system in Partner Center. If the MSI/EXE flow shows a checkbox or field for it, use it; the Notes for certification also state it. (At the time of writing it was unconfirmed whether the MSI/EXE flow has a dedicated control — check the live page.)
- **Markets:** all markets you can support in English; the listing is en-US only.
- **Visibility:** public. (MSI/EXE apps cannot be flighted or privately audienced.)

### 7.7 Store listing (English, United States)

Paste each field from [docs/store/listing.en-US.md](store/listing.en-US.md): description (≤ 10,000), what's new, up to 20 features, up to 7 search terms (no pricing words), copyright, applicable licence terms, developed by, additional system requirements.

Images:

- **Screenshots** (PNG, ≥ 1366×768, up to 10, 4–8 recommended): `npm run build`, then `npm run store:screenshots` from an **elevated** terminal on a clean test machine or VM with a test USB stick attached. Add a scan-in-progress, a results-with-preview and a recover-dialog shot by hand. The Dashboard shows the computer's name and the Licence screen its computer ID: capture on a machine whose name you are happy to publish.
- **1:1 box art** (required): `build/store/box-art-2160.png` (or `box-art-1080.png`).
- **1:1 app tile icon** (300×300): `build/store/store-logo-300.png`.

### 7.8 Submit

Review the summary, then **Submit for certification**. Keep the licence server and the download URL up until the product is published.

## 8. Certification: what to expect

Certification of an MSI/EXE app typically takes a few business days and runs security scans, a silent install from the URL, and a manual review. Common reasons RecoverX could be sent back, and what prevents them:

| Rejection                                                                                     | Prevention                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unsigned PE file (10.2.9)                                                                     | `package-store` verifies every file; never upload a build it did not pass.                                                 |
| Silent install shows UI or fails                                                              | Section 5 test with `/S`; the assisted installer is silent under `/S` except for UAC, which is allowed.                    |
| Package URL unreachable, redirects or changed                                                 | Section 6; never reuse a URL.                                                                                              |
| Tester could not reach paid features (10.3)                                                   | Working test keys in the notes; licence server online.                                                                     |
| Listing over-states the product (10.1.1)                                                      | The listing describes only what the code does, and every claim names the module that backs it.                             |
| Free-tier limits not disclosed (10.8.4)                                                       | The 1 GB limit is in the description, short description, features and screenshots, and shown in the app before a recovery. |
| Installer bundles or offers other software, or asks for payment/registration (10.2.9, 10.8.2) | It does neither; purchases are on the website after installation.                                                          |
| Privacy policy missing or inadequate (10.5.1)                                                 | Section 3.4.                                                                                                               |
| Uninstall leaves data behind without choice (10.2.7)                                          | The interactive uninstaller offers removal.                                                                                |
| "Unwanted software" signals: alarmist scan wording, pressure to buy                           | The app reports findings factually and never claims a file is recoverable without evidence; keep it that way.              |

Residual risks worth knowing before the first submission:

- **"Installs under a standard user account."** Microsoft's checklist says the installer must work for a standard user. A per-machine installer does so by asking for an administrator's credentials, which section 5 tests; how certification treats that prompt is not documented.
- **The certification report** arrives in Partner Center with specific findings; fix exactly those and resubmit with a new versioned URL if the binary changes.

## 9. Every later release

1. Follow [RELEASE.md](RELEASE.md) to version, verify and tag.
2. `npm run package:store` (or take the `recoverx-microsoft-store` artifact from the tagged CI run when CI holds the signing material).
3. Smoke-test (section 5) and upload to a **new** versioned URL (section 6).
4. Publish the update feed as before — `latest.yml`, the installer and its blockmap under `https://recoverx.snapkio.com/updates/win/latest/`. Existing installations, including Store-installed ones, update through `electron-updater`; the Store never updates an MSI/EXE app.
5. Partner Center → the app → **Update** (new submission) → **Packages**: replace the package URL with the new one → update **What's new** → mint fresh test keys and update the **Notes for certification** → **Submit**. New Store customers get the new version once it passes.
6. After publication, revoke the previous submission's test keys.

Every update must stay within the functionality described in the listing (Policy 10.2.2); change the listing in the same submission when features change.

## 10. Code signing in CI

The tagged `package` job in `.github/workflows/ci.yml` builds the app, then runs `scripts/package-store.mjs` when signing material is available (`WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD` secrets for a `.pfx`, or a `WIN_SIGN_HOOK` repository variable plus the hook's own secrets) and the tag is not a pre-release, and uploads `release/**/store/**` as the `recoverx-microsoft-store` artifact. Otherwise it builds the installer as before. The signing secrets are given to the signing step only — never at job level, where `npm ci` runs every dependency's install scripts — so add a hook's credentials to the `env:` of the "Sign, verify and stage for the Microsoft Store" step. A USB token cannot be used by a hosted runner; with a token, run `npm run package:store` on the machine it is plugged into.

Repository variables used: `RECOVERX_LICENSE_PUBLIC_KEY`, `RECOVERX_ACTIVATION_URL`, `RECOVERX_STORE_DOWNLOAD_BASE`, `WIN_SIGN_HOOK`, `WIN_PUBLISHER_NAME`.

## 11. Optional: the MSIX route

Chosen by the vendor on 13 November 2026 as the free route: Microsoft signs MSIX packages, so no code-signing certificate is needed for the Store.

1. **Justify the capability in the submission.** Since 12 November 2026 Microsoft Learn no longer asks for an email to reportapp@microsoft.com beforehand (that address remains the certification-questions mailbox). After the package is uploaded, Partner Center shows **Submission options → Restricted capabilities**; explain `allowElevation` and `runFullTrust` there (text in [certification-notes.md](store/certification-notes.md)). Testers decide during certification; a refusal fails the submission with a reason. Precedent: Rufus (9PC3H3V7Q9CH) and Intel Optane Memory and Storage Management ship on the Store with `allowElevation`. If refused, the fallback is a non-elevated UI with a small elevated helper started with ShellExecuteEx `runas` (as Windows Terminal does), or the signed EXE route.
2. **A product for it.** Partner Center fixes a product's type (MSI/EXE or MSIX) when it is created. The MSIX product is **"RecoverX Data Recovery"**, Store ID **9P7VHFQ36L0B**. The name "RecoverX" stays reserved on the EXE product (96a12f93-…): Partner Center reported it "not available" for the new product after it was deleted from the EXE one, so it was reserved back there. It can be added to the MSIX product later through a support ticket. `appx.displayName` must equal a name reserved on the MSIX product.
   - Known risk: the app starts `powershell.exe` for the drive list (`src/main/disk/device-enumerator.ts`) and SMART data (`src/main/health/health.service.ts`). Microsoft's MSIX preparation guide says to avoid starting PowerShell (Windows 10 S compatibility), so certification may object; the fix is native calls instead.
3. **Version.** MSIX versions are four-part, the first part may not be 0 and the last must be 0: release **1.0.0** or later.
4. **Identity.** From Partner Center → the product → **Product management → Product identity**, copy exactly (case-sensitive):

   ```powershell
   $env:RECOVERX_STORE_IDENTITY_NAME            = '<Package/Identity/Name>'
   # Publisher is pasted as shown, with its own CN= (e.g. CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX)
   $env:RECOVERX_STORE_PUBLISHER                = '<Package/Identity/Publisher value>'
   $env:RECOVERX_STORE_PUBLISHER_DISPLAY_NAME   = '<Package/Properties/PublisherDisplayName>'
   ```

5. **Build** with no signing variables set (the Store signs MSIX packages itself; the script refuses `CSC_*`/`WIN_CSC_*`/`WIN_SIGN_HOOK`/`AZURE_SIGN_*`):

   ```powershell
   npm run icon; npm run build; node scripts/package-store.mjs --msix
   ```

   If it stops with "makeappx.exe could not be started (spawn UNKNOWN)" and Event Viewer shows a SideBySide error for `Microsoft.Windows.Build.Appx.AppxPackaging.dll`, the cause is the `@` in electron-builder's cache folder (`%LOCALAPPDATA%\electron-builder\Cache\win-codesign@1.1.0\…`): Windows' side-by-side loader does not find makeappx's private assemblies there. Copy that bundle's `x64` folder to a plain path and point electron-builder at it, or install the Windows SDK:

   ```powershell
   Copy-Item "$env:LOCALAPPDATA\electron-builder\Cache\win-codesign@1.1.0\windows-kits-bundle-*\x64" C:\tools\windows-kits-x64 -Recurse
   $env:ELECTRON_BUILDER_WINDOWS_KITS_PATH = 'C:\tools\windows-kits-x64'
   ```

   The script checks the package it built: identity, `runFullTrust` + `allowElevation`, no `app-update.yml` (the app's update service also stands aside when `process.windowsStore` is true), the `build/appx` tile set compiled into `resources.pri` rather than electron-builder's placeholder images, and that the package is unsigned. Output: `release/<version>/store/RecoverX-<version>-x64.appx`.

6. **Sideload-test on a VM.** Create a test certificate whose subject equals the Publisher exactly, sign a **copy** of the package with it, trust the certificate on the VM only, and install:

   ```powershell
   # elevated PowerShell, on the test VM
   $cert = New-SelfSignedCertificate -Type Custom -Subject $env:RECOVERX_STORE_PUBLISHER -KeyUsage DigitalSignature `
     -FriendlyName 'RecoverX MSIX test' -CertStoreLocation 'Cert:\CurrentUser\My' `
     -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
   $pfxPassword = Read-Host -AsSecureString 'Choose a password for the test certificate'
   Export-PfxCertificate -Cert $cert -FilePath .\msix-test.pfx -Password $pfxPassword
   Copy-Item .\RecoverX-1.0.0-x64.appx .\test-copy.appx
   & "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" sign /fd SHA256 /f .\msix-test.pfx /p '<password>' .\test-copy.appx
   Import-PfxCertificate -FilePath .\msix-test.pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pfxPassword
   Add-AppxPackage .\test-copy.appx
   ```

   Test elevation, raw-disk scanning, recovery, activation and the paths shown on the About screen (user data is virtualised under `%LOCALAPPDATA%\Packages\<package family>\LocalCache` and deleted on uninstall; re-activating on the same machine is idempotent on the licence server). Leave it installed for step 7. Never upload the test-signed copy.

7. **Windows App Certification Kit.** From the Windows SDK, on the VM, against the test-signed copy installed in step 6 — WACK has to deploy and launch what it tests, and the unsigned Store upload cannot be installed:

   ```powershell
   # elevated PowerShell, on the test VM
   $appcert = "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\appcert.exe"
   $package = Get-AppxPackage -Name $env:RECOVERX_STORE_IDENTITY_NAME
   & $appcert reset
   & $appcert test -packagefullname $package.PackageFullName -reportoutputpath .\wack.xml
   ```

   Expect the elevation-related test to need the approval from step 1. Afterwards remove the package (`Remove-AppxPackage $package.PackageFullName`) and the test certificate from `Cert:\LocalMachine\TrustedPeople`.

8. **Submit** the unsigned `.appx` from `release/<version>/store/`, with the restricted-capability justification and the same listing and notes.

Known gaps before MSIX could ship: the machine identifier is read by spawning `reg.exe`, which S mode blocks (MSIX would not run in S mode anyway while it elevates).

## References

Microsoft Store Policies and Partner Center (Microsoft Learn):

- Microsoft Store Policies v7.20 — https://learn.microsoft.com/windows/apps/publish/store-policies (10.1.1 metadata, 10.2.2 functionality, 10.2.4 drivers and services, 10.2.7 uninstall, 10.2.9 MSI/EXE requirements, 10.3 testability, 10.5.1 privacy policy, 10.8.1–10.8.4 commerce, 10.14 account type)
- Create an MSI/EXE app submission — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/create-app-submission
- MSI/EXE app package requirements — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/app-package-requirements
- Upload MSI/EXE app packages — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/upload-app-packages
- Store listing for MSI/EXE apps — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/add-and-edit-store-listing-info
- Screenshots and images — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/screenshots-and-images
- Reserve your app's name — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/reserve-your-apps-name
- Age ratings — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/age-ratings
- Partner Center developer registration — https://storedeveloper.microsoft.com

Signing and MSIX:

- Microsoft Trusted Root Program participants — https://learn.microsoft.com/security/trusted-root/participants-list
- App capability declarations (`allowElevation`) — https://learn.microsoft.com/windows/uwp/packaging/app-capability-declarations
- MSIX app package requirements — https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements
- Create a certificate for package signing — https://learn.microsoft.com/windows/msix/package/create-certificate-package-signing
- Sign an app package using SignTool — https://learn.microsoft.com/windows/msix/package/sign-app-package-using-signtool
- Windows App Certification Kit — https://learn.microsoft.com/windows/uwp/debug-test-perf/windows-app-certification-kit
