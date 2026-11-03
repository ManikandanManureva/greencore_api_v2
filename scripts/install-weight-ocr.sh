#!/usr/bin/env bash
# One-time setup of the free scale-photo reader on EC2. Run as root, because this app's PM2
# daemon lives under root:
#   sudo bash /home/greencore_api_v2/scripts/install-weight-ocr.sh
#
# Installing it changes nothing for operators. The API keeps using OpenAI until this is added
# to .env and the API is restarted (pm2 restart server --update-env):
#   WEIGHT_OCR_ENGINE=local          free reader only; a failed read asks for a retake
#   WEIGHT_OCR_ENGINE=local+openai   free reader first; OpenAI only for photos it can't read
#   WEIGHT_OCR_ENGINE=openai         back to OpenAI for every photo (the default)
# Safe to re-run.

set -euo pipefail

APP_DIR="/home/greencore_api_v2"
SERVICE_DIR="$APP_DIR/weight-ocr"
VENV="$SERVICE_DIR/.venv"

echo "==> Looking for Python 3.8 - 3.12..."
PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3.9 python3.8 python3; do
  if command -v "$candidate" > /dev/null 2>&1 \
    && "$candidate" -c 'import sys; sys.exit(0 if (3, 8) <= sys.version_info[:2] <= (3, 12) else 1)'; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "No Python between 3.8 and 3.12 found. Install one first (e.g. dnf install python3.11)." >&2
  exit 1
fi
echo "    Using $($PYTHON --version)"

echo "==> Installing packages..."
"$PYTHON" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$SERVICE_DIR/requirements.txt"
"$VENV/bin/pip" install --quiet --no-deps rapidocr-onnxruntime==1.4.4

echo "==> Checking the reader loads..."
(cd "$SERVICE_DIR" && "$VENV/bin/python" -c 'import numpy as np; from reader import read_weight; print("    Blank photo:", read_weight(np.zeros((100, 100, 3), dtype=np.uint8))["reason"])')

echo "==> Starting the service under PM2..."
if pm2 describe weight-ocr > /dev/null 2>&1; then
  pm2 restart weight-ocr
else
  pm2 start "$SERVICE_DIR/server.py" --name weight-ocr --interpreter "$VENV/bin/python" --cwd "$SERVICE_DIR"
fi
pm2 save

echo "==> Waiting for it to answer..."
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8099/health > /dev/null 2>&1; then
    echo "==> Done. Service is running. Set WEIGHT_OCR_ENGINE in .env to switch it on (see the top of this script)."
    exit 0
  fi
  sleep 2
done
echo "Service did not answer. Check: pm2 logs weight-ocr --lines 30 --nostream" >&2
exit 1
