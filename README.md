# split

Drop in a song or paste a YouTube link, get back separated tracks — vocals, drums,
bass, guitar, piano and everything else — and play them together with per-stem mute,
solo and volume. Everything you've separated stays in a library in the browser.

Separation runs in the browser. Uploaded audio never leaves the machine. The one
server round-trip is fetching audio for a YouTube link, because the browser can't
fetch YouTube media itself.

## Run it

```bash
python3 serve.py
```

Then open <http://localhost:8000>. `serve.py` is stdlib-only, so there's no virtualenv
and no dependencies for file uploads.

For YouTube links locally, install yt-dlp and run `serve.py` with that Python:

```bash
python3 -m venv .venv && .venv/bin/pip install "yt-dlp[default]"
.venv/bin/python serve.py
```

The first separation downloads the model once (130 MB, cached afterwards). After that
it works offline. A 4-minute song takes roughly 100 seconds on Apple Silicon.

You can install it from Chrome's address bar to get a dock icon and its own window.

## YouTube links

Paste a link into the field under the dropzone (pasting alone starts it). The page asks
`/api/youtube`, which runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) on the server,
picks the best audio-only stream (m4a preferred — Safari can't decode webm/opus) and
streams the bytes back. The browser decodes them exactly as it would an uploaded file;
nothing is kept on the server.

The server side is best-effort by nature:

- YouTube sometimes answers datacenter IPs with a bot check. The error is shown as-is.
  Setting `YTDLP_COOKIES` (contents of a Netscape `cookies.txt`) usually gets past it.
- yt-dlp wants a JavaScript runtime (Deno or Node) to solve YouTube's challenges. Node
  is enabled automatically when present. Without one, audio formats still resolve today,
  with a warning.
- `MAX_MINUTES` (default 20) rejects long videos before downloading. The app's own
  8-minute memory warning still applies after decoding.

## Library

Every separation is saved to IndexedDB after the player comes up, as six 192 kbps MP3s
(~35 MB for a four-minute song; PCM would be half a gigabyte). Reopening a track from
the Library card decodes them back in about a second. Downloads from a reopened track
are re-encoded from that MP3, so for archival quality use **All stems (.zip)** right
after separating.

The library is per-browser and per-origin. Clearing site data removes it.

## Making a custom mix

The volume slider on each stem shows a percentage. Set the balance you want — drums 50%,
vocals 30%, guitar 70% — and **Download this mix** bounces exactly what you're hearing
to a single MP3. Mutes and solos count too: a soloed stem exports alone.

Sliders go to 150%, so stems can be pushed above their original level. If the result
would clip, the whole mix is turned down by one factor — preserving the balance you set —
and the app tells you how much it moved.

**All stems (.zip)** still gives you the six separated tracks individually.

## How it works

`htdemucs_6s` — Meta's 6-source Demucs — exported to ONNX and run with
[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) on WebGPU, falling back
to multi-threaded WASM. The track is processed in 7.8-second windows with 25% overlap
and reassembled with a fade window.

| stem | notes |
|---|---|
| vocals, drums, bass | clean |
| guitar | usable; this is the only model that isolates it at all |
| piano | the Demucs authors flag it as experimental |
| other | everything else |

Measured on an M3 Pro, for a 4:53 track:

| | time |
|---|---|
| WebGPU | ~106s |
| WASM fallback | ~163s |

Chrome is the best experience. Safari 18 has WebGPU behind a feature flag, so it takes
the slower WASM path.

### Why it's built this way

A few things here look arbitrary but are load-bearing, each found the hard way:

- **The ONNX session options are not optional.** With ONNX Runtime's defaults the model
  fails to load at all with `std::bad_alloc` — the 32-bit WASM heap can't take it.
  `graphOptimizationLevel: 'disabled'`, `enableMemPattern: false` and
  `enableCpuMemArena: false` are required. See `separate.worker.js`.
- **The model is cached with the Cache API, not HTTP caching.** Chrome silently refuses
  to store a single resource of this size in its disk cache, so `Cache-Control` alone
  re-downloads 130 MB on every page load.
- **The AudioContext is pinned to 44,100 Hz.** `new AudioContext()` follows the output
  device — 96 kHz on some Macs — and `decodeAudioData` resamples to match. Wrong rate
  in, wrong stems out.
- **Stem order is `drums, bass, other, vocals, guitar, piano`.** That's the model's
  channel order, not the order they're displayed in.
- **Cross-origin isolation** is needed for multi-threaded WASM. `serve.py` sets the
  headers; `coi-serviceworker.js` covers hosts that can't.

### Audio formats

Whatever the browser can decode, which is nearly everything: mp3, wav, flac, ogg, m4a,
and video files (the audio track is used). Notably this includes streaming containers
and files whose extension is simply wrong.

## Deploying

`vercel.json` is set up for Vercel: the static site from `static/`, the model fetched at
build time, and `api/youtube.py` as a Python function (`requirements.txt` installs
yt-dlp). Push and it deploys. Optional env vars: `YTDLP_COOKIES`, `YTDLP_PROXY`,
`MAX_MINUTES`.

The function streams its response, which is what gets a full song past Vercel's 4.5 MB
cap on buffered function responses. `maxDuration` is 300 s, the Hobby-plan maximum.

Any other host works for the static part. The one requirement is the two cross-origin
isolation headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Netlify and Cloudflare Pages can set them. For hosts that can't (GitHub Pages),
`coi-serviceworker.js` is already wired up and handles it. Without the API, pasting a
YouTube link shows an error and uploads keep working.

`static/models/*.onnx` is gitignored. Fetch it before deploying elsewhere:

```bash
curl -L -o static/models/htdemucs_6s_fp16.onnx \
  https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx
```

## Layout

```
serve.py                     static server; sets two headers, proxies /api/youtube locally
api/youtube.py               Vercel function: YouTube link -> streamed audio (yt-dlp)
static/app.js                input (file or link) -> decode -> worker -> player -> library
static/library.js            IndexedDB store for separated tracks
static/separate.worker.js    ONNX session, windowing, overlap-add
static/encode.worker.js      MP3 encoding (lamejs), one worker per stem
static/export.js             encoder pool, mixdown, zip building, file saving
static/player.js             Web Audio multitrack player
static/vendor/               onnxruntime-web, lamejs
```

Append `?ep=wasm` to force the WASM path instead of WebGPU.

## Limits

- **Memory.** Six stems of a 4-minute song is ~500 MB in the tab; the app warns past
  8 minutes. Very long tracks can crash it.
- **Quality.** The 6-stem model is less well trained than the 4-stem one it's derived
  from. Guitar is the reason to use it and also its weakest stem.
