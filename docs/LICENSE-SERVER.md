# Licence server

The RecoverX licence server is the vendor-side half of licensing. It holds
the record of every licence sold, hands out signed activation tokens to the
desktop application, enforces how many computers a licence may be active on
(and how often a customer may move it between computers on their own), and
gives the operator a CLI and an HTTP API for the day-to-day work of selling,
renewing, refunding and moving licences.

It is a small Node service with one dependency (bundled in), one SQLite file
for state, and one secret: the Ed25519 signing key.

- Source: `src/server/` · Tests: `tests/unit/server/` · Container: `deploy/license-server/`
- Build: `npm run licensing:build` → `dist/license-server/server.mjs` and `dist/license-server/admin.mjs`

> **Production runs the PHP port.** RecoverX's live licence server is the
> PHP implementation in [`server-php/`](../server-php/README.md), on the
> website's own host: `https://recoverx.snapkio.com/v1/activate`. It speaks
> exactly the HTTP contract described here, and its admin panel at `/admin/`
> does the work of the admin CLI. This Node service remains the reference
> implementation — the behaviour the PHP port mirrors, and the one its contract
> tests compare it with — and the route for a VPS or container deployment.

---

## How it fits with the desktop application

```
 Customer's PC                                    Your server
 ─────────────                                    ───────────
 RecoverX ── POST /v1/activate ───────────────▶ licence server ──▶ SQLite
   { key, machineId, product }                    (behind HTTPS)
                ◀── { token } ───────────────────  signs with the private key
 verifies token locally with the
 public key compiled into the build
```

- A **licence key** (`RECX-XXXXX-XXXXX-XXXXX-XXXXX`) is what you sell. It is an
  identifier, not a credential; the checksum in its last character only catches
  typing mistakes.
- An **activation token** is what the server returns. It names the edition, the
  key, the machine, the expiry and the registered owner, and is signed with the
  private key. The application verifies it **offline** against the public key
  it was built with, on every licence check — so once activated, a machine
  needs no further contact with this server.
- A token is bound to one machine. Copying it to another computer does not
  work; the other computer has to activate, and that takes a seat.

