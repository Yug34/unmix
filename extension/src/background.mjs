/* YouTube audio, fetched from this browser.
 *
 * The extension page is cross-origin isolated, so it cannot read googlevideo.com
 * itself. This service worker is not, and host_permissions let it fetch the
 * audio with the user's IP and cookies. Deciphering still needs new Function,
 * which only the sandboxed page may do: Platform.shim.eval asks that page. */

import { Innertube, Platform, UniversalCache } from 'youtubei.js/web';

/* Service workers throw "Illegal invocation" when fetch is called without
 * WorkerGlobalScope as this. youtubei.js stores the bare function. */
Platform.shim.fetch = globalThis.fetch.bind(globalThis);

const MAX_SECONDS = 20 * 60;
/* WEB and ANDROID answer "sign in to confirm you're not a bot" unless the
 * request carries a visitor id from a real watch page and looks like it came
 * from youtube.com. VISIONOS then returns a direct audio file. The origin
 * rewrite lives in rules.json: YouTube 403s chrome-extension:// origins. */
const CLIENTS = ['VISIONOS', 'TV', 'WEB_EMBEDDED'];
const MODEL_CACHE = 'split-model-v1';
const MODEL_REMOTE = 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx';

const AUDIO_ITAGS = new Set([
  '139', '140', '141', '171', '249', '250', '251', '256', '258', '327', '338',
]);

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

/* ---------- decipher bridge ---------- */

let evalSeq = 0;
const pendingEval = new Map();

