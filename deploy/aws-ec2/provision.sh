#!/usr/bin/env bash
# RecoverX — provision an AWS EC2 Ubuntu 24.04 server (arm64, t4g.micro) for recoverx.snapkio.com
#
# Serves the static website, the PHP licence server (server-php/), the installer
# downloads and the auto-update feed from one Apache vhost — the same layout the
# Hostinger site used, so server-php/public/.htaccess works unchanged:
#
#   /var/www/recoverx/public_html/         website + v1/ admin/ setup/ + downloads/ updates/
#   /var/www/recoverx/recoverx-licensing/  app/ (code), config.local.php and data/ (signing key, DB) — NOT web-served
#
# Run once as the default `ubuntu` user:  sudo bash provision.sh
# Idempotent: safe to run again. HTTPS is added afterwards with certbot, once DNS
# for recoverx.snapkio.com points at this server's Elastic IP (see README.md).
set -euo pipefail

DOMAIN="recoverx.snapkio.com"
ALIAS="www.recoverx.snapkio.com"
ROOT="/var/www/recoverx"
DEPLOY_USER="ubuntu"

export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  apache2 libapache2-mod-php8.3 php8.3-cli php8.3-common php8.3-sqlite3 php8.3-mbstring \
  sqlite3 unzip certbot python3-certbot-apache unattended-upgrades ca-certificates

# Sodium is compiled into Ubuntu's php8.3-common; fail loudly if not.
php -r 'exit(function_exists("sodium_crypto_sign_detached") ? 0 : 1);' \
  || { echo "PHP sodium is missing" >&2; exit 1; }
php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);' \
  || { echo "PHP pdo_sqlite is missing" >&2; exit 1; }
# Licence e-mail (Amazon SES) uses PHP's own HTTPS streams: openssl, no cURL needed.
php -r 'exit(extension_loaded("openssl") ? 0 : 1);' \
  || { echo "PHP openssl is missing" >&2; exit 1; }

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Folders"
install -d -o "$DEPLOY_USER" -g www-data -m 2775 "$ROOT" "$ROOT/public_html" "$ROOT/recoverx-licensing"
# data/ holds the signing key and the database: only the web server may read it.
install -d -o www-data -g www-data -m 0700 "$ROOT/recoverx-licensing/data"

echo "==> PHP settings"
cat > /etc/php/8.3/apache2/conf.d/90-recoverx.ini <<'INI'
expose_php = Off
display_errors = Off
log_errors = On
date.timezone = UTC
session.cookie_secure = 1
session.cookie_httponly = 1
session.use_strict_mode = 1
INI

echo "==> Apache"
a2enmod rewrite headers expires >/dev/null
a2dissite 000-default >/dev/null 2>&1 || true
# Named zz- so it loads after Ubuntu's security.conf, which sets ServerTokens OS.
a2disconf recoverx-hardening >/dev/null 2>&1 || true
rm -f /etc/apache2/conf-available/recoverx-hardening.conf
cat > /etc/apache2/conf-available/zz-recoverx-hardening.conf <<'CONF'
ServerTokens Prod
ServerSignature Off
TraceEnable Off
CONF
a2enconf zz-recoverx-hardening >/dev/null

# Port 80 only. certbot (README.md) copies it into recoverx-le-ssl.conf for 443
# and adds the http -> https redirect here.
cat > /etc/apache2/sites-available/recoverx.conf <<CONF
<VirtualHost *:80>
    ServerName ${DOMAIN}
    ServerAlias ${ALIAS}
    DocumentRoot ${ROOT}/public_html

    <Directory ${ROOT}/public_html>
        Options -Indexes +FollowSymLinks
        # server-php/public/.htaccess carries the licence-API rewrites, the
        # deny rules and the 404 page; let it apply exactly as on Hostinger.
        AllowOverride All
        Require all granted
    </Directory>

    # Defence in depth: the private folder is outside DocumentRoot, but never serve it.
    <Directory ${ROOT}/recoverx-licensing>
        Require all denied
    </Directory>

    # Installers and update metadata: cacheable, but latest.yml must always revalidate.
    <LocationMatch "^/updates/win/[^/]+/latest\.yml$">
        Header set Cache-Control "no-cache"
    </LocationMatch>

    ErrorLog \${APACHE_LOG_DIR}/recoverx-error.log
    CustomLog \${APACHE_LOG_DIR}/recoverx-access.log combined
</VirtualHost>
CONF
a2ensite recoverx >/dev/null
apache2ctl configtest
systemctl reload apache2

echo "==> Log retention (privacy policy: web access logs kept 30 days, then deleted)"
sed -i 's/^\s*rotate .*/\trotate 30/; s/^\s*weekly/\tdaily/' /etc/logrotate.d/apache2 || true

echo "==> Done. Next (README.md): deploy files, point DNS here, then:"
echo "    sudo certbot --apache -d ${DOMAIN} -d ${ALIAS} --redirect --agree-tos -m info@appsgain.in --no-eff-email"
echo "    and add the www redirect + HSTS lines to /etc/apache2/sites-available/recoverx-le-ssl.conf"
