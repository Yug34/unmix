"""GET /api/youtube?url=<youtube link>  ->  the video's audio track, streamed.

The browser can't fetch YouTube media itself: googlevideo.com sends no CORS
headers, and this page is cross-origin isolated on top of that. So this is the
one piece of the app that runs on a server. It does exactly one thing -- turn a
YouTube link into bytes the browser can hand to decodeAudioData -- and the stem
separation still happens in the tab.

Deployed as a Vercel Python function (the `app` ASGI callable below). serve.py
imports `resolve` and `iter_audio` so the same code runs locally.

Response bytes are streamed, which is what lets a long song through: Vercel's
4.5 MB payload cap applies to buffered responses only.

Environment knobs, all optional:
  MAX_MINUTES     reject anything longer (default 20)
  YTDLP_COOKIES   contents of a Netscape cookies.txt, for when YouTube
                  decides the server is a bot
  YTDLP_PROXY     proxy URL passed straight to yt-dlp
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

MAX_MINUTES = float(os.environ.get("MAX_MINUTES", "20"))
# Prefer m4a: Safari's decodeAudioData doesn't do webm/opus. Skip HLS so no
# ffmpeg is needed; plain https downloads can be written straight to stdout.
FORMAT = ("bestaudio[ext=m4a][protocol^=http]/bestaudio[acodec^=mp4a][protocol^=http]"
          "/bestaudio[protocol^=http]/bestaudio")
CHUNK = 256 * 1024

MIME = {"m4a": "audio/mp4", "mp4": "audio/mp4", "webm": "audio/webm",
        "opus": "audio/ogg", "ogg": "audio/ogg", "mp3": "audio/mpeg"}

_ID = r"[A-Za-z0-9_-]{11}"
_PATTERNS = [
    re.compile(r"^(?:www\.|m\.|music\.)?youtube\.com$"),
    re.compile(r"^youtu\.be$"),
]


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def video_id(url):
    """The 11-char id, or None. Only YouTube is accepted: yt-dlp knows a
    thousand sites and this endpoint should not be a general-purpose proxy."""
    url = (url or "").strip()
    if not url:
        return None
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        p = urllib.parse.urlparse(url)
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    if not any(r.match(host) for r in _PATTERNS):
        return None
    if host == "youtu.be":
        m = re.match(rf"^/({_ID})", p.path)
        return m.group(1) if m else None
    m = re.match(rf"^/(?:shorts|embed|live|v)/({_ID})", p.path)
    if m:
        return m.group(1)
    v = urllib.parse.parse_qs(p.query).get("v", [""])[0]
    return v if re.fullmatch(_ID, v) else None


def _ydl_opts():
    opts = {
        "quiet": True, "no_warnings": True, "noprogress": True,
        "noplaylist": True, "format": FORMAT,
        "js_runtimes": {"deno": {"path": None}},
    }
    # yt-dlp solves YouTube's JS challenges with an external runtime. Deno is
    # its default; Node is what is more likely to be lying around on a server.
    if shutil.which("node"):
        opts["js_runtimes"]["node"] = {"path": None}
    if os.environ.get("YTDLP_PROXY"):
        opts["proxy"] = os.environ["YTDLP_PROXY"]
    cookies = os.environ.get("YTDLP_COOKIES")
    if cookies:
        path = os.path.join(tempfile.gettempdir(), "split-cookies.txt")
        if not os.path.exists(path):
            with open(path, "w") as f:
                f.write(cookies)
        opts["cookiefile"] = path
    return opts


def resolve(url):
    """Validate the link and extract metadata without downloading.

    Returns {title, duration, ext, mime, size, info}. Raises RequestError with
    an HTTP status for anything the user should hear about."""
    vid = video_id(url)
    if not vid:
        raise RequestError(400, "That doesn't look like a YouTube video link.")
    canonical = f"https://www.youtube.com/watch?v={vid}"

    try:
        import yt_dlp
    except ImportError:
        raise RequestError(503, "yt-dlp is not installed on this server.")

    try:
        with yt_dlp.YoutubeDL(_ydl_opts()) as ydl:
            info = ydl.extract_info(canonical, download=False)
    except yt_dlp.utils.DownloadError as e:
        raise RequestError(502, _friendly(str(e)))

    duration = info.get("duration") or 0
    if duration > MAX_MINUTES * 60:
        raise RequestError(413, f"That video is {duration / 60:.0f} minutes long; "
                                f"the limit is {MAX_MINUTES:.0f}.")
    if info.get("is_live"):
        raise RequestError(400, "Live streams can't be separated.")

    ext = info.get("ext") or "m4a"
    return {
        "id": vid,
        "title": info.get("title") or vid,
        "duration": duration,
        "ext": ext,
        "mime": MIME.get(ext, "application/octet-stream"),
        "size": info.get("filesize") or info.get("filesize_approx") or 0,
        "info": info,
    }


def _friendly(msg):
    msg = re.sub(r"^ERROR:\s*", "", msg).replace("[youtube] ", "")
    if "Sign in to confirm" in msg or "bot" in msg.lower():
        return ("YouTube asked this server to prove it isn't a bot. Try again later, "
                "or set YTDLP_COOKIES on the server.")
    if "Private video" in msg:
        return "That video is private."
    if "Video unavailable" in msg:
        return "That video is unavailable."
    if "age" in msg.lower() and "confirm" in msg.lower():
        return "That video is age-restricted and can't be fetched without cookies."
    return msg.split("\n")[0][:300]


def iter_audio(resolved):
    """Yield the audio bytes.

    Runs yt-dlp as a subprocess writing to stdout. The metadata we already
    extracted is handed over with --load-info-json so YouTube is not asked
    twice, and the download itself is left to yt-dlp -- it knows about chunked
    fetching, throttling and retries, none of which is worth reimplementing."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(resolved["info"], f)
        info_path = f.name

    opts = _ydl_opts()
    cmd = [sys.executable, "-m", "yt_dlp", "--load-info-json", info_path,
           "-o", "-", "-f", FORMAT, "--quiet", "--no-warnings", "--no-progress",
           "--no-part", "--no-playlist", "--js-runtimes", "deno"]
    if "node" in opts["js_runtimes"]:
        cmd += ["--js-runtimes", "node"]
    if "proxy" in opts:
        cmd += ["--proxy", opts["proxy"]]
    if "cookiefile" in opts:
        cmd += ["--cookies", opts["cookiefile"]]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    sent = 0
    try:
        while True:
            chunk = proc.stdout.read(CHUNK)
            if not chunk:
                break
            sent += len(chunk)
            yield chunk
        err = proc.stderr.read().decode("utf-8", "replace")
        proc.wait()
        if proc.returncode != 0 and sent == 0:
            raise RequestError(502, _friendly(err.strip() or "download failed"))
    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            os.unlink(info_path)
        except OSError:
            pass