Platform.shim.eval = (data) => new Promise((resolve, reject) => {
  const id = ++evalSeq;
  const timer = setTimeout(() => {
    pendingEval.delete(id);
    reject(new Error('Deciphering timed out. Reload the page and try again.'));
  }, 20000);
  pendingEval.set(id, { resolve, reject, timer });
  chrome.runtime.sendMessage({ type: 'yt-eval', id, output: data.output }).catch((err) => {
    clearTimeout(timer);
    pendingEval.delete(id);
    reject(err);
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'yt-eval-result') return;
  const pending = pendingEval.get(msg.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingEval.delete(msg.id);
  if (msg.error) pending.reject(new Error(msg.error));
  else pending.resolve(msg.result);
});

/* ---------- innertube ---------- */

let ytPromise = null;

function innertube() {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    }).catch((err) => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

function videoId(input) {
  let url = (input || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (!/^(m\.|music\.)?youtube\.com$/.test(host) && host !== 'youtube.com') return null;
  const fromPath = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  if (fromPath) return fromPath[1];
  const v = parsed.searchParams.get('v') || '';
  return /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
}

function pickFormat(info) {
  let last;
  // Chrome's decoder rejects YouTube's fragmented mp4 (ftyp "dash"). WebM does decode.
  for (const format of ['webm', 'mp4', 'any']) {
    try {
      return info.chooseFormat({ type: 'audio', quality: 'best', format });
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error('No audio stream found for that video.');
}

async function readVisitor(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`, {
    credentials: 'include',
  });
  if (!res.ok) return '';
  const html = await res.text();
  const match = html.match(/"visitorData":"([^"]+)"/);
  return match ? match[1] : '';
}

async function resolveAudio(url) {
  const id = videoId(url);
  if (!id) throw new Error("That doesn't look like a YouTube video link.");
  const visitor = await readVisitor(id);
  const yt = await innertube();
  if (visitor && yt.session?.context?.client) yt.session.context.client.visitorData = visitor;
  let last = 'YouTube returned no audio for that link.';

  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const basic = info.basic_info || {};
      if (basic.is_live) throw new Error("Live streams can't be separated.");
      const duration = basic.duration || 0;
      if (duration > MAX_SECONDS) {
        throw new Error(`That video is ${Math.round(duration / 60)} minutes long; the limit is ${MAX_SECONDS / 60}.`);
      }
      const format = pickFormat(info);
      let audioUrl = format.url || '';
      const rawN = audioUrl && new URL(audioUrl).searchParams.get('n');
      if (format.signature_cipher || format.cipher || rawN || !audioUrl) {
        try {
          const deciphered = await format.decipher(yt.session.player);
          if (deciphered) audioUrl = deciphered;
        } catch (err) {
          if (!audioUrl) throw err;
          console.error('decipher skipped', String(err && err.message || err).slice(0, 200));
        }
      }
      if (!audioUrl || !/^https?:\/\//.test(audioUrl)) throw new Error('empty audio url');
      if (new URL(audioUrl).searchParams.get('sabr') === '1') throw new Error('sabr');
      const mime = format.mime_type || 'audio/mp4';
      return {
        id,
        title: basic.title || id,
        duration,
        audioUrl,
        mime: mime.split(';')[0],
        size: format.content_length || 0,
      };
    } catch (err) {
      const message = String(err && err.message || err);
      console.error('client failed', client, message.slice(0, 300));
      if (/Live streams|minutes long|doesn't look like/.test(message)) throw err;
      last = message;
    }
  }
  throw new Error(last);
}

/* ---------- streaming ---------- */

function extOf(mime) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  return 'm4a';
}

async function streamTo(port, audioUrl, meta) {
  const res = await fetch(audioUrl, {
    credentials: 'include',
    headers: { Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com' },
  });
  if (!res.ok || !res.body) throw new Error(`Audio download failed (${res.status}).`);
  const size = Number(res.headers.get('content-length')) || meta.size || 0;
  const mime = (res.headers.get('content-type') || meta.mime || 'audio/mp4').split(';')[0];
  port.postMessage({
    type: 'meta',
    title: meta.title,
    duration: meta.duration,
    videoId: meta.id,
    mime,
    ext: extOf(mime),
    size,
  });
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    port.postMessage({
      type: 'progress',
      pct: size ? Math.min(99, Math.round((got / size) * 100)) : 0,
      stage: size ? `downloading ${fmtBytes(got)} of ${fmtBytes(size)}` : `downloading ${fmtBytes(got)}`,
    });
  }
  if (!got) throw new Error('YouTube returned no audio for that link.');
  const body = new Uint8Array(got);
  let off = 0;
  for (const part of parts) { body.set(part, off); off += part.byteLength; }
  // A port will not carry the bytes: transferred buffers arrive empty, and a
  // cloned ArrayBuffer is dropped. The page and this worker share Cache Storage.
  const key = `https://example.invalid/split/youtube/${meta.id}`;
  const cache = await caches.open('split-youtube-v1');
  await cache.put(key, new Response(body, {
    headers: { 'Content-Type': mime, 'Content-Length': String(got) },
  }));
  port.postMessage({ type: 'file', key });
}

function fmtBytes(n) {
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/* A muted background tab lets YouTube's own player mint the request, and
 * webRequest records the audio URL. Used when InnerTube cannot. SABR players
 * never request a whole file, so this can time out. */
function captureFromTab(videoId) {
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  return new Promise((resolve, reject) => {
    let tabId = null;
    let settled = false;
    const finish = (err, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.webRequest.onBeforeRequest.removeListener(onBefore);
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
      if (err) reject(err);
      else resolve(url);
    };
    const timer = setTimeout(() => {
      finish(new Error('YouTube did not request a whole audio file. Try again, or drop the file in instead.'));
    }, 25000);
    const onBefore = (details) => {
      if (details.tabId !== tabId) return;
      let parsed;
      try { parsed = new URL(details.url); } catch { return; }
      const mime = parsed.searchParams.get('mime') || '';
      const itag = parsed.searchParams.get('itag') || '';
      if (!mime.startsWith('audio/') && !AUDIO_ITAGS.has(itag)) return;
      finish(null, details.url);
    };
    chrome.webRequest.onBeforeRequest.addListener(onBefore, {
      urls: ['https://*.googlevideo.com/videoplayback*'],
    });
    chrome.tabs.create({ url: watch, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        finish(new Error(chrome.runtime.lastError?.message || 'Could not open YouTube.'));
        return;
      }
      tabId = tab.id;
      chrome.tabs.update(tabId, { muted: true }).catch(() => {});
    });
  });
}

function handleYouTube(port) {
  let started = false;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'start' || started) return;
    started = true;
    const sendErr = (error) => {
      try { port.postMessage({ type: 'error', error: String(error && error.message || error) }); } catch { /* port gone */ }
    };
    try {
      port.postMessage({ type: 'progress', pct: 0, stage: 'asking YouTube' });
      let meta;
      try {
        meta = await resolveAudio(msg.url);
      } catch (err) {
        const message = String(err && err.message || err);
        console.error('innertube failed:', err);
        if (/Live streams|minutes long|doesn't look like/.test(message)) throw err;
        const id = videoId(msg.url);
        if (!id) throw err;
        port.postMessage({ type: 'progress', pct: 0, stage: 'opening YouTube' });
        const audioUrl = await captureFromTab(id);
        let title = id;
        try {
          const oembed = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
          if (oembed.ok) title = (await oembed.json()).title || id;
        } catch { /* the id is a fine label */ }
        meta = { id, title, duration: 0, audioUrl, mime: 'audio/mp4', size: 0 };
      }
      await streamTo(port, meta.audioUrl, meta);
    } catch (err) {
      sendErr(err);
    }
  });
}

/* ---------- model ---------- */

async function ensureModel(port) {
  const cache = await caches.open(MODEL_CACHE);
  // Cache Storage refuses chrome-extension:// keys, so the https URL is the key
  // the worker looks up too.
  const key = MODEL_REMOTE;
  if (await cache.match(key)) {
    port.postMessage({ type: 'done' });
    return;
  }
  const res = await fetch(MODEL_REMOTE);
  if (!res.ok || !res.body) throw new Error(`could not fetch the model (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    port.postMessage({
      type: 'progress',
      pct: total ? Math.round((got / total) * 100) : 0,
      stage: total
        ? `downloading model ${Math.round((got / total) * 100)}% (first run only)`
        : 'downloading model (first run only)',
    });
  }
  const body = new Uint8Array(got);
  let off = 0;
  for (const part of parts) { body.set(part, off); off += part.byteLength; }
  await cache.put(key, new Response(body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(got) },
  }));
  port.postMessage({ type: 'done' });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'youtube') handleYouTube(port);
  else if (port.name === 'model') {
    port.onMessage.addListener(async (msg) => {
      if (msg?.type !== 'ensure') return;
      try {
        await ensureModel(port);
      } catch (err) {
        try { port.postMessage({ type: 'error', error: String(err && err.message || err) }); } catch { /* port gone */ }
      }
    });
  }
});
