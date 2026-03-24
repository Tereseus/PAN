#!/usr/bin/env python3
"""PAN Whisper Server — Keeps Whisper model loaded in memory for instant transcription.
Listens on port 7778 for WAV file paths, returns transcription.
Model loads once on startup, subsequent requests are <1 second.
"""
import json
import time
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

print("[PAN Whisper] Loading model...", flush=True)
t0 = time.time()
from faster_whisper import WhisperModel
model = WhisperModel("tiny", device="cuda", compute_type="float16")
print(f"[PAN Whisper] Model loaded in {time.time()-t0:.1f}s (GPU: cuda, faster-whisper tiny)", flush=True)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress request logs

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        wav_path = body.get('wav_path', '')
        if not wav_path or not os.path.exists(wav_path):
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "wav_path required"}).encode())
            return

        t0 = time.time()
        segments, _ = model.transcribe(wav_path, language="en")
        text = " ".join(s.text.strip() for s in segments).strip()
        elapsed = round(time.time() - t0, 2)

        print(f"[PAN Whisper] {elapsed}s: {text[:80]}", flush=True)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"text": text, "seconds": elapsed}).encode())

PORT = 7778
print(f"[PAN Whisper] Listening on http://127.0.0.1:{PORT}", flush=True)
HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
