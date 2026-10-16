#!/usr/bin/env bash
# Deploy script for the greencore_api_v2 backend on EC2.
# Paste this into the EC2 Instance Connect browser terminal (or run it there as a file),
# after you've connected via the AWS Console's "Connect" button.
#
# What it does:
#   1. Pulls the latest code from git
#   2. Installs any new/updated dependencies
#   3. Runs the schema migrations that are safe to re-run (IF NOT EXISTS / idempotent)
#   4. Restarts the app under PM2
#
# Adjust APP_DIR below if the project doesn't live at /home/greencore_api_v2 on this box.

set -euo pipefail

APP_DIR="/home/greencore_api_v2"
cd "$APP_DIR"

echo "==> Pulling latest code..."
git fetch origin
git pull origin main

echo "==> Installing dependencies..."
npm install --omit=dev

echo "==> Running schema migrations (safe to re-run)..."
node src/scripts/ensure-schema-migrations.js
node src/scripts/add-raw-material-region.js
node src/scripts/add-raw-material-pe-grade-weights.js
node src/scripts/add-production-corrections.js

echo "==> Restarting app under PM2..."
# The running PM2 process on this box is named "server" (not "greencore-api" as its
# ecosystem.config.cjs name would suggest — it was started directly, not via that file).
# Must run as root: this app's PM2 process lives under root's PM2 daemon, not ec2-user's.
pm2 restart server --update-env

echo "==> Done. Recent logs:"
pm2 logs server --lines 20 --nostream
