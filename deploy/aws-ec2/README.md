# recoverx.snapkio.com on AWS (EC2)

The website, the PHP licence server (`server-php/`), the installer downloads, the update feed and the licence e-mail run on one AWS EC2 server in **ap-south-1 (Mumbai)**. DNS for `snapkio.com` is in Route 53. Account-specific details (resource IDs, addresses, access) are kept in the vendor's private operations notes, not in this public repository.

## What runs where

| Piece             | Setup                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server            | One t4g.micro instance, Ubuntu 24.04 arm64, encrypted gp3 disk, IMDSv2 only, termination protection on, Elastic IP                                                                                 |
| Firewall          | 80 and 443 open to everyone (IPv4 and IPv6); 22 (SSH) only from the operator's own address (/32)                                                                                                   |
| Web server        | Apache 2.4 + PHP 8.3 (mod_php), set up by [provision.sh](provision.sh). One vhost for `recoverx.snapkio.com` and `www.recoverx.snapkio.com` (www redirects to the bare name)                       |
| Files             | `/var/www/recoverx/public_html` (website, `v1/`, `admin/`, `setup/`, `downloads/`, `updates/`) and `/var/www/recoverx/recoverx-licensing` (`app/`, `config.local.php`, `data/` — never web-served) |
| HTTPS             | Let's Encrypt (ECDSA) for both names, renewed by `certbot.timer` with the Apache plugin. HSTS for one year on `recoverx.snapkio.com` only (not its subdomains)                                     |
| E-mail            | Amazon SES, domain identity `snapkio.com` (Easy DKIM, custom MAIL FROM `mail.snapkio.com`, DMARC), sender `licences@snapkio.com`, account suppression list for bounces and complaints              |
| E-mail permission | An instance role that may only call `ses:SendEmail`/`SendRawEmail` with `ses:FromAddress` = `licences@snapkio.com`. No AWS access keys exist anywhere                                              |
| Backups           | Daily EBS snapshots (Data Lifecycle Manager, last 7 kept), plus the admin panel's Backup page (database snapshot, signing key) — keep an offline copy of the signing key                           |

## Deploying

From the repository root, on a computer the firewall allows. `<key>` is the operator's SSH key and `<server>` the server's address.

**Website** (after `npm run website:build`): unpack over `public_html`; files that are not in the build (the licence server's `v1/`, `admin/`, `setup/`, `.htaccess`, `downloads/`, `updates/`) are left alone.

```bash
tar -C dist/website -cf - . | ssh -i <key> ubuntu@<server> 'tar -C /var/www/recoverx/public_html --no-same-owner --no-overwrite-dir -xf -'
```

**Licence server code**: back up `app/` on the server, then unpack the new one. `data/` and `config.local.php` are never touched.

```bash
ssh -i <key> ubuntu@<server> 'cp -a /var/www/recoverx/recoverx-licensing/app ~/app-backup-$(date +%Y%m%d%H%M)'
tar -C server-php -cf - app README.md | ssh -i <key> ubuntu@<server> 'tar -C /var/www/recoverx/recoverx-licensing --no-same-owner -xf -'
tar -C server-php/public -cf - order | ssh -i <key> ubuntu@<server> 'tar -C /var/www/recoverx/public_html --no-same-owner -xf -'
```

The second `tar` is the order form's endpoint (`/order/`); without it the form on /buy/ gets a 404. Check: `curl -sI https://recoverx.snapkio.com/order/` answers 303 to `/buy/#order`.

**A release**: the installer and its `.blockmap` go to `public_html/downloads/win/<version>/`; the installer, `.blockmap` and `latest.yml` to `public_html/updates/win/latest/` (see [docs/RELEASE.md](../../docs/RELEASE.md)). Then rebuild and upload the website so /download/ shows the new checksum.

Check afterwards: `https://recoverx.snapkio.com/healthz` answers 200, `/download/` shows the new version.

## E-mail

`recoverx-licensing/config.local.php` on the server switches it on:

```php
<?php

return [
    'mail_from' => 'licences@snapkio.com',
    'mail_from_name' => 'RecoverX',
    'mail_reply_to' => 'info@appsgain.in',
    'ses_region' => 'ap-south-1',
];
```

The admin panel then offers **E-mail the key** on each licence and a tick box when creating licences ([server-php/README.md → E-mailing licence keys](../../server-php/README.md#e-mailing-licence-keys)). The server signs its requests with the instance role's temporary credentials from the instance metadata service.

SES delivers to any address only once the account has production access; in the sandbox it delivers only to addresses verified in SES, and the panel says so when SES refuses. To test the whole path without mailing anyone, send to `success@simulator.amazonses.com`.

## HTTPS renewal

`certbot.timer` renews by itself. `sudo certbot renew --dry-run` proves it works (it waits a random few minutes first when run without a terminal). The 443 vhost `/etc/apache2/sites-available/recoverx-le-ssl.conf` carries two hand-added blocks that certbot keeps: the `www.` → bare-name redirect and the `Strict-Transport-Security` header.

## Building a new server

1. Launch an Ubuntu 24.04 arm64 instance as described above, attach the Elastic IP and the SES instance role.
2. `sudo bash provision.sh`.
3. Deploy the website, `server-php/public/` into `public_html`, `server-php/app` into `recoverx-licensing/`, the downloads and the update feed.
4. Restore `recoverx-licensing/data/` from a snapshot or the admin panel's backups (owner `www-data`, folders 0700, files 0600), and `config.local.php`.
5. Point `recoverx` in Route 53 at the new address, then run the `certbot` line provision.sh prints and re-add the two blocks above.
