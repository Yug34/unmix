#!/usr/bin/env python3
"""Static server for split.

Exists only to set the two cross-origin isolation headers. Without them
SharedArrayBuffer is unavailable, ONNX Runtime falls back to a single WASM
thread, and separation takes several times longer.

Stdlib only -- no venv, no dependencies. Just: python3 serve.py

The one exception is /api/youtube, which needs yt-dlp (pip install "yt-dlp[default]").
Without it the endpoint answers 503 and everything else keeps working.
"""

import argparse
import functools
import http.server
import importlib.util
import json
import socketserver
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE / "static"


def load_youtube_api():
    """The Vercel function, imported by path so serve.py and production share one
    implementation. Deferred so a missing yt-dlp only matters when it's used."""
    spec = importlib.util.spec_from_file_location("youtube_api", HERE / "api" / "youtube.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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
        elif not self.path.startswith("/api/"):   # the API sets its own
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/youtube":
            return self.youtube()
        super().do_GET()

    def youtube(self):
        yt = load_youtube_api()
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = qs.get("url", [""])[0]

        def error(status, message):
            body = json.dumps({"error": message}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        try:
            resolved = yt.resolve(url)
            it = yt.iter_audio(resolved)
            first = next(it, None)
        except yt.RequestError as e:
            return error(e.status, str(e))
        except Exception as e:  # noqa: BLE001
            return error(500, f"{type(e).__name__}: {e}")

        self.send_response(200)
        for k, v in yt.response_headers(resolved):
            self.send_header(k, v)
        # Length is unknown up front; close the connection to mark the end
        # rather than framing chunks by hand.
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            chunk = first
            while chunk is not None:
                self.wfile.write(chunk)
                chunk = next(it, None)
        except (BrokenPipeError, ConnectionResetError, yt.RequestError):
            pass
        self.close_connection = True

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
