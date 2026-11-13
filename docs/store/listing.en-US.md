# Store listing — English (United States)

Ready-to-paste text for **Partner Center → your app → Store listings → English (United States)**. Each heading is a Partner Center field; paste what is inside the block beneath it. Limits are Partner Center's.

Every claim here was checked against the code (`src/main/scan`, `recovery`, `preview`, `health`, `disk`, `licensing`). Store Policy 10.1.1 forbids listing what the product does not do, so **re-check this file whenever a feature changes** — and do not add marketing claims that the code does not back.

> **Before pasting:** make sure the privacy policy is live at https://recoverx.snapkio.com/privacy/ and the prices below still match https://recoverx.snapkio.com/buy/. Policy 10.8.4 requires the price range of what is sold outside the Store to be stated; these are the vendor's approved annual prices of 12 November 2026.

> **MSIX product ("RecoverX Data Recovery", Store ID 9P7VHFQ36L0B), filled on 13 November 2026:** the product name is "RecoverX Data Recovery". In the Description PRIVACY paragraph, the update-server sentence is replaced by "Updates are delivered by the Microsoft Store.", because the Store package does not contact the update server. The Applicable license terms field does not exist for MSIX. Screenshots so far are Scan and History, taken without elevation; replace them with elevated screenshots from a clean machine.

---

## Product name

Reserved in Partner Center; must match exactly.

```text
RecoverX
```

## Short title (≤ 50)

```text
RecoverX
```

## Short description (≤ 1,000)

```text
Recover deleted, formatted and lost files from hard disks, SSDs, USB drives and memory cards. Read-only scanning, preview before you recover, and recovered files are always saved to a different drive. The Free edition recovers up to 1 GB in total; paid editions remove the limit.
```

## Description (≤ 10,000)

```text
RecoverX finds files that were deleted, lost to a format, or stranded on a drive Windows can no longer open, and copies them to safety.

FREE EDITION AND PAID EDITIONS
• Free edition: for personal use, and for anyone to try RecoverX; no key and no account. Scanning and preview are unlimited. Recovery is limited to 1 GB of recovered files in total on each computer, counting every recovery made on it, including any made while it had a paid licence; the app shows how much of the allowance is left and tells you before a recovery would exceed it.
• Professional (₹2,499 per year): unlimited recovery on one computer, for personal, non-commercial use.
• Business (₹5,999 per year): unlimited recovery on up to three computers, for use inside one organisation.
• Technician (₹14,999 per year): unlimited recovery on any number of computers, for service providers recovering data on their customers' computers.
• Enterprise (price on request from info@appsgain.in): volume licensing under a separate agreement.
Licences are sold on our website, recoverx.snapkio.com, not through the Microsoft Store, and are activated in the app with a licence key. A computer with no internet connection can be activated offline.

HOW IT WORKS
Tell RecoverX what happened — you deleted files, you formatted a drive, or the drive will not open — and it chooses the right kind of scan.
• Quick scan reads the file system's own records on NTFS, FAT12, FAT16, FAT32 and exFAT volumes. Deleted files come back with their original names, folders and dates. On FAT, a short name such as DSC_0412.JPG loses its first letter, which is shown as _ (_SC_0412.JPG).
• Deep scan reads every sector and recognises files by their content. It works after a format, on a drive Windows shows as RAW, and when the file system is badly damaged. It identifies 21 file types: JPEG, PNG, GIF, BMP, WebP, Photoshop PSD, Canon CR2, MP4, AVI, MKV, MP3, FLAC, WAV, PDF, ZIP (including Word, Excel and PowerPoint documents saved as .docx, .xlsx and .pptx), RAR, 7-Zip, Office 97–2003 documents, RTF, SQLite databases and Outlook PST files. Files found this way have no original name, folder or date, because none of that is stored inside the file itself.
• Every result is rated for how recoverable it is — Excellent, Good, Fair, Poor or Unknown — from evidence on the disk, such as whether its space has been reused.

PREVIEW BEFORE YOU RECOVER
Select a file to see a preview of images and text, and the first bytes of anything else. RecoverX checks whether the recovered bytes really are the kind of file the name says, and tells you when they are not, or when the data has been overwritten with zeros.

FIND WHAT YOU NEED
Browse results by folder, search by name, and filter by category, file extension, size, modification date, recoverability and deleted-only. Long scans can be paused, resumed or stopped, and everything found so far is kept.

SAFE BY DESIGN
• The drive you are recovering from is only ever read. Nothing is written to it — not during a scan, not during a preview, not during recovery.
• Recovered files must be saved to a different drive. RecoverX refuses the source drive as a destination, because writing there would overwrite the very files you are trying to get back.
• Restore the original folder structure, or group files by type. A file that can only be partly read is still saved and marked as partial, so you know to check it.

LOST PARTITIONS
When a partition has been deleted or the partition table is damaged, RecoverX can search the disk for surviving file-system headers and make the volumes it finds available for scanning. It never rewrites the partition table: the found volumes are used inside the app only.

DRIVE HEALTH
See each drive's health from its SMART data and from Windows' storage reliability counters, including temperature, power-on hours and reallocated sectors where the drive reports them. A drive that does not report its health is shown as unknown, never as healthy.

IMPORTANT — PLEASE READ BEFORE YOU START
• No recovery tool can guarantee results. Whether a file can be recovered depends on what has happened to the disk since it was deleted.
• Stop using the drive as soon as you notice the loss. Every file written to it — downloads, updates, even installing software — can overwrite deleted data permanently.
• If the lost files were on your system drive (usually C:), installing anything on it, including this app, can overwrite them. If you can, install RecoverX on a different computer and connect the drive to it.
• Solid-state drives (SSDs) that support TRIM usually erase deleted data within moments of deletion. Recovery of deleted files from such SSDs is often impossible; recovery from hard disks, USB drives and memory cards is far more likely to succeed.
• Data that has been overwritten cannot be recovered by any software.

REQUIREMENTS
Windows 10 version 21H2 or later, or Windows 11, on a 64-bit (x64) PC. Reading drives directly requires Administrator rights, so Windows asks for permission (UAC) each time RecoverX starts. You also need a second drive or a USB stick with enough free space for the recovered files.

PRIVACY
Your files never leave your computer: scanning, preview and recovery all happen locally. Licence activation sends your licence key and a pseudonymous computer identifier (a one-way hash, not your computer's name) to our licence server; with a time-limited licence close to its end date, the app also asks that server about a renewal when it starts. Shortly after it starts, the app also asks our update server whether a new version exists; you can turn that off in Settings, and updates are downloaded only when you choose. Read the full privacy policy at https://recoverx.snapkio.com/privacy/.
```

