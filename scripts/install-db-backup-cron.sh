#!/usr/bin/env bash
# Schedules the nightly database backup to S3 (src/scripts/backup-db-to-s3.js) at 23:55 plant
# time (Asia/Jakarta), keeping the last 7 days. Run once on the EC2 box as root:
#
#   sudo bash /home/greencore_api_v2/scripts/install-db-backup-cron.sh
#
# Safe to re-run: it rewrites the same /etc/cron.d entry. Logs go to /var/log/greencore-db-backup.log.

set -euo pipefail

APP_DIR="/home/greencore_api_v2"
CRON_FILE="/etc/cron.d/greencore-db-backup"
LOG_FILE="/var/log/greencore-db-backup.log"

NODE_BIN="$(command -v node || true)"
PG_DUMP_BIN="$(command -v pg_dump || true)"
if [ -z "$NODE_BIN" ]; then echo "node not found on PATH — run this as the user that runs the API (root)"; exit 1; fi
if [ -z "$PG_DUMP_BIN" ]; then echo "pg_dump not found — install the PostgreSQL client tools first"; exit 1; fi

# The scheduler service is "crond" on Amazon Linux / RHEL and "cron" on Ubuntu; Amazon Linux 2023
# doesn't ship it, so install cronie when neither exists. (Checked with `systemctl cat`, not a
# `list-unit-files | grep -q` pipe, which fails under pipefail.)
if systemctl cat crond.service >/dev/null 2>&1; then
  CRON_SERVICE=crond
elif systemctl cat cron.service >/dev/null 2>&1; then
  CRON_SERVICE=cron
else
  echo "==> Installing cron..."
  dnf install -y cronie || yum install -y cronie
  CRON_SERVICE=crond
fi
systemctl enable --now "$CRON_SERVICE"

cat > "$CRON_FILE" <<EOF
# Greencore: nightly database backup to S3 (keeps 7 days). Installed by scripts/install-db-backup-cron.sh
CRON_TZ=Asia/Jakarta
55 23 * * * root cd $APP_DIR && PG_DUMP_PATH=$PG_DUMP_BIN $NODE_BIN src/scripts/backup-db-to-s3.js >> $LOG_FILE 2>&1
EOF
chmod 644 "$CRON_FILE"

echo "==> Scheduled: every day at 23:55 Asia/Jakarta → $CRON_FILE"
echo "==> Running one backup now to check it works..."
cd "$APP_DIR" && PG_DUMP_PATH="$PG_DUMP_BIN" "$NODE_BIN" src/scripts/backup-db-to-s3.js
