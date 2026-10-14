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
node src/scripts/create-pet-batches-tables.js

echo "==> Restarting app under PM2..."
pm2 restart greencore-api --update-env

echo "==> Done. Recent logs:"
pm2 logs greencore-api --lines 20 --nostream
