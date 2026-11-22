# RecoverX licence server — PHP edition (Hostinger)

This folder is the RecoverX licence server written in PHP, for ordinary shared hosting such as a Hostinger Premium plan. It does exactly what the Node server in `src/server/` does — the same addresses, the same answers, the same rules — so the desktop application cannot tell them apart and needs no change.

It runs at **https://recoverx.snapkio.com**:

- `https://recoverx.snapkio.com/v1/activate` and `/v1/deactivate` — used by the RecoverX application.
- `https://recoverx.snapkio.com/admin/` — your admin panel: create, find, renew, revoke and move licences.
- `https://recoverx.snapkio.com/setup/` — used once, to set the server up.
- `https://recoverx.snapkio.com/healthz` — answers `{"ok":true}` when everything is working.

Everything else on the site (your website, the `/buy` page) is untouched.

---

## What you need

- Your Hostinger plan with **PHP 8.1 or newer** (choose **8.3**).
- These PHP extensions switched on: **sodium** and **pdo_sqlite** (needed), **mbstring** (recommended).
- The free **SSL certificate** switched on, so the site opens with `https://`.
- The package: `recoverx-licensing-php-<version>.zip`. A developer makes it with `npm run licensing:php:package`; it appears in `release/license-server-php/`.

To set PHP up in hPanel: **Websites → (your site) → Advanced → PHP Configuration**. On the **PHP version** tab choose **8.3**; on the **PHP extensions** tab tick **sodium**, **pdo_sqlite** and **mbstring**, then **Save**. SSL is under **Security → SSL**.

---

## Where the files go

The zip holds two folders, laid out exactly as they belong on the server:

```
domains/recoverx.snapkio.com/
├── public_html/                 ← your website (already there)
│   ├── .htaccess                ← from the zip (see step 3 if you already have one)
│   ├── v1/index.php             ← from the zip: the licence API
│   ├── admin/index.php          ← from the zip: the admin panel
│   └── setup/index.php          ← from the zip: the one-time setup page
└── recoverx-licensing/          ← from the zip, NEXT TO public_html — never inside it
    ├── app/                     ← the program
    ├── README.md                ← this guide
    └── data/                    ← created by setup: signing key, database, settings, logs
```

`recoverx-licensing` must sit **beside** `public_html`, not inside it. Anything inside `public_html` can be downloaded by anyone on the internet; the signing key and the customer database must never be.

---

## Installing (first time)

1. **Back up an existing `.htaccess`.** Open hPanel → **Files → File Manager** and go into `public_html`. If there is a file called `.htaccess` (switch on "Show hidden files" in the File Manager settings if you cannot see dot-files), right-click it and **Download** a copy.
2. **Upload and extract the zip.** Go up one level, into `domains/recoverx.snapkio.com/` — the folder that _contains_ `public_html`. Click **Upload**, choose the zip, then right-click the uploaded zip → **Extract** → extract into the current folder. This creates `recoverx-licensing/` and adds `v1/`, `admin/`, `setup/` and `.htaccess` into `public_html/`. Delete the zip afterwards.
3. **Merge your old `.htaccess`** (only if you downloaded one in step 1). Open `public_html/.htaccess` (right-click → Edit). Keep everything from `# BEGIN RecoverX licensing` to `# END RecoverX licensing` at the top, paste your old rules **below** the `# END` line, and save.
4. **Check the folders.** You should now see `domains/recoverx.snapkio.com/recoverx-licensing/app/bootstrap.php` and `domains/recoverx.snapkio.com/public_html/v1/index.php`.

> If your site's folder is not `domains/recoverx.snapkio.com/public_html` — for example a subdomain whose folder hPanel made inside another site's `public_html` — the program and its data end up inside that other site's web folder. Setup checks for this and refuses to continue (✖ "The data folder is inside `public_html`"), showing a `data_dir` line to put in `recoverx-licensing/config.local.php` that keeps the data outside (see [Settings](#settings)). Better still, give the site its own folder next to `public_html`.

