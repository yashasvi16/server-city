#!/usr/bin/env bash
# NOTE: this is the always-on alternative (Google Cloud free tier, needs a card).
# The current free deployment uses Render + Cloudflare Pages: see ../DEPLOY.md.
# One-time (and re-runnable) setup for the Go backend on a Google Cloud
# free-tier e2-micro running Debian 12. Run on the VM as root:
#
#   sudo bash setup.sh <api-host> <allowed-origins> [duckdns-token]
#
#   api-host         public hostname for the API, e.g. yashasvi-api.duckdns.org
#   allowed-origins  comma-separated site origins allowed to call it, e.g.
#                    https://yashasvi-rathore.pages.dev,https://yashasvi.is-a.dev
#   duckdns-token    optional: keeps the DuckDNS name pointed at this VM if
#                    its IP ever changes (stored only on this VM)
#
# Expects the server binary next to this script: ./server-city-linux-amd64
# What it sets up:
#   - a locked-down system user and /var/lib/server-city for the data log
#   - a systemd service (auto-restart, starts on boot) listening on 127.0.0.1:8080
#   - Caddy in front of it: automatic HTTPS (Let's Encrypt), WebSockets, gzip
#   - a 1 GB swap file (the VM has 1 GB of RAM)
#   - a daily backup of the guestbook/leaderboard log, 14 days kept
set -euo pipefail

API_HOST="${1:?usage: setup.sh <api-host> <allowed-origins> [duckdns-token]}"
ORIGINS="${2:?usage: setup.sh <api-host> <allowed-origins> [duckdns-token]}"
DUCK_TOKEN="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_SRC="$HERE/server-city-linux-amd64"

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$BIN_SRC" ] || { echo "missing $BIN_SRC (upload it next to this script)"; exit 1; }

echo "== packages"
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates cron >/dev/null

echo "== swap"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== user, binary, data"
id server-city >/dev/null 2>&1 || useradd --system --home /var/lib/server-city --shell /usr/sbin/nologin server-city
install -d -o server-city -g server-city -m 0750 /var/lib/server-city
install -m 0755 "$BIN_SRC" /usr/local/bin/server-city
install -d -m 0750 /etc/server-city
# The run-token secret is generated once on this machine and never leaves it.
if [ ! -f /etc/server-city/secret ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n' > /etc/server-city/secret
  chmod 600 /etc/server-city/secret
fi
cat > /etc/server-city/env <<ENV
ADDR=127.0.0.1:8080
DATA_DIR=/var/lib/server-city
ALLOWED_ORIGINS=$ORIGINS
CLIENT_IP_HEADER=X-Forwarded-For
LOG_LEVEL=info
RUN_SECRET=$(cat /etc/server-city/secret)
ENV
chmod 600 /etc/server-city/env

cat > /etc/systemd/system/server-city.service <<'UNIT'
[Unit]
Description=Living Server City backend
After=network-online.target
Wants=network-online.target

[Service]
User=server-city
Group=server-city
EnvironmentFile=/etc/server-city/env
ExecStart=/usr/local/bin/server-city
Restart=always
RestartSec=2
# graceful shutdown: the server drains sockets and closes the store on SIGTERM
KillSignal=SIGTERM
TimeoutStopSec=20
MemoryMax=300M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/server-city

[Install]
WantedBy=multi-user.target
UNIT

echo "== caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
cat > /etc/caddy/Caddyfile <<CADDY
$API_HOST {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 3
		}
	}
}
CADDY

echo "== backups"
cat > /etc/cron.daily/server-city-backup <<'BAK'
#!/bin/sh
# Daily copy of the guestbook/leaderboard log; keep two weeks.
mkdir -p /var/backups/server-city
tar -czf /var/backups/server-city/data-$(date +%F).tgz -C /var/lib server-city 2>/dev/null
find /var/backups/server-city -name 'data-*.tgz' -mtime +14 -delete
BAK
chmod 755 /etc/cron.daily/server-city-backup

if [ -n "$DUCK_TOKEN" ]; then
  echo "== duckdns updater"
  SUB="${API_HOST%%.duckdns.org}"
  printf 'DUCK_SUB=%s\nDUCK_TOKEN=%s\n' "$SUB" "$DUCK_TOKEN" > /etc/server-city/duckdns
  chmod 600 /etc/server-city/duckdns
  cat > /etc/cron.d/duckdns <<'DUCK'
*/10 * * * * root . /etc/server-city/duckdns && curl -fsS "https://www.duckdns.org/update?domains=$DUCK_SUB&token=$DUCK_TOKEN&ip=" -o /dev/null
DUCK
  . /etc/server-city/duckdns && curl -fsS "https://www.duckdns.org/update?domains=$DUCK_SUB&token=$DUCK_TOKEN&ip=" && echo
fi

echo "== start"
systemctl daemon-reload
systemctl enable --now server-city >/dev/null
systemctl restart server-city
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy
sleep 2
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then
  echo "backend: OK (local)"
else
  echo "backend did not answer; see: journalctl -u server-city -n 50"; exit 1
fi
echo
echo "Done. In a minute or two (first HTTPS certificate), this should print JSON:"
echo "  curl https://$API_HOST/api/stats"
