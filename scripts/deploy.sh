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

# Spare Parts
node src/scripts/create-spareparts-v2.js
node src/scripts/create-spareparts-admin-user.js

# Finished Goods / Outgoing-Sales (Finished Goods, Flakes, By Products)
node src/scripts/create-finished-goods.js
node src/scripts/add-finished-goods-category-column.js
node src/scripts/add-finished-goods-packing-list-column.js
node src/scripts/create-finished-goods-opening-stock.js
node src/scripts/create-finished-goods-history.js
node src/scripts/add-finished-goods-pet-type.js
node src/scripts/create-finished-goods-shipment-bags.js
node src/scripts/create-finished-goods-bag-refs.js
node src/scripts/add-finished-goods-bag-ref-used.js
node src/scripts/add-finished-goods-shipment-ref-no.js
node src/scripts/create-roles-permissions.js
node src/scripts/add-users-deleted-at.js
node src/scripts/add-finished-goods-disposition.js
node src/scripts/add-finished-goods-opening-stock-as-of.js

# QC Lab
node src/scripts/create-qc-lab.js
node src/scripts/create-qc-lab-user.js
node src/scripts/add-qc-lab-photo-column.js

# Procurement (PB → approvals → PO → LPB)
node src/scripts/create-procurement.js
node src/scripts/add-procurement-approval-config.js
node src/scripts/add-procurement-receipt-qc.js
node src/scripts/add-packaging-pools-issue-types.js
node src/scripts/add-packaging-batch-sales-link.js
node src/scripts/add-procurement-general-items.js
node src/scripts/add-procurement-multi-po.js
node src/scripts/fix-imported-sample-links.js

# Per-user UI language preference
node src/scripts/add-user-language.js
node src/scripts/add-procurement-receipt-vehicle.js
node src/scripts/add-procurement-approval-groups.js
node src/scripts/add-procurement-mail-actions.js

# One-time data loads below are NOT run here — they're safe to re-run (they skip if data
# already exists) but are listed separately since they're one-off imports, not schema setup:
#   node src/scripts/seed-spareparts.js                     (initial spare parts catalog)
#   node src/scripts/migrate-spareparts-v2.js                (v1 -> v2 schema data migration)
#   node src/scripts/merge-pcpe-spareparts.js                (merged PC+PE catalogs)
#   node src/scripts/refresh-starlinger-and-boretech.js      (refreshed PET spare parts data)
#   node src/scripts/remove-duplicate-sp-mec-items.js        (one-time duplicate cleanup)
#   node src/scripts/import-qc-lab-history.js                (668 historical QC Lab samples)
# Run any of these by hand only if this server has never had that data loaded.

echo "==> Restarting app under PM2..."
# The API normally runs under root's PM2 daemon as "server", but after a reboot or when the
# console session lands in a different account it may live under ec2-user's daemon instead.
# Find the process that runs this repo (any name, root first, then ec2-user) and restart it.
find_pm2_name() {  # $1 = pm2 command prefix
  $1 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
      try {
        const l = JSON.parse(s);
        // the API itself: node running this repo's server.js (not the weight-ocr python helper that lives in a sub-folder)
        const isApi = (x) => x.name !== "weight-ocr" && /greencore_api_v2\/(src\/)?server\.(js|cjs|mjs)$/.test((x.pm2_env && x.pm2_env.pm_exec_path) || "");
        const p = l.find(isApi) || l.find((x) => x.name === "server");
        console.log(p ? p.name : "");
      } catch { console.log(""); }
    });'
}
restart_with() {  # $1 = pm2 command prefix, $2 = label
  local name; name=$(find_pm2_name "$1")
  [ -z "$name" ] && return 1
  echo "   restarting PM2 process '$name' ($2)"
  $1 restart "$name" --update-env
  if $1 describe weight-ocr > /dev/null 2>&1; then $1 restart weight-ocr; fi
  echo "==> Done. Recent logs:"
  $1 logs "$name" --lines 20 --nostream
  return 0
}
if ! restart_with "pm2" "$(whoami)"; then
  if id ec2-user > /dev/null 2>&1 && restart_with "sudo -u ec2-user -i pm2" "ec2-user"; then :; else
    echo "!! No PM2 process for this API was found under $(whoami) or ec2-user."
    echo "   Check who owns port 3000:   ss -ltnp | grep ':3000'"
    echo "   List processes:              pm2 list      and      sudo -u ec2-user -i pm2 list"
    echo "   If nothing runs the API:     pm2 start src/server.js --name server && pm2 save"
    exit 1
  fi
fi