The desktop side is configured at build time with two variables, described in
[BUILDING.md › Licensing keys](BUILDING.md#licensing-keys):

| Build variable                | Value                                              |
| ----------------------------- | -------------------------------------------------- |
| `RECOVERX_LICENSE_PUBLIC_KEY` | The public key printed by `npm run licensing:keys` |
| `RECOVERX_ACTIVATION_URL`     | `https://<your licence host>/v1/activate`          |

The application derives the deactivation address from the activation URL
(`…/v1/deactivate`), so only one URL is configured.

---

## First-time setup

Do this **once**, before the first release that sells licences.

### 1. Generate the signing key pair

```bash
npm run licensing:keys
```

This writes `license-signing-key.pem` (the private key, PKCS#8 PEM) to the
current directory and prints the public key. The file name is in `.gitignore`,
but treat that as a safety net, not a plan.

### 2. Back the private key up, offline, now

**Losing the private key is worse than leaking it.** Every licence you have ever
sold was signed with it, and the public half is compiled into every copy of the
application you have shipped. A new key pair means a new application release,
and every existing customer's activation stops being recognised by it.

- Keep at least two copies somewhere that is not the licence server: an
  encrypted USB stick in a safe, and a password manager's secure-file storage,
  for example.
- Never put it in the repository, a CI secret that build jobs can read, a
  ticket, or chat.
- After copying it to the server (step 4), delete the copy in your working
  directory.

### 3. Configure the application builds

Put the printed public key, and the activation URL, in the build environment
(`.env` for local builds, the CI secret store for release builds):

```
RECOVERX_LICENSE_PUBLIC_KEY=MCowBQYDK2VwAyEA…
RECOVERX_ACTIVATION_URL=https://licensing.example.com/v1/activate
```

### 4. Configure the server

Give the server the private key and, as a guard rail, the same public key:

```
LICENSE_SIGNING_KEY_FILE=/etc/recoverx/license-signing-key.pem
RECOVERX_LICENSE_PUBLIC_KEY=MCowBQYDK2VwAyEA…
```

With `RECOVERX_LICENSE_PUBLIC_KEY` set, the server **refuses to start** if its
signing key does not match. Without that check, a server deployed with the
wrong key would "successfully" activate every customer with a token their copy
of the application then rejects as not genuine.

If you want the admin HTTP API (for a payment webhook), generate a token:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

and set it as `LICENSE_ADMIN_TOKEN`. Leave it unset and the admin API does not
exist; the CLI still works.

---

## Running it locally

```bash
npm run licensing:build

# Throwaway key pair, outside the repository:
mkdir -p ../licensing-dev && cd ../licensing-dev
node ../RecoverX/scripts/generate-license-keys.mjs
cd ../RecoverX

LICENSE_SIGNING_KEY_FILE=../licensing-dev/license-signing-key.pem \
LICENSE_DB_FILE=../licensing-dev/licences.db \
npm run licensing:server
```

The server logs one JSON line per event to stdout, starting with the public key
and its fingerprint:

```json
{"time":"…","level":"info","msg":"Licence server listening","url":"http://127.0.0.1:8787","publicKeyFingerprint":"SHA256:…",…}
```

Mint a key and activate it by hand:

```bash
export LICENSE_DB_FILE=../licensing-dev/licences.db
npm run licensing:admin -- create --edition professional --to "Test Customer"

curl -s http://127.0.0.1:8787/v1/activate \
  -H 'content-type: application/json' \
  -d '{"key":"RECX-…","machineId":"ABCD-EFGH-JKMN-PQRS-TVWX-YZ12","product":"recoverx"}'
```

To point a development build of the application at it, set
`RECOVERX_ACTIVATION_URL=http://127.0.0.1:8787/v1/activate` and the matching
`RECOVERX_LICENSE_PUBLIC_KEY` in `.env`.

---

## Deploying

The server speaks plain HTTP on `127.0.0.1:8787` by default and expects a
reverse proxy in front of it to terminate HTTPS. It must never be exposed
without TLS: activation requests carry licence keys.

### With Docker

```bash
docker build -f deploy/license-server/Dockerfile -t recoverx-license-server .

docker run -d --name recoverx-licensing --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v recoverx-licensing-data:/data \
  -v /etc/recoverx/license-signing-key.pem:/run/secrets/license_signing_key:ro \
  -e LICENSE_SIGNING_KEY_FILE=/run/secrets/license_signing_key \
  -e RECOVERX_LICENSE_PUBLIC_KEY=MCowBQYDK2VwAyEA… \
  -e LICENSE_ADMIN_TOKEN=… \
  -e LICENSE_TRUST_PROXY=true \
  recoverx-license-server
```

- The image runs as the unprivileged `node` user (uid 1000): the key file must
  be readable by that uid (`chown 1000 license-signing-key.pem; chmod 400 …`).
- The database lives on the `/data` volume. Back that volume up (see
  [Backups](#backups)).
- `HEALTHCHECK` polls `/healthz`, which also checks the database is readable.
- `deploy/license-server/compose.yaml` is the same deployment as a Compose file,
  with the key supplied as a Compose secret and the other variables read from
  `deploy/license-server/.env.licensing.local`. Keep that file name: the
  repository's `.gitignore` covers `.env.*.local`, not `.env.*`, and the file
  holds the admin token.
- The admin CLI is inside the image:
  `docker exec recoverx-licensing node admin.mjs list`.

### Without Docker

Copy `dist/license-server/` (both `.mjs` files and the `chunks/` folder) to the
host, install Node 22.13 or later (Node 24 recommended), and run it under
systemd:

```ini
# /etc/systemd/system/recoverx-licensing.service
[Unit]
Description=RecoverX licence server
After=network.target

[Service]
User=recoverx-licensing
WorkingDirectory=/opt/recoverx-licensing
EnvironmentFile=/etc/recoverx/licensing.env
ExecStart=/usr/bin/node --enable-source-maps /opt/recoverx-licensing/server.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/recoverx-licensing

[Install]
WantedBy=multi-user.target
```

with `LICENSE_DB_FILE=/var/lib/recoverx-licensing/licences.db` in the
environment file.

### Reverse proxy: Caddy

Caddy obtains and renews the certificate itself.

```caddyfile
licensing.example.com {
	request_body {
		max_size 16KB
	}

	reverse_proxy 127.0.0.1:8787 {
		# Overwrite, never append: the server trusts the first hop.
		header_up X-Forwarded-For {remote_host}
	}
}
```

### Reverse proxy: nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name licensing.example.com;

    ssl_certificate     /etc/letsencrypt/live/licensing.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/licensing.example.com/privkey.pem;

    client_max_body_size 16k;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        # $remote_addr, not $proxy_add_x_forwarded_for: a client must not be
        # able to choose the address it is rate limited under.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # Optional: only your own network may reach the admin API at all.
    location /v1/admin/ {
        allow 203.0.113.0/24;
        deny all;
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Set `LICENSE_TRUST_PROXY=true` only when such a proxy is in front. On a server
reachable directly, trusting `X-Forwarded-For` would let any client pick its own
address and walk past the rate limit.

---

## Environment

| Variable                           | Default                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE_SIGNING_KEY_FILE`         | —                      | Path to the PKCS#8 PEM private key written by `npm run licensing:keys`. Required by the server (or the next variable), and by the CLI's `offline` and `public-key`.                                                                                                                                                                                                                                                                                                                                                                            |
| `LICENSE_SIGNING_KEY`              | —                      | The PEM text itself, for platforms that inject secrets as variables. `\n` escapes are accepted. Set this or the file, not both.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RECOVERX_LICENSE_PUBLIC_KEY`      | —                      | The public key desktop builds embed. When set, the server refuses to start with a signing key that does not match it. Strongly recommended.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LICENSE_DB_FILE`                  | — (required)           | SQLite database. The directory is created if missing. Required by the server and by every CLI command except `public-key`. There is deliberately no default: keep the file outside any source checkout, since it holds customer names, e-mail addresses and licence keys.                                                                                                                                                                                                                                                                      |
| `HOST`                             | `127.0.0.1`            | Listen address. `0.0.0.0` inside a container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PORT`                             | `8787`                 | Listen port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LICENSE_ADMIN_TOKEN`              | — (admin API disabled) | Bearer token for `/v1/admin/…`. At least 32 characters, printable ASCII, no spaces (it travels in an HTTP header). Unset or empty: those routes answer 404.                                                                                                                                                                                                                                                                                                                                                                                    |
| `LICENSE_TRUST_PROXY`              | `false`                | Take the client address from the first `X-Forwarded-For` hop. Only behind a proxy that overwrites that header.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LICENSE_RATE_LIMIT_BURST`         | `20`                   | Activation/deactivation requests one client address may make back to back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LICENSE_RATE_LIMIT_PER_MINUTE`    | `30`                   | Sustained rate per client address once the burst is spent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LICENSE_SELF_RELEASE_LIMIT`       | `4`                    | Self-service moves (successful `POST /v1/deactivate` releases) one licence key may make within the window; the next is refused with `409` and the seat stays held. Whole number, `0` or more; `0` turns self-service moves off, so every move goes through support. Licences with unlimited seats are counted but never limited. Keep it very high until the desktop build that reads `409` has rolled out. See [The self-service move allowance](#the-self-service-move-allowance) and [Turning it on](#turning-it-on-the-application-first). |
| `LICENSE_SELF_RELEASE_WINDOW_DAYS` | `365`                  | Length of that rolling window, in days (1–3650). Lengthening it past 395 days needs a longer `LICENSE_EVENT_RETENTION_DAYS` too.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LICENSE_EVENT_RETENTION_DAYS`     | `395`                  | Days the activation history (the `events` table, with each request's IP address) is kept before it is deleted: 13 months, as the published privacy policy promises. At least `LICENSE_SELF_RELEASE_WINDOW_DAYS`, at most 36500. Do not raise it without changing the privacy policy first. See [Event-log retention](#event-log-retention).                                                                                                                                                                                                    |     |

Configuration is validated before the server listens; every problem is reported
at once and the process exits with status 1.

Raise the rate limit if many machines activate from one address at once — an
enterprise roll-out behind a single NAT, for example. IPv6 clients are limited
per /64.

The self-service move allowance is read from the database's audit trail each
time, not kept in memory, so changing `LICENSE_SELF_RELEASE_LIMIT` or the window
and restarting applies the new policy to the moves already recorded: lowering
the limit can put a licence over it at once, and raising it frees customers who
were refused. The admin CLI reads the same variables for `show`, so set them
there too if they differ from the defaults.

---

## Admin CLI cookbook

```
node admin.mjs <command> [arguments] [options]      # in the container or dist/license-server
npm run licensing:admin -- <command> …              # from the repository
```

Every command takes `--db <file>` (default `$LICENSE_DB_FILE`; one of the two is
required, except by `public-key`), `--json` for
machine-readable output, and `--help`. Exit codes: `0` success, `1` the
operation was refused (unknown key, seat limit, …), `2` the command line was
wrong. The CLI works directly on the database file and is safe to run while the
server is running.

| Command                                     | What it does                                       |
| ------------------------------------------- | -------------------------------------------------- |
| `create --edition <e> [options]`            | Mint keys                                          |
| `list [--search …]`                         | Find licences, newest first                        |
| `show <key>`                                | A licence, the computers it is on, and its history |
| `revoke <key> [--reason …]`                 | Stop a licence from activating                     |
| `restore <key>`                             | Undo a revocation                                  |
| `extend <key> --days/--expires/--perpetual` | Renew or change the end date                       |
| `release <key> <machine-id>`                | Free one computer's seat                           |
| `reset <key>`                               | Free every seat                                    |
| `offline <key> <machine-id>`                | Issue a token for a computer with no internet      |
| `prune-events [--dry-run]`                  | Delete history older than the retention now        |
| `public-key`                                | Print the public key builds must embed             |

### Issue a key after a sale

```bash
node admin.mjs create --edition professional \
  --to "Jane Doe" --email jane@example.com --order INV-1042
```

```
Created 1 professional licence (1 computer each, perpetual).
Registered to: Jane Doe   E-mail: jane@example.com   Order: INV-1042

  RECX-7K2QM-…
```

Seats default to the edition's standard (Professional 1, Business 3, Technician
and Enterprise unlimited); `--seats 5` or `--seats unlimited` overrides it. For a
subscription, add `--days 365` or `--expires 2027-12-31` (the licence works
through the end of that day, UTC). `--count 10` mints a batch.

`--order` makes minting idempotent: running the same command again with the
same order reference prints the existing keys and creates nothing. Use it every
time — it is what makes a retried webhook or a double-pasted command harmless.

### Renew a subscription

```bash
node admin.mjs extend RECX-7K2QM-… --days 365
```

`--days` adds to the current end date if it has not passed yet (an early
renewal loses nothing), or to today if it has. `--expires 2028-03-31` sets an
absolute date; `--perpetual` removes the end date.

The new date reaches a customer's computer the next time it activates, because
the expiry travels inside the token it holds. The application asks by itself —
it re-activates the stored key at start-up from two weeks before the end date
until a month after it — and the Licence screen's **Check for renewal** does the
same on demand, however long ago the licence ended. Otherwise ask them to
activate again (re-activating a computer that already holds a seat never costs
a seat). The server builds every token from the licence as it stands at that
moment, so the re-issued token carries the new end date — and the current
edition and registered owner — never a copy of the old token's. A renewal costs
no self-service move either: it is an activation, not a release.

Until you extend it, those checks after the end date are refused with `403`.
Refusals from a computer that still holds one of the licence's seats are left
out of the licence's history (they are in the request log), so a lapsed
customer launching every day does not push the events support needs out of
`show`. A lapsed licence refused on a computer _without_ a seat is still
recorded.

### Revoke after a refund or chargeback

```bash
node admin.mjs revoke RECX-7K2QM-… --reason "refund INV-1042"
```

From then on the key cannot activate — or re-activate — anywhere. A computer
that is already activated keeps working until its token expires (for a
perpetual licence, indefinitely), because the application verifies its token
offline and never checks back. See [Security](#security). `restore` undoes a
revocation.

### Free a seat for a customer who replaced their PC

The customer cannot deactivate a computer that no longer boots. Find the old
machine and release it:

```bash
node admin.mjs show RECX-7K2QM-…
```

```
Seats:               1 of 1 in use
Self-service moves:  1 of 4 in the last 365 days
…
Computers:
  MACHINE                        FIRST ACTIVATED       LAST ACTIVATED        RELEASED
  ABCD-EFGH-JKMN-PQRS-TVWX-YZ12  2026-03-02 09:14 UTC  2026-10-30 18:02 UTC  -
```

```bash
node admin.mjs release RECX-7K2QM-… ABCD-EFGH-JKMN-PQRS-TVWX-YZ12
```

Then the customer activates on the new computer. `reset <key>` frees every
seat at once, when nobody can say which machines are still in use.

`release` and `reset` (and their admin API routes) are never limited by the
[self-service move allowance](#the-self-service-move-allowance) and never count
against it — they are what a customer who has used it up is sent to you for.

### A customer has used up their self-service moves

The application told them something like _"This licence has already been moved
between computers 4 times in the last 12 months. It is still active on this
computer. To move it again, contact info@appsgain.in with your licence
key."_ Their licence is still active on the computer they were trying to
leave; nothing was lost.

1. Look at the licence:

   ```bash
   node admin.mjs show RECX-7K2QM-…
   ```

   ```
   Self-service moves:  4 of 4 in the last 365 days — allowance spent; use release or reset
   …
   Recent events:
     2026-11-12 10:41 UTC  deactivation-refused  ABCD-EFGH-JKMN-PQRS-TVWX-YZ12  from 203.0.113.7
     2026-09-01 08:03 UTC  activated             ABCD-EFGH-JKMN-PQRS-TVWX-YZ12  from 203.0.113.7
     2026-09-01 07:58 UTC  deactivated           QWER-TYUI-OPAS-DFGH-JKLZ-XCVB  from 203.0.113.7
     …
   ```

   The `deactivation-refused` line names the computer they want to leave.
   `--json` gives the same, with each event's detail.

2. Decide. Four moves in a year is a lot for one person, but a new PC, a
   Windows reinstall and a repair or two is not an unusual year. A history that
   alternates between the same two or three machine identifiers, or many
   `deactivated` events close together from different addresses, is the
   pattern the allowance exists to surface (see
   [what the allowance bounds](#what-the-allowance-bounds-and-what-it-does-not)).
3. To move it, release the machine named in the refused event:

   ```bash
   node admin.mjs release RECX-7K2QM-… ABCD-EFGH-JKMN-PQRS-TVWX-YZ12
   ```

   Ask the customer to press **Deactivate** on that computer again: the server
   now answers that the seat is already free, and the application removes its
   licence there. Then they activate on the new computer as usual.

The allowance is not reset by this — your release is simply not counted — and
it frees up on its own as each move becomes older than the window. If a
customer with a good reason keeps meeting it, keep releasing for them, or
raise `LICENSE_SELF_RELEASE_LIMIT` for everyone.

### Offline activation for an air-gapped machine

1. The customer opens the offline activation screen in RecoverX and sends
   you the machine identifier shown there (it looks like
   `ABCD-EFGH-JKMN-PQRS-TVWX-YZ12`).
2. You issue a token for that machine:

   ```bash
   node admin.mjs offline RECX-7K2QM-… ABCD-EFGH-JKMN-PQRS-TVWX-YZ12 --out activation.txt
   ```

3. Send `activation.txt` back; the customer pastes its contents into the
   offline activation screen.

The seat rules are exactly the online ones: an offline activation takes a seat,
and is refused if none is free. The identifier is case-insensitive when you type
it. Without `--out`, the token alone is printed on stdout and the explanation on
stderr, so `> activation.txt` also works.

### Find a customer

```bash
node admin.mjs list --search jane@example.com
node admin.mjs list --order INV-1042
node admin.mjs list --edition business --limit 200 --json
```

### Delete old activation history now

The running server does this by itself every day (see
[Event-log retention](#event-log-retention)). Run it by hand on a database no
server has open — a restored backup, or a copy kept for support — or to see
what the next pass will remove:

```bash
node admin.mjs prune-events --dry-run
# 12 events recorded before 2025-10-13 12:00 UTC (the retention is 395 days) would be deleted. …
node admin.mjs prune-events
# Deleted 12 events recorded before 2025-10-13 12:00 UTC (the retention is 395 days).
```

It reads `LICENSE_EVENT_RETENTION_DAYS` and `LICENSE_SELF_RELEASE_WINDOW_DAYS`
from the same environment as the server, so set them here too if they differ
from the defaults.

---

## HTTP API

All bodies are JSON (`Content-Type: application/json`, at most 16 KiB). Every
error is `{ "error": "<sentence>" }`; on the public routes the application shows
that sentence to the customer verbatim.

The application relies on that shape to tell the server's answers from anything
else's. An error status whose body is not `{ "error": … }` — a web host's own
"page not found", a firewall's or CDN's challenge page — counts as no answer at
all: an activation reports that the service could not be used rather than that
the key was rejected, and a seat release stays queued and is retried at the next
start-up rather than being given up. Whatever sits in front of the server must
therefore pass its error bodies through unchanged, never replace them with
pages of its own.

### Public routes (used by the application)

| Route                 | Body                                            | Success                    |
| --------------------- | ----------------------------------------------- | -------------------------- |
| `POST /v1/activate`   | `{ "key", "machineId", "product": "recoverx" }` | `200 { "token": "…" }`     |
| `POST /v1/deactivate` | `{ "token": "<the stored activation token>" }`  | `200 { "released": true }` |
| `GET /healthz`        | —                                               | `200 { "ok": true }`       |

| Status    | Activation                                     | Deactivation                                                                                                               |
| --------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 400       | Malformed request, mistyped key, wrong product | Unreadable token                                                                                                           |
| 403       | Licence revoked, or its term has ended         | Token not signed by this server's key                                                                                      |
| 404       | Key was never issued                           | Licence in the token does not exist                                                                                        |
| 409       | Every seat is held by another computer         | Self-service move allowance used up — the seat is **still held**; the application keeps its licence and shows the sentence |
| 413 / 415 | Body over 16 KiB / not JSON                    | same                                                                                                                       |
| 429       | Rate limited (`Retry-After` says for how long) | same                                                                                                                       |
| 503       | Database momentarily locked (`Retry-After: 2`) | same                                                                                                                       |

Activation is idempotent per machine: a computer that already holds a seat gets
a fresh token and no extra seat is taken. That token is built from the licence
as it stands now — its current end date, edition and registered owner — so
re-activating is also how a renewal reaches a computer. Deactivation verifies
the token's signature but not its expiry, so an expired licence can still give
its seat back; releasing an already-free seat answers
`200 { "released": false }`, is never refused and never counts as a move.

The application treats a `409` from deactivation as "refused — keep the
licence": it leaves the licence on the computer, does not retry, and shows the
`error` sentence. No other deactivation answer uses `409`, and none must. That
reading is newer than the route itself, so the application has to be out
before the server starts refusing — see
[Turning it on: the application first](#turning-it-on-the-application-first).

### Admin routes

Enabled only when `LICENSE_ADMIN_TOKEN` is set; every request needs
`Authorization: Bearer <token>`. Missing or wrong tokens get `401`; repeated
failures from one address are rate limited separately from activations, so the
real token is never locked out by someone guessing.

| Route                                                              | Body                                                          | Response                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /v1/admin/licenses`                                          | See below                                                     | `201 { created: true, licenses }`, or `200 { created: false, licenses }` for an order already fulfilled    |
| `GET /v1/admin/licenses?search=&orderRef=&edition=&limit=&offset=` | —                                                             | `200 { licenses }`                                                                                         |
| `GET /v1/admin/licenses/{key}`                                     | —                                                             | `200 { license, standing, activeSeats, selfReleases: { recent, limit, windowDays }, activations, events }` |
| `POST /v1/admin/licenses/{key}/revoke`                             | `{ "reason"? }` or empty                                      | `200 { license }`                                                                                          |
| `POST /v1/admin/licenses/{key}/restore`                            | empty                                                         | `200 { license }`                                                                                          |
| `POST /v1/admin/licenses/{key}/extend`                             | one of `{ "days" }`, `{ "expires" }`, `{ "perpetual": true }` | `200 { license }`                                                                                          |
| `POST /v1/admin/licenses/{key}/release`                            | `{ "machineId" }`                                             | `200 { released }` — not limited by, and not counted against, the self-service move allowance              |
| `POST /v1/admin/licenses/{key}/reset`                              | empty                                                         | `200 { released: <count> }` — likewise outside the allowance                                               |
| `POST /v1/admin/licenses/{key}/offline`                            | `{ "machineId" }`                                             | `200 { token, claims }`                                                                                    |

Create body — only `edition` is required; unknown fields are rejected, so a
misspelled field fails loudly instead of minting an anonymous licence:

```json
{
  "edition": "business",
  "count": 1,
  "seats": 3,
  "days": 365,
  "expires": "2027-12-31",
  "registeredTo": "Contoso Ltd",
  "email": "it@contoso.example",
  "orderRef": "stripe:cs_live_a1b2c3",
  "notes": "Annual plan"
}
```

(`days` and `expires` are alternatives; `seats: null` means unlimited.)
Timestamps in responses are epoch milliseconds.

### A payment webhook

Your payment provider's webhook handler — running on your own backend, which
verifies the provider's signature first — mints the licence and e-mails it:

```bash
curl -sS https://licensing.example.com/v1/admin/licenses \
  -H "Authorization: Bearer $LICENSE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "edition": "professional",
        "registeredTo": "Jane Doe",
        "email": "jane@example.com",
        "orderRef": "stripe:cs_live_a1b2c3"
      }'
```

```json
{
  "created": true,
  "licenses": [
    {
      "key": "RECX-7K2QM-…",
      "edition": "professional",
      "maxActivations": 1,
      "expiresAt": null,
      "orderRef": "stripe:cs_live_a1b2c3",
      …
    }
  ]
}
```

Use the provider's checkout or payment identifier as `orderRef`. Providers
deliver webhooks at least once; with `orderRef` set, a redelivery returns the
same keys with `200` and `"created": false` instead of minting a second
licence, so the handler can simply send whatever `licenses` contains.

A refund webhook revokes:

```bash
curl -sS -X POST "https://licensing.example.com/v1/admin/licenses/$KEY/revoke" \
  -H "Authorization: Bearer $LICENSE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "reason": "refund stripe:re_9z8y7x" }'
```

To find the keys of an order (for a refund that only carries the order id):

```bash
curl -sS "https://licensing.example.com/v1/admin/licenses?orderRef=stripe%3Acs_live_a1b2c3" \
  -H "Authorization: Bearer $LICENSE_ADMIN_TOKEN"
```

A renewal webhook extends:

```bash
curl -sS -X POST "https://licensing.example.com/v1/admin/licenses/$KEY/extend" \
  -H "Authorization: Bearer $LICENSE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "days": 365 }'
```

---

## The self-service move allowance

### Why there is one

An activation token is verified **offline** and cannot be recalled. When a
customer presses Deactivate, the server frees the seat and the application
deletes its licence file — but the server cannot reach into that computer and
make the token stop working. A customer who copied `license.json` before
deactivating can put the copy back afterwards: that computer is licensed again,
and the seat is free for another one. Repeated, the trick spreads one seat over
as many computers as the customer has patience for, and nothing the application
does on its own can prevent it, because anything stored on the customer's
computer can be restored from a backup.

The allowance limits how often a licence can be moved without a person seeing
it. Past it, moving the licence goes through support.

### How it works

- **What is counted:** each `POST /v1/deactivate` that actually frees a seat
  (a `deactivated` event in the licence's history), per licence key across all
  its computers, within a rolling window of `LICENSE_SELF_RELEASE_WINDOW_DAYS`
  days (default 365) ending now.
- **The refusal:** a release that would be one more than
  `LICENSE_SELF_RELEASE_LIMIT` (default 4) is not made. The server answers
  `409` with a sentence saying how many moves were used, that the licence is
  still active on this computer, and to contact support with the key; it
  records a `deactivation-refused` event. The application keeps its licence,
  shows the sentence, and does not retry.
- **Never counted, never refused:** releasing a seat that is already free
  (`200 { "released": false }` — the client retrying after a lost response);
  activations, re-activations and renewals; offline activations; and the
  operator's `release` and `reset`, from the CLI or the admin API.
- **Durable:** the count is read from the database's audit trail inside the
  same write transaction as the release. It survives restarts, is shared by
  every process using the database file, and two simultaneous releases cannot
  both take the last move. Restoring a database backup restores the counts as
  they were in that backup.
- **Licences with unlimited seats are never limited** (Technician and
  Enterprise by default, or anything created with `--seats unlimited`), whatever
  the limit — `0` included. The allowance exists to bound how far one seat can
  be stretched, and an unlimited licence has no seat to stretch: another
  activation would succeed anyway. Limiting it would only hurt the customer the
  edition is for — a technician who removes the licence from each customer's
  computer after a job, and who, past the allowance, would have to leave it
  installed there. Their moves are still counted and shown by `show`
  ("not limited (unlimited seats)"), so the pattern stays visible.
- **`LICENSE_SELF_RELEASE_LIMIT=0`** refuses every self-service release of a
  held seat on a limited licence, with a sentence saying only support can move
  the licence (rather than one saying it has been moved "0 times").

### Turning it on: the application first

The allowance depends on the application reading a `409` from deactivation as
"refused — keep the licence". A desktop build that sends releases to
`/v1/deactivate` but predates that reading treats a `409` like any other
final refusal: it deletes its licence, tells the customer it was removed, and
keeps nothing to retry, while the server still holds the seat. The customer
then meets "already active on another computer" on the new PC with no word of
why. Nothing the server can answer changes that, because such a build removes
its licence whatever the answer.

So roll a release out in this order:

1. Run the server with `LICENSE_SELF_RELEASE_LIMIT=1000000` (the largest
   accepted), so no release is refused.
2. Ship the desktop build that reads `409` and let it reach your customers.
3. Unset the variable (default 4) or set the limit you want, and restart.
   Moves made in the meantime were counted, so a licence moved often during
   the roll-out can be over the new limit at once.

In this codebase the deactivation call and the `409` reading arrived in the
same change, so the builds that predate it never call `/v1/deactivate` at all:
they delete the licence locally and leave the seat held, for support to free
with `release`, and the allowance never reaches them. The order above matters
if any build in between was ever shipped, and for any later change: the
meaning of `409` on deactivation must never change on the server before the
application that reads it is out.

### What the allowance bounds, and what it does not

Stated plainly, the residual risk: on a licence with _N_ seats and an
allowance of _L_ moves per window, a customer who restores a backed-up
licence file after every move can have the licence working on up to _N + L_
computers within one window — five for a single-seat licence with the defaults
— and on a **perpetual** licence that number can grow by up to _L_ with each
further window, because the restored tokens never expire. The allowance turns
"unlimited" into "a few computers a year, each leaving a `deactivated` event
from a different machine identifier in the history"; it does not make the trick
impossible.

- **Subscriptions bound it by their term.** Restored tokens carry the old end
  date. A renewal reaches a computer only by re-activating, which needs a seat,
  so the extra computers fall away at the end of the term.
- **Support releases are the same trade.** A computer you free with `release`
  keeps its token until it is deactivated there or the token expires. When a
  customer says the old computer is dead, you are taking their word for it; the
  history in `show` is what you have to judge by.
- **Tightening it** — a lower `LICENSE_SELF_RELEASE_LIMIT`, or `0` so that every
  move is a decision made by a person — narrows the gap at the cost of more
  support tickets. No setting reaches a token that has already been restored,
  for the same reason revocation does not (see [Security](#security)).
- **A release the application could not deliver.** When a customer deactivates
  while offline, the application removes the licence anyway and retries the
  release later. If that later attempt is refused with `409`, it is dropped —
  the licence is already gone from that computer — and the seat stays held by
  a computer that no longer uses it. The customer meets "already active on
  another computer" when they activate elsewhere; free the old seat with
  `release`.

The support procedure is in the cookbook:
[A customer has used up their self-service moves](#a-customer-has-used-up-their-self-service-moves).

---

## Event-log retention

Every activation, refused activation, release and administrative change is
written to the `events` table with the IP address and machine identifier of
the request. The published privacy policy
([store/privacy-policy.md](store/privacy-policy.md)) promises that this log is
kept for **13 months and then deleted**, and the server keeps that promise
itself:

- An event recorded more than `LICENSE_EVENT_RETENTION_DAYS` (default **395**)
  days ago is deleted. The cutoff is exact: now minus the retention, in whole
  24-hour days; an event recorded at the cutoff instant stays until the next
  pass.
- The server deletes them **when it starts** — before it takes requests, so
  history that aged out while it was down goes at once — and then **once a
  day**. Each pass logs `Pruned the event log` with the number deleted and the
  cutoff, the passes that delete nothing included, so the platform's log shows
  that it runs. A pass that fails (the database locked by a long backup, say)
  is logged as an error and tried again the next day; it never stops the
  server.
- `admin.mjs prune-events` runs the same pass on demand, and `--dry-run`
  only counts (see [the cookbook](#delete-old-activation-history-now)).
- Only events are deleted. Licences and the record of which computers hold
  them are records of a sale and stay, so `show` still lists every computer
  a key has been on, while its "Recent events" reach back 13 months.

The retention can never be shorter than `LICENSE_SELF_RELEASE_WINDOW_DAYS`:
self-service moves are counted from the `deactivated` events inside that
window, and deleting one early would quietly give back a move the customer had
already used. The server and the CLI refuse to start with such a setting. With
the defaults (395 ≥ 365) there is nothing to do; if you lengthen the window,
lengthen the retention — and the privacy policy's promise — with it.

The PHP port (`server-php/`) applies the identical rule, with the same default
and cutoff. Having no long-running process on shared hosting, it runs its pass
from the first request after a day has passed, and from a button in its admin
panel. A database moved between the two is pruned the same way by either.

Two other copies of the same addresses are covered by the same promise:

- **The request log.** The Node server writes one JSON line per request to
  stdout, with the client address. Where those lines go is the platform's
  decision, so set its retention to 13 months or less: Docker's
  `--log-opt max-size`/`max-file`, journald's `MaxRetentionSec=`, or your log
  shipper's.
- **Backups** (next section). A snapshot holds the event log as it was then.
  Keep database snapshots no longer than the retention; a restored snapshot is
  pruned the moment the server starts on it.

---

## Backups

Two things, with very different backup schedules:

**The signing key** — once, at generation, offline, in two places. It never
changes. See [step 2](#2-back-the-private-key-up-offline-now).

**The database** — regularly; daily at least. It is the only record of which
keys were sold and which machines hold them. A restored backup that is a day old
loses that day's sales (customers would get "We could not find that licence
key"), so keep the copy recent and keep your shop's order records as the second
source of truth from which a lost key can be re-minted.

Do not copy the `.db` file of a running server: in WAL mode, recent writes live
in the `-wal` file beside it and a plain file copy can be inconsistent. Take an
online snapshot instead, which SQLite makes consistent:

```bash
# Inside the container (no sqlite3 binary needed):
docker exec recoverx-licensing node -e \
  "new (require('node:sqlite').DatabaseSync)('/data/license-server.db').exec(\"VACUUM INTO '/data/backup-$(date +%F).db'\")"

# Or with the sqlite3 CLI on a plain host:
sqlite3 /var/lib/recoverx-licensing/licences.db ".backup '/backups/licences-$(date +%F).db'"
```

Copy the snapshot off the server, encrypt it (it holds customer names, e-mail
addresses and IP addresses), and test a restore now and then: stop the server,
replace the database file with the snapshot, start it, and `admin.mjs list`.
Delete snapshots once they are older than the event-log retention (13 months by
default): they contain the activation history, IP addresses included, that the
privacy policy promises to delete after that.

---

## Security

### What this protects against

- **Forged licences.** Tokens are Ed25519-signed; without the private key nobody
  can mint one the application accepts. The algorithm is fixed in code on both
  sides, not read from the token.
- **Copying an activation to another computer.** Tokens are bound to a machine
  identifier and rejected anywhere else.
- **Casual key sharing.** A key works on as many computers as it has seats.
  Passing it to a friend uses up a seat, and the owner notices.
- **Guessing keys.** The random part of a key carries 95 bits, and activation
  attempts are rate limited per client address.
- **Admin API exposure.** Disabled unless a 32+ character token is configured;
  compared in constant time; failed attempts rate limited; optionally fenced off
  at the proxy (see the nginx example).
- **Leaky logs.** Log lines carry only the masked key (`RECX-•••••-…-ABCDE`),
  never a full key, an activation token or the admin token.
- **Deploying the wrong key.** With `RECOVERX_LICENSE_PUBLIC_KEY` set, a
  mismatched signing key stops the server at start-up instead of failing every
  customer's activation.

### What it does not protect against

- **A patched application.** Every check that runs on the customer's computer
  can be removed from it by someone determined enough. Licensing keeps honest
  customers honest; it does not stop cracking.
- **Instant revocation.** A revoked or refunded licence cannot activate again,
  but a computer that already holds a token keeps working until the token's
  expiry — forever for a perpetual licence — because verification is offline by
  design (it is what makes air-gapped activation possible). For subscription
  licences, the term bounds the exposure.
- **Restoring a backed-up licence file.** For the same reason, deactivating
  frees the seat without disabling the token, so a customer who restores a copy
  of `license.json` after deactivating keeps that computer licensed while the
  seat moves on. The [self-service move allowance](#the-self-service-move-allowance)
  bounds how far one seat can be stretched that way — by default to four extra
  computers a year — and leaves a trail in the licence's history; it cannot
  close the gap.
- **A spoofed machine identifier.** The identifier is derived from Windows'
  `MachineGuid` and the host name. Someone who clones a Windows installation, or
  forges the identifier in a patched build, can reuse a token. Seats limit how
  far a single key spreads, not that.
- **Loss or theft of the signing key.** Anyone with it can mint licences for any
  edition. If it leaks, generate a new pair, ship a release built with the new
  public key, re-issue activations for paying customers (they simply activate
  again against the new server key), and accept that old builds will keep
  trusting the old key.
- **Network attackers, without HTTPS.** The server itself has no TLS; it relies
  on the reverse proxy. Do not expose port 8787.
- **Denial of service.** The per-address rate limit is about enumeration, not
  volume, and is per process. Put volumetric protection at the proxy or CDN.

### Privacy

The database stores what the shop gives it (name, e-mail address, order
reference) and, in the audit trail, the IP address and machine identifier of
each activation. The machine identifier is a salted hash that identifies an
installation to this vendor only. Include the database in your privacy notice,
your retention policy and your data-subject-request process. The published
privacy policy ([store/privacy-policy.md](store/privacy-policy.md)) says the
event log, IP addresses included, is deleted after 13 months. Both servers
enforce that themselves — see [Event-log retention](#event-log-retention) —
but the request log and the backups are yours to rotate.

---

## Troubleshooting

| Symptom                                                                                                     | Likely cause                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server exits with "does not match RECOVERX_LICENSE_PUBLIC_KEY"                                              | The key file is not the one whose public half the builds embed. Compare fingerprints with `admin.mjs public-key`.                                                                                                                                     |
| Activation succeeds but the application says the activation is not genuine                                  | The build was compiled with a different public key, and the server's guard rail is not configured. Set `RECOVERX_LICENSE_PUBLIC_KEY` on the server.                                                                                                   |
| Everyone behind one office network gets "Too many activation attempts"                                      | The proxy is not forwarding the client address (set `LICENSE_TRUST_PROXY=true` behind a proxy that overwrites `X-Forwarded-For`), or the office really is activating more than the burst allows — raise `LICENSE_RATE_LIMIT_BURST`.                   |
| `admin.mjs list` says "There is no licence database at …"                                                   | `LICENSE_DB_FILE` / `--db` points somewhere else. The CLI never creates an empty database except for `create`.                                                                                                                                        |
| The server or CLI says "LICENSE_DB_FILE is not set"                                                         | There is no default database path. Set `LICENSE_DB_FILE` (or pass `--db` to the CLI) to a path outside the source checkout.                                                                                                                           |
| A renewed customer still sees the old end date                                                              | Their computer holds a token issued before the renewal and has not asked since: it asks at start-up only from two weeks before the end date to a month after it. **Check for renewal** on the Licence screen, or activating again, fetches a new one. |
| A customer is told the licence "has already been moved between computers N times"                           | They have used the self-service move allowance; the licence is still active where they are. Release the old computer for them — see [A customer has used up their self-service moves](#a-customer-has-used-up-their-self-service-moves).              |
| Every customer's Deactivate is refused                                                                      | `LICENSE_SELF_RELEASE_LIMIT` is `0`, so all moves go through support. Unset it for the default of 4.                                                                                                                                                  |
| `503` with "The licence server is busy"                                                                     | Another process held the database's write lock for more than five seconds — usually a long-running backup or a second server on the same file.                                                                                                        |
| The server or CLI says "LICENSE_EVENT_RETENTION_DAYS (…) must be at least LICENSE_SELF_RELEASE_WINDOW_DAYS" | The self-service window was lengthened past the 395-day retention. Raise `LICENSE_EVENT_RETENTION_DAYS` to at least the window (and the privacy policy's retention with it), or shorten the window.                                                   |
| The log shows "Pruning the event log failed"                                                                | The daily pass could not get the database — usually a backup holding the write lock. It tries again the next day; `admin.mjs prune-events` catches up at once.                                                                                        |