---

## First-run setup — `/setup/`

1. Open **https://recoverx.snapkio.com/setup/**. The page checks the server and lists what is fine (✔), what is recommended (!) and what must be fixed (✖), each with the exact fix. Fix any ✖ and reload.
2. **Setup code.** Setup asks for a one-time code, so that nobody else who finds the page before you can take over the server. In the File Manager open `recoverx-licensing/data/setup-code.txt`, copy the code (like `K7Q2M-…`) and paste it into the page.
3. **Signing key.** Choose **Generate a new key on this server** for a first installation. Choose **Import** only if RecoverX builds have _already shipped_ with a public key from `npm run licensing:keys`; then paste that `license-signing-key.pem` file's contents.
4. **Admin password.** At least 12 characters — four or five unrelated words work well. It is stored only as a one-way hash.
5. Click **Finish setup**. The next page shows:
   - **Download the signing key backup** — do this now (see [Backups](#backups)). It is the only thing that can never be recreated.
   - **`RECOVERX_LICENSE_PUBLIC_KEY=…`** and **`RECOVERX_ACTIVATION_URL=https://recoverx.snapkio.com/v1/activate`** — give these two lines to whoever builds the RecoverX installer (they go into the build environment; see `docs/BUILDING.md`). They are not secret.
6. Open **https://recoverx.snapkio.com/healthz**. It should say `{"ok":true}`.

Setup then locks itself: `/setup/` only says "Already set up". To run it again — for example after forgetting the admin password, or when failed sign-ins have locked the sign-in page — delete `recoverx-licensing/data/setup.lock` in the File Manager and open `/setup/` again. The signing key and all licences are kept; the password (and anything else you enter) is replaced, and the record of failed sign-ins is cleared.

---

## The admin panel — `/admin/`

Sign in at **https://recoverx.snapkio.com/admin/** with your admin password. You are signed out after 30 minutes without activity. Five wrong passwords from one address lock that address out for 15 minutes. Once 100 have failed from everywhere within 15 minutes, any address that has itself given a wrong password waits too — but an address with no failures of its own can still sign in, so guesses from many addresses cannot lock you out. The panel asks for the password again before downloading the signing key and before changing the password; wrong answers there count the same way, and the fifth signs the session out.

| Page             | What it is for                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**    | Licences by edition and status, computers activated now, the latest activity, and how the server is configured.                                                                                                                                            |
| **Orders**       | Requests from the website's order form: search, filter by status, follow up, create their licences, delete. See [The order form](#the-order-form).                                                                                                         |
| **Licences**     | Search by part of a key, a name, an e-mail address or an order reference; filter by edition and status. Click a key for its details.                                                                                                                       |
| **Licence page** | Everything about one licence: its computers, its history, and the actions — revoke / restore, change the end date (renewal), release one computer, reset all computers, issue an offline activation, and correct or erase the customer's personal details. |
| **Create**       | Make new licence keys. Shows each key once, with a Copy button.                                                                                                                                                                                            |
| **API token**    | Switch on the JSON admin API for a payment webhook (optional).                                                                                                                                                                                             |
| **Backup**       | Download a database snapshot and the signing key; see how much activation history is past its retention, and delete it now (see [Activation history and privacy](#activation-history-and-privacy)).                                                        |
| **Password**     | Change the admin password (signs out every other session).                                                                                                                                                                                                 |

### Editions and prices

| Edition      | Computers                         | Price                              |
| ------------ | --------------------------------- | ---------------------------------- |
| Free         | 1                                 | ₹0 — recovers up to 1 GiB in total |
| Professional | 1                                 | ₹2,499 per year                    |
| Business     | 3                                 | ₹5,999 per year                    |
| Technician   | unlimited (use on customers' PCs) | ₹14,999 per year                   |
| Enterprise   | unlimited                         | contact sales (info@appsgain.in)   |

The Free edition needs no key. Paid licences are annual: the Create page defaults to 365 days.

### Everyday tasks

- **A customer paid.** Payment is taken outside the app (Razorpay or UPI payment link). In **Create**, pick the edition, enter the customer's name and e-mail, keep "365 days", and put the payment id in **Order reference**. Copy the key and e-mail it. If you click Create twice for the same order reference, you get the same key back, not a second one.
- **A customer renews.** Open the licence, **Change the end date → extend by 365 days**. Days are added to the current end date (or to today if it has already passed). The customer's app picks up the new date by itself the next time it checks (or when they click "Check for renewal").
- **A refund or chargeback.** Open the licence and **Revoke** it with a reason. It can no longer be activated or renewed. Computers that already have it keep working until its end date, because the app checks its licence offline. **Restore** undoes a revocation.
- **A customer replaced their computer and the old one is gone.** Open the licence and click **Release** next to the old computer (or **Reset all seats**). This is never counted against the customer's own moves.
- **A computer with no internet.** Ask the customer for the **Computer ID** shown on the app's Licence page, enter it under **Offline activation**, and send them the activation code (or the saved file). In the app they choose the **Offline** activation method and paste it.

### Moving a licence between computers

Customers can move a licence themselves: **Remove from this computer** on the app's Licence page frees the computer's seat, and they activate on the new one. To stop one licence being spread over many computers by restoring backups, a licence can be moved by the customer **4 times in 12 months**. After that the app says the licence is still active on that computer and to contact info@appsgain.in; you then use **Release** in the admin panel, which is not counted. **Technician and Enterprise licences** (anything with unlimited computers) are never limited — their moves are still counted and shown. The limit can be changed with `self_release_limit` (see [Settings](#settings)).

---

## The admin API (optional)

For automation — for example a Razorpay webhook that creates the licence and e-mails it — open **API token** in the admin panel and click **Generate a token**. Copy it immediately: it is shown once and stored only as a hash. Until a token exists, the API's addresses answer 404 as if they did not exist.

The API is identical to the Node server's (`docs/LICENSE-SERVER.md`, "HTTP API"). For example:

```bash
curl -sS https://recoverx.snapkio.com/v1/admin/licenses \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"edition":"professional","days":365,"registeredTo":"Jane Doe","email":"jane@example.com","orderRef":"razorpay:pay_123"}'
```

With `orderRef` set, a webhook delivered twice gets the same key back (`200`, `"created": false`) instead of a second licence. Replace the token any time from the same page; the old one stops working at once.

---

## Backups

Two things, with very different schedules:

- **The signing key — once, offline, in two places.** Download it at the end of setup, or later from **Backup → Download signing key** (asks for your password). Keep one copy in a password manager and one on a USB stick in a drawer. Never e-mail it or put it in a shared folder: anyone holding it can make licences. If it is lost, no new activation can be issued that existing copies of RecoverX accept.
- **The database — regularly.** It is the record of every licence sold and every computer activated. Use **Backup → Download database snapshot** at least weekly (daily when you sell a lot) and keep the last few. The snapshot is consistent even while customers are activating.

Hostinger's own backups (hPanel → **Files → Backups**) also copy `recoverx-licensing/`, which is a useful extra layer — but a copy of a database taken while it is being written can miss the latest changes, so keep downloading snapshots too.

### Restoring

1. In the File Manager, open `recoverx-licensing/data/`.
2. Delete `licences.db-wal` and `licences.db-shm` if they exist.
3. Upload the snapshot and rename it to `licences.db` (replacing the old one).
4. If the signing key was lost too, upload the key backup as `signing.key` in the same folder.

To rebuild on a fresh server: upload the package, put your `signing.key` backup into `recoverx-licensing/data/` (create the folder), run `/setup/` (it keeps a key it finds there), then restore the database as above.

---

## Activation history and privacy

Every activation, move and refusal is recorded with the internet address it came from: it is the history on each licence's page, and the self-service move limit is counted from it. The privacy policy promises that this history is kept for **13 months** and then deleted, so the server deletes anything older than **395 days** (`event_retention_days`) by itself:

- **Once a day, with no cron job to set up.** Shared hosting gives the server nothing that runs on a timer, so the first request after a day has passed — a customer activating, a health check, you opening the admin panel — does the clean-up after it has been answered. A site nobody visits for a week catches up on the next visit.
- **The monthly log files too.** `data/logs/licensing-<year>-<month>.log` records each request's address, so a log file is deleted as well once its whole month is older than the retention.
- **The other records named after addresses.** The rate limiter keeps a counter per address; the same clean-up deletes every counter that has refilled (with the default limits, within a minute of the last request), and any older than the retention whatever the limits. The order form's counters (per address, per hashed customer e-mail for confirmations, and the two overall ones) go once they have refilled by their own, slower limits: about an hour per address, a day per customer e-mail. Failed admin sign-ins are deleted after a day.
- **Orders from the website form.** Each is deleted 24 months after it last changed (its status or notes), whatever `event_retention_days` says. The licences made for it stay. An order does not keep the address it was sent from: that is only in the monthly request log.
- **Now, by hand.** **Backup → Activation history** shows how many entries are past the retention and when the last clean-up ran; **Delete old history now** does it at once.

Deleted means gone from the file, not only hidden: the database overwrites what it deletes, and each clean-up empties its write-ahead log (`licences.db-wal`), so an address does not linger in free space. Each clean-up writes a `"Pruned the event log"` line to the log, with how many entries, counters, failed sign-ins and orders went. Licences, and the list of computers each was activated on, are never deleted — only the history. Restoring an older database snapshot brings back history that had already been deleted; the next day's clean-up removes it again. Snapshots you have downloaded keep what they held: delete old ones once they are past the retention too.

### Requests about personal data

The privacy policy promises customers a copy of their data, its correction and its deletion, answered within 30 days. On the licence's page (search for the e-mail address or the key under **Licences**):

- **A copy.** The page shows everything held about the licence: the name, e-mail and notes, its computers and its history with addresses.
- **Correction.** Edit **Personal details** and **Save details**. The customer's computers show the corrected name from their next activation.
- **Website orders.** Search **Orders** for the e-mail address or mobile number too: the order page shows everything the form sent (a copy), and **Delete this order** removes it.
- **Deletion.** **Erase personal details** clears the name, e-mail and notes and the addresses in the licence's history, and deletes the website order with the licence's order reference. The key, its dates and computers stay, so the licence keeps working; so does the order reference, which ties the sale to your accounts, until 8 years after the licence has ended (the period the policy gives for purchase records). Erasing a licence that ended longer ago clears the order reference too, and nothing personal is left. Each correction or erasure writes a line to the log.

Erasure cannot reach copies elsewhere: the request logs (deleted after 13 months), database snapshots you downloaded, and the e-mails you exchanged with the customer.

The retention may be longer (the privacy policy must then say so) but never shorter than `self_release_window_days`: moves are counted from this history, and deleting it early would quietly give customers their moves back. With such a setting the server stops with a message in the log instead of running.

---

## Upgrading to a new version

1. Take a database snapshot (**Backup**) first.
2. In the File Manager, delete the folder `recoverx-licensing/app/` — only `app/`. **Never delete or replace `recoverx-licensing/data/`**: it holds the signing key, the database, the settings and the logs.
3. Upload the new zip into `domains/recoverx.snapkio.com/` and extract it there, as when installing. It brings the new `app/` and replaces `public_html/v1/index.php`, `admin/index.php`, `setup/index.php` and `.htaccess`. If you merged your own rules into `.htaccess`, merge them again (step 3 of installing).
4. Open `/healthz` (expect `{"ok":true}`) and sign in to `/admin/`. Any database changes a new version needs are applied automatically on its first request.

---

## Settings

The server works with its defaults. To change them, create `recoverx-licensing/config.local.php` (next to `app/`, outside the web folder) in the File Manager:

```php
<?php

return [
    'self_release_limit' => 4,
];
```

| Setting                    | Default      | Meaning                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self_release_limit`       | `4`          | Moves a customer may make themselves per licence in the window. `0` sends every move through you.                                                                                                                                                                                                                                                                                                     |
| `self_release_window_days` | `365`        | The window for that limit, in days (1–3650), and no longer than `event_retention_days`.                                                                                                                                                                                                                                                                                                               |
| `event_retention_days`     | `395`        | Days the activation history (with customers' addresses) and the request logs are kept before they are deleted — 13 months, as the privacy policy promises. At least `self_release_window_days`. See [Activation history and privacy](#activation-history-and-privacy).                                                                                                                                |
| `rate_limit_burst`         | `20`         | Activation requests one address may make at once.                                                                                                                                                                                                                                                                                                                                                     |
| `rate_limit_per_minute`    | `30`         | Requests per minute per address after that.                                                                                                                                                                                                                                                                                                                                                           |
| `trust_proxy`              | `false`      | Take the customer's address from the end of the `X-Forwarded-For` header, where a CDN in front adds it. Only switch on if that CDN makes every customer appear with its address — the Dashboard shows what the server sees. `true` reads the last entry; a number N reads the Nth from the end, for N proxies one behind the other. Entries before it are whatever the visitor sent, and are ignored. |
| `admin_idle_minutes`       | `30`         | Minutes without activity before the admin panel signs you out (5–1440).                                                                                                                                                                                                                                                                                                                               |
| `allow_insecure_admin`     | `false`      | Let the admin panel and setup run without HTTPS. Only for a host where HTTPS is on but not detected.                                                                                                                                                                                                                                                                                                  |
| `data_dir`                 | —            | Keep the data folder somewhere else (a full path).                                                                                                                                                                                                                                                                                                                                                    |
| `mail_from`                | `''`         | The address licence e-mails come from, e.g. `'licences@snapkio.com'`. Empty keeps e-mail off. See [E-mailing licence keys](#e-mailing-licence-keys).                                                                                                                                                                                                                                                  |
| `mail_from_name`           | `'RecoverX'` | The name shown next to it (letters, digits, spaces, dots, hyphens).                                                                                                                                                                                                                                                                                                                                   |
| `mail_reply_to`            | `''`         | Where customers' replies go, e.g. `'info@appsgain.in'`. Empty: replies go to `mail_from`.                                                                                                                                                                                                                                                                                                             |
| `ses_region`               | `''`         | The Amazon SES region the sending domain is verified in, e.g. `'ap-south-1'`. Required with `mail_from`.                                                                                                                                                                                                                                                                                              |
| `order_notify_to`          | `[]`         | Who receives the website order form (`/order/`), e.g. `['sales@example.com']`; up to 5 addresses. Empty: `mail_reply_to`. Needs `mail_from`. See [The order form](#the-order-form).                                                                                                                                                                                                                   |

A mistake in this file stops the server with a message in the log, rather than running half-configured.

### E-mailing licence keys

On the AWS server (see `deploy/aws-ec2/README.md`) the admin panel can e-mail a licence key to its customer: **E-mail the key** on a licence's page, or the tick box under E-mail when creating licences. The message holds the key, what it covers and the three activation steps, in plain text; replies go to `mail_reply_to`. Each send is recorded in the licence's history as `key-emailed` (with the SES message id, not the address).

It sends through Amazon SES with the EC2 server's IAM role, so no AWS key is stored anywhere. It needs, once:

1. The domain of `mail_from` verified in SES in `ses_region` (DKIM, and ideally a custom MAIL FROM domain and DMARC).
2. An IAM role on the EC2 instance that may call `ses:SendEmail` with `ses:FromAddress` equal to `mail_from`.
3. SES production access. Until AWS grants it, SES only delivers to addresses verified in SES, and the panel says so when it refuses.

```php
<?php

return [
    'mail_from' => 'licences@snapkio.com',
    'mail_reply_to' => 'info@appsgain.in',
    'ses_region' => 'ap-south-1',
];
```

On a host that is not EC2 (Hostinger) leave `mail_from` empty: there is no role to send with.

### The order form

The website's /buy/ page posts its order form to `/order/` (`public/order/index.php`). It asks for the edition, the number of licences, the customer's **name, e-mail address and mobile number** (all three required; the mobile number has a country selector, India +91 by default), and optionally who the licence is registered to, a GSTIN and a message.

What happens to a request:

1. **It is stored** in the database, in the private `orders` table (the Node reference server ignores it), under a reference such as `RX-1A2B3C4D`. The mobile number is stored with its country code, e.g. `+91 9876543210`.
2. **It is e-mailed** through SES to `order_notify_to`, with Reply-To set to the customer. The e-mail carries the reference, the mobile number and a link to the order in the admin panel.
3. **The customer gets a short confirmation** with the edition, the number of licences and the reference — nothing they typed, so the form cannot be used to send a stranger a message. At most one a day per address.
4. **The visitor lands on** the static `/buy/sent/` page when the order was stored _or_ e-mailed (the vendor has it either way), and on `/buy/error/` only when both failed. With e-mail off (`mail_from` empty) orders are still stored, and still count as sent.

**Admin panel → Orders** lists them newest first, with the number of new ones beside the link and on the Dashboard. Search by name, e-mail, mobile number, reference, "register to" or GSTIN, and filter by status. An order's page shows everything the customer sent (the e-mail and mobile number are links), and has:

- **Status and notes** for your follow-up — **New** → **Contacted** → **Paid** → **Licence sent**, or **Cancelled**. The customer never sees either.
- **Create licence for this order** — opens Create filled in from the order (edition, name, e-mail, number of keys, and the reference as the order reference). Creating the licences marks the order **Licence sent**, and they are listed on the order's page.
- **Delete this order** — for spam, or a customer who asks to be deleted; tick the box to confirm. Licences already created are kept.

Orders are deleted automatically **24 months after they last changed**, by the same daily clean-up as the activation history (see [Activation history and privacy](#activation-history-and-privacy)).

Abuse limits: a hidden field people leave empty (robots that fill it are told it worked and nothing is stored or sent), a post from another site's page is refused by its Origin header, and token buckets allow 5 requests per address (then 5 an hour) and 100 overall (then 200 a day). Put the recipients in `config.local.php` on the server, never in the repository:

```php
'order_notify_to' => ['info@appsgain.in', 'owner@example.com'],
```

---

## Troubleshooting

**Setup says "sodium" (or "pdo_sqlite") is missing.** hPanel → **Websites → Advanced → PHP Configuration → PHP extensions**, tick **sodium** (or **pdo_sqlite**), **Save**, then reload `/setup/`. If the extension is not in the list, choose PHP 8.3 on the **PHP version** tab first.

**"Something went wrong" or an error 500.** The server writes what happened to `recoverx-licensing/data/logs/licensing-<year>-<month>.log` — one line per request, newest at the bottom; download it and look at the last `"level":"error"` lines. If that folder does not exist yet, or is empty, PHP itself could not start the program: look for a file called `error_log` in `public_html/v1/` or `public_html/admin/` (or in the `logs` folder next to `public_html`), and check that `recoverx-licensing/app/bootstrap.php` exists next to `public_html`.

**`/healthz` or `/v1/activate` shows your website's "page not found" instead of a short JSON answer.** The `.htaccess` rules are missing: check that `public_html/.htaccess` contains the `# BEGIN RecoverX licensing` block at the top.

**The admin API always answers 401 even with the right token.** Some servers drop the `Authorization` header before PHP sees it. Check that the `.htaccess` block still contains the line with `E=HTTP_AUTHORIZATION`.

**"HTTPS required" although the address starts with https.** Make sure SSL is switched on in hPanel and "Force HTTPS" is set. If it still happens, add `'allow_insecure_admin' => true` to `config.local.php`.

**Customers are told "Too many activation attempts".** Open the Dashboard and look at "Your address, as the server uses it". If it is not your own public address, a CDN sits in front of the site and every customer looks the same to the server. If `X-Forwarded-For` _ends_ with your address, set `'trust_proxy' => true` in `config.local.php`; if your address is the second entry from the end, set `'trust_proxy' => 2`. Reload the Dashboard and check that the address it uses is now yours. Never set it when `X-Forwarded-For` merely _starts_ with your address: that part is written by the visitor, and trusting it would let anyone pick a new address for every request.

**Forgotten the admin password, or "Too many failed sign-ins" that does not go away.** Delete `recoverx-licensing/data/setup.lock` and run `/setup/` again. Licences and the signing key are kept, and the failed sign-ins are forgotten.

**Logs grow.** A new log file starts every month, and a file is deleted by itself once its month is older than the retention (13 months). You may delete older ones from `recoverx-licensing/data/logs/` sooner whenever you like.

---

## For developers

- `npm run licensing:php:test` — finds PHP (`RECOVERX_PHP_BIN`, then `php` on the PATH, then `C:/xampp/php/php.exe`; loads sodium with `-d extension=sodium` if needed), runs `php -l` on every file and then the unit tests in `tests/run.php`. A name filter can follow: `npm run licensing:php:test -- Authority`.
- `npx vitest run tests/unit/server/php-contract.test.ts` — the contract-parity suite: provisions throwaway installations, serves them with `php -S` and `tests/support/router.php` (which stands in for `.htaccess`), and runs the reference server's HTTP scenarios against them, verifying every token with the desktop client's own `verifyToken`. Skipped when no suitable PHP is found.
- `npm run licensing:php:package` — writes the upload zip to `release/license-server-php/`.
- Try it locally:

  ```bash
  mkdir -p /tmp/rx/recoverx-licensing && cp -r server-php/app /tmp/rx/recoverx-licensing/ && cp -r server-php/public /tmp/rx/public_html
  php -d extension=sodium /tmp/rx/recoverx-licensing/app/bin/provision.php --password='local admin password' --api-token="$(openssl rand -hex 24)"
  php -d extension=sodium -S 127.0.0.1:8080 -t /tmp/rx/public_html server-php/tests/support/router.php
  ```

  `app/bin/provision.php` does what `/setup/` does, from the command line. It is for tests and development only and is not included in the package.

The code is plain PHP 8.1+ with `declare(strict_types=1)`, no Composer and no third-party code (production runs PHP 8.3; tests also run on 8.5). Each class mirrors a file of the Node reference:

| PHP (`app/src/`)                      | Reference (`src/`)                          |
| ------------------------------------- | ------------------------------------------- |
| `LicenseKey.php`                      | `shared/utils/license-key.ts`               |
| `Messages.php`                        | `server/messages.ts`                        |
| `Authority.php`, `LicenseError.php`   | `server/authority.ts`, `server/errors.ts`   |
| `Store.php`                           | `server/store.ts` (same schema and version) |
| `TokenSigner.php`, `SigningKey.php`   | `server/signing.ts`                         |
| `Expiry.php`                          | `server/expiry.ts`                          |
| `RateLimiter.php`                     | `server/rate-limit.ts` (kept in SQLite)     |
| `EventRetention.php`                  | `server/retention.ts` (run from requests)   |
| `Http/Api.php`                        | `server/http.ts`                            |
| `Config.php`, `Paths.php`             | `server/config.ts`                          |
| `Admin/Panel.php`, `Setup/*`, `Web/*` | — (the admin CLI's job, as web pages)       |

Customer-facing sentences are the reference's word for word, naming `https://recoverx.snapkio.com` and `info@appsgain.in` as the website and support address. The database file is the reference's schema, so moving to the Node server later is a copy of `data/licences.db` and `data/signing.key` (set `LICENSE_DB_FILE` and `LICENSE_SIGNING_KEY_FILE`, and `LICENSE_EVENT_RETENTION_DAYS` if you changed `event_retention_days`). The extra tables this server keeps for itself (`rate_limits`, `login_attempts`, `housekeeping`) sit outside the schema version and are ignored there.