## What's new in this version (≤ 1,500)

```text
First release on the Microsoft Store.
```

## Product features (up to 20, ≤ 200 each)

```text
Quick scan of NTFS, FAT and exFAT volumes recovers deleted files with their names, folders and dates (on FAT, a short name's first letter shows as _)
Deep scan finds files by their content after a format, on RAW drives and on damaged file systems
Recognises 21 file types by content, including JPEG, PNG, Canon RAW, MP4, MKV, MP3, PDF, ZIP, Office and Outlook PST
Choose what happened — deleted files, formatted drive, drive will not open — and the right scan is chosen for you
Recoverability rating for every file, based on evidence on the disk
Preview images and text, and check that recovered bytes match the file type before you recover
Search, folder view and filters by type, extension, size, date and recoverability
Pause, resume or stop a scan at any time; results found so far are kept
Read-only: the drive you recover from is never written to
Recovered files are always saved to a different drive, never to the source
Restore the original folder structure, or group recovered files by type
Partly readable files are kept and flagged as partial
Find lost partitions from surviving file-system headers, without rewriting the partition table
Drive health from SMART data and Windows reliability counters
Recovery history of every job and its results
Free edition: unlimited scanning and preview, up to 1 GB of recovery
Online or offline licence activation
Light and dark themes; English and Spanish
```

(18 features; the longest is under 150 characters.)

## Search terms (up to 7; no pricing words such as "free")

```text
data recovery
file recovery
undelete
recover deleted files
partition recovery
SD card recovery
photo recovery
```

## Screenshots and captions

Upload in this order. PNG, 1920×1080 (the Store's minimum is 1366×768). Generate the base set with `npm run store:screenshots` from an **elevated** terminal on a clean test machine or VM — the Dashboard shows the computer's name and the Licence screen its computer ID, so do not capture them on a personal machine — then capture the scan-in-progress and results screens by hand during a real scan of a test USB stick. Each caption is ≤ 200 characters.

| #   | Screen                    | Caption                                                                                                                       |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scan — "What happened?"   | Tell RecoverX what happened, and it chooses the right scan: deleted files, a formatted drive, or a drive Windows cannot open. |
| 2   | Scan results with preview | Browse results by folder, preview files, and see how recoverable each one is before you recover.                              |
| 3   | Scan in progress          | Scans can be paused, resumed or stopped at any time, and everything found so far is kept.                                     |
| 4   | Recover dialog            | Recovered files are always saved to a different drive. The drive you recover from is never written to.                        |
| 5   | Devices                   | Every disk, partition and file system, read directly from the device.                                                         |
| 6   | Partitions                | Find partitions that were deleted or lost, and scan them without rewriting the partition table.                               |
| 7   | Health                    | Drive health from SMART data, with temperature, power-on hours and reallocated sectors where reported.                        |
| 8   | Licence                   | Free edition: unlimited scanning and preview, and up to 1 GB of recovery. Paid editions remove the limit.                     |

## Store logos

| Field                       | File (from `npm run icon`)                                         |
| --------------------------- | ------------------------------------------------------------------ |
| 1:1 Box art (required)      | `build/store/box-art-2160.png` (2160×2160) — or `box-art-1080.png` |
| 1:1 App tile icon (300×300) | `build/store/store-logo-300.png`                                   |

## Copyright and trademark info (≤ 200)

```text
© 2026 Appsgain Technologies. All rights reserved. RecoverX is a trademark of Appsgain Technologies.
```

## Applicable license terms

Partner Center requires these for MSI/EXE apps. Paste the full text of the repository's `LICENSE` (the end-user licence agreement), or the address where the website publishes it, https://recoverx.snapkio.com/terms/, once the vendor's legal adviser has approved it (see docs/MICROSOFT-STORE.md, section 2).

## Developed by

```text
Appsgain Technologies
```

## Additional system requirements

Minimum hardware: tick nothing beyond the defaults. Free text, one item per line:

```text
Windows 10 version 21H2 or later, or Windows 11, 64-bit (x64)
An Administrator account: reading drives directly requires elevation (UAC)
About 400 MB of disk space for the app
A second drive or USB stick with enough free space for the recovered files
```

## Support and links (Properties page)

| Field              | Value                                 |
| ------------------ | ------------------------------------- |
| Support contact    | info@appsgain.in                      |
| Website            | https://recoverx.snapkio.com/         |
| Privacy policy URL | https://recoverx.snapkio.com/privacy/ |