def response_headers(resolved):
    """Headers the page reads before the body arrives. Non-ASCII titles are
    percent-encoded because HTTP headers are Latin-1 at best."""
    headers = [
        ("Content-Type", resolved["mime"]),
        ("Cache-Control", "no-store"),
        ("X-Title", urllib.parse.quote(resolved["title"], safe="")),
        ("X-Duration", str(resolved["duration"])),
        ("X-Video-Id", resolved["id"]),
    ]
    if resolved["size"]:
        headers.append(("X-Size", str(resolved["size"])))
    return headers


# ---------- Vercel entrypoint (ASGI) ----------

async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    import asyncio

    loop = asyncio.get_running_loop()

    async def start(status, headers):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(k.lower().encode(), v.encode()) for k, v in headers]})

    async def error(status, message):
        await start(status, [("Content-Type", "application/json"), ("Cache-Control", "no-store")])
        await send({"type": "http.response.body", "body": json.dumps({"error": message}).encode()})

    if scope["method"] != "GET":
        return await error(405, "GET only")
    qs = urllib.parse.parse_qs(scope.get("query_string", b"").decode())
    url = qs.get("url", [""])[0]

    try:
        resolved = await loop.run_in_executor(None, resolve, url)
        it = iter_audio(resolved)
        # Pull the first chunk before committing to a 200: if yt-dlp fails
        # outright, the page should get a real error status, not an empty 200.
        first = await loop.run_in_executor(None, next, it, None)
    except RequestError as e:
        return await error(e.status, str(e))
    except Exception as e:  # noqa: BLE001 -- surface anything, this is best effort
        return await error(500, f"{type(e).__name__}: {e}")

    await start(200, response_headers(resolved))
    chunk = first
    while chunk is not None:
        await send({"type": "http.response.body", "body": chunk, "more_body": True})
        try:
            chunk = await loop.run_in_executor(None, next, it, None)
        except RequestError:
            break   # mid-stream failure; headers are out, so just end the body
    await send({"type": "http.response.body", "body": b""})
