"""
Small local service for reading scale photos. The API's /production/ocr-weight route posts the
image bytes to /read and gets back JSON. It only listens on this machine and handles one photo
at a time, so a burst of photos waits in line instead of starving the API of CPU.

Setup: scripts/install-weight-ocr.sh
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import cv2
import numpy as np

from reader import read_weight

HOST = '127.0.0.1'
PORT = int(os.environ.get('WEIGHT_OCR_PORT', 8099))
MAX_IMAGE_BYTES = 12 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, body):
        payload = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == '/health':
            return self._send_json(200, {'ok': True})
        self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/read':
            return self._send_json(404, {'error': 'not found'})
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_IMAGE_BYTES:
            return self._send_json(400, {'error': 'image missing or too large'})
        data = self.rfile.read(length)
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return self._send_json(200, {'weight': None, 'reason': 'not a readable image', 'raw': None, 'confidence': None})
        try:
            self._send_json(200, read_weight(image))
        except Exception as error:
            print(f'Weight OCR failed: {error}', flush=True)
            self._send_json(500, {'error': 'read failed'})

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print(f'weight-ocr listening on {HOST}:{PORT}', flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()
