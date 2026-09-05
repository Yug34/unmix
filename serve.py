#!/usr/bin/env python3
"""Static server for split.

Exists only to set the two cross-origin isolation headers. Without them
SharedArrayBuffer is unavailable, ONNX Runtime falls back to a single WASM
thread, and separation takes several times longer.

Stdlib only -- no venv, no dependencies. Just: python3 serve.py
"""

import argparse
import functools
import http.server
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "static"


class Handler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 is required for Chrome to populate its disk cache. On 1.0 it
    # re-downloads the 130 MB model on every single page load, Cache-Control
    # headers notwithstanding. Safe because Content-Length is always sent.
    protocol_version = "HTTP/1.1"

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".onnx": "application/octet-stream",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # The model and wasm are large and content-addressed by name; letting the
        # browser cache them is the difference between a 1s and a 40s reload.
        if self.path.endswith((".wasm", ".onnx")):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        # flush=True matters: stdout is block-buffered when redirected to a file,
        # which silently swallows the log exactly when you most want to read it.
        print(f"  {fmt % args}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=8000)
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=str(ROOT))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"split -> http://localhost:{args.port}  (cross-origin isolated)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")


if __name__ == "__main__":
    main()
