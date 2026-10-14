/* Orchestration: file (or YouTube link) in, stems out, player wired up,
 * result saved to the library. Separation never leaves the browser; the only
 * server round-trip is fetching audio for a YouTube link. */

import { encodeMp3, encodeMp3Pcm, mixdown, makeZip, saveBlob, baseName } from '/export.js';
import { library, newId, decodeRecord, fmtBytes, fmtDuration, fmtDate } from '/library.js';

const SAMPLE_RATE = 44100;   // the model's rate; the AudioContext must match or
                             // decodeAudioData will resample to the device rate
const DISPLAY_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const LONG_TRACK_MINUTES = 8;
// 6 stems x 2 channels x 4 bytes x 44,100 samples = ~2.12 MB per second of audio.
const BYTES_PER_SECOND = 6 * 2 * 4 * SAMPLE_RATE;
const LIBRARY_BITRATE = 192;  // kbps per stem in storage; downloads stay at 320

const els = {
  uploadCard:  document.getElementById('upload-card'),
  dropzone:    document.getElementById('dropzone'),
  fileInput:   document.getElementById('file-input'),
  ytForm:      document.getElementById('yt-form'),
  ytUrl:       document.getElementById('yt-url'),
  ytGo:        document.getElementById('yt-go'),

  libraryCard: document.getElementById('library-card'),
  libraryList: document.getElementById('library-list'),
  libraryMeta: document.getElementById('library-meta'),

  progressCard:    document.getElementById('progress-card'),
  progressName:    document.getElementById('progress-name'),
  progressStage:   document.getElementById('progress-stage'),
  progressElapsed: document.getElementById('progress-elapsed'),
  barFill:         document.getElementById('bar-fill'),

  errorCard:    document.getElementById('error-card'),
  errorText:    document.getElementById('error-text'),
  errorDismiss: document.getElementById('error-dismiss'),

  playerCard:  document.getElementById('player-card'),
  playerName:  document.getElementById('player-name'),
  playerMeta:  document.getElementById('player-meta'),
  downloadAll: document.getElementById('download-all'),
  downloadMix: document.getElementById('download-mix'),
};

const player = new MultitrackPlayer(document.getElementById('stems'));
let current = null;    // { id, name, source, order, elapsed, provider, duration }
let busy = false;      // a separation or library load is in flight
let saving = null;     // status text while the library write runs

/* ---------- input: files ---------- */

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) run({ file: els.fileInput.files[0] });
});
for (const t of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add('drag'); });
}
for (const t of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.remove('drag'); });
}
els.dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) { run({ file: f }); return; }
  // A link dragged in from the browser bar arrives as text, not a file.
  const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
  if (text && looksLikeYouTube(text)) run({ youtube: text.trim() });
});
els.errorDismiss.addEventListener('click', () => {
  show(els.errorCard, false);
  show(els.uploadCard, true);
  showLibraryIfAny();
});

/* ---------- input: youtube ---------- */

els.ytForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = els.ytUrl.value.trim();
  if (url) run({ youtube: url });
});
// Pasting a link is the whole gesture; no need to also press the button.
els.ytUrl.addEventListener('paste', () => {
  setTimeout(() => {
    const url = els.ytUrl.value.trim();
    if (looksLikeYouTube(url)) run({ youtube: url });
  });
});

function looksLikeYouTube(s) {
  return /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com\/(watch|shorts|embed|live|v)|youtu\.be\/)/i.test(s.trim());
}

async function fetchYouTube(url, onProgress) {
  onProgress(0, 'asking YouTube');
  const res = await fetch(`/api/youtube?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    let msg = `YouTube fetch failed (${res.status}).`;
    if (res.status === 404 || res.status === 405) {
      msg = 'This copy of split has no YouTube endpoint. Run it with python3 serve.py ' +
            '(with yt-dlp installed) or deploy it to Vercel.';
    } else {
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* not json */ }
    }
    throw new Error(msg);
  }

  let title = 'YouTube audio';
  try { title = decodeURIComponent(res.headers.get('X-Title') || '') || title; } catch { /* keep default */ }
  const size = Number(res.headers.get('X-Size')) || 0;
  const duration = Number(res.headers.get('X-Duration')) || 0;
  const videoId = res.headers.get('X-Video-Id') || '';
  const type = res.headers.get('Content-Type') || 'audio/mp4';
  const ext = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'm4a';

  els.progressName.textContent = title;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(size ? Math.min(99, Math.round((got / size) * 100)) : 0,
               size ? `downloading ${fmtBytes(got)} of ${fmtBytes(size)}` : `downloading ${fmtBytes(got)}`);
  }
  if (!got) throw new Error('YouTube returned no audio for that link.');

  return {
    file: new File(parts, `${title}.${ext}`, { type }),
    name: title,
    source: { kind: 'youtube', url, videoId },
    duration,
  };
}

/* ---------- the job ---------- */

async function run(input) {
  if (busy) return;
  busy = true;
  player.destroy();
  current = null;
  show(els.playerCard, false);
  show(els.errorCard, false);
  show(els.uploadCard, false);
  show(els.libraryCard, false);
  show(els.progressCard, true);
  els.progressName.textContent = input.file ? input.file.name : 'YouTube';
  els.progressElapsed.textContent = '';
  setProgress(0, input.file ? 'reading audio' : 'connecting');
  els.fileInput.value = '';
  els.ytGo.disabled = true;

  const started = performance.now();
  const ticker = setInterval(() => {
    els.progressElapsed.textContent = `${Math.round((performance.now() - started) / 1000)}s`;
  }, 500);

  try {
    let file = input.file;
    let name = input.file?.name;
    let source = { kind: 'upload' };
    if (input.youtube) {
      const got = await fetchYouTube(input.youtube, setProgress);
      file = got.file; name = got.name; source = got.source;
      setProgress(0, 'reading audio');
    }

    // The browser's own decoder handles far more than the file extension suggests,
    // including video and streaming containers.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error('Could not decode this audio. It may be corrupt, or not contain audio.');
    } finally {
      ctx.close();
    }

    if (decoded.duration / 60 > LONG_TRACK_MINUTES) {
      const mins = (decoded.duration / 60).toFixed(1);
      const gb = (decoded.duration * BYTES_PER_SECOND / 1e9).toFixed(1);
      if (!confirm(`This track is ${mins} minutes. Holding six stems of it needs about ` +
                   `${gb} GB of memory, which may crash the tab. Continue?`)) {
        throw new Error('Cancelled.');
      }
    }

    const left = decoded.getChannelData(0).slice();
    const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1).slice() : left.slice();

    const result = await separate(left, right);

    current = {
      id: newId(),
      name,
      source,
      order: DISPLAY_ORDER.filter((n) => result.stems[n]),
      elapsed: result.elapsed,
      provider: result.provider,
      duration: decoded.duration,
    };

    player.load({ stems: result.stems, order: current.order, sampleRate: SAMPLE_RATE });
    player.onDownload = downloadStem;
    // The player now owns copies of the PCM; keeping ours as well would double
    // peak memory (~1.2 GB on a 5-minute track instead of ~0.6 GB).
    result.stems = null;

    showPlayer();
    saveToLibrary(current);   // in the background; the player is already live
  } catch (err) {
    fail(err.message || String(err));
  } finally {
    clearInterval(ticker);
    busy = false;
    els.ytGo.disabled = false;
    els.ytUrl.value = '';
  }
}

function separate(left, right) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/separate.worker.js');
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') setProgress(0, m.stage);
      else if (m.type === 'progress')
        setProgress(Math.round((m.done / m.total) * 100),
                    `separating on ${m.provider} · chunk ${m.done}/${m.total}`);
      else if (m.type === 'done') { worker.terminate(); resolve(m); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.error)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'worker failed')); };
    const forceEp = new URLSearchParams(location.search).get('ep');
    worker.postMessage({ left, right, forceEp }, [left.buffer, right.buffer]);
  });
}

function showPlayer() {
  els.playerName.textContent = current.name;
  setBusy(null);
  show(els.progressCard, false);
  show(els.playerCard, true);
  show(els.uploadCard, true);
  showLibraryIfAny();
}

/* ---------- library ---------- */

/* Encode the stems the player is holding and write them to IndexedDB. Runs
 * after the player is up, so the user is listening while this happens. */
async function saveToLibrary(track) {
  if (!library.available) return;
  const items = track.order.map((n) => ({
    name: n, buffer: player.tracks.find((t) => t.name === n).buffer,
  }));
  try {
    saving = 'saving to library…';
    setBusy(null);
    const results = await encodeMp3(items, (m) => {
      if (current?.id === track.id) { saving = `saving to library · ${m.overall}%`; setBusy(null); }
    }, { bitrate: LIBRARY_BITRATE });

    const stems = {};
    let bytes = 0;
    for (const r of results) {
      stems[r.name] = new Blob([r.bytes], { type: 'audio/mpeg' });
      bytes += r.bytes.length;
    }
    await library.put({
      id: track.id,
      name: track.name,
      source: track.source,
      createdAt: Date.now(),
      duration: track.duration,
      provider: track.provider,
      elapsed: track.elapsed,
      bytes,
      stems,
    });
    saving = null;
    if (current?.id === track.id) { setBusy('saved to library'); setTimeout(() => setBusy(null), 4000); }
    await renderLibrary();
  } catch (err) {
    saving = null;
    if (current?.id === track.id) { setBusy(`not saved: ${err.message}`); setTimeout(() => setBusy(null), 8000); }
  }
}

async function openFromLibrary(id) {
  if (busy) return;
  const record = await library.get(id);
  if (!record) { await renderLibrary(); return; }

  busy = true;
  player.destroy();
  current = null;
  show(els.playerCard, false);
  show(els.errorCard, false);
  show(els.progressCard, true);
  els.progressName.textContent = record.name;
  els.progressElapsed.textContent = '';
  setProgress(0, 'loading from library');

  try {
    const stems = await decodeRecord(record, SAMPLE_RATE, (name, i, n) => {
      setProgress(Math.round((i / n) * 100), `decoding ${name}`);
    });
    current = {
      id: record.id,
      name: record.name,
      source: record.source,
      order: DISPLAY_ORDER.filter((n) => stems[n]),
      elapsed: record.elapsed,
      provider: record.provider,
      duration: record.duration,
    };
    player.load({ stems, order: current.order, sampleRate: SAMPLE_RATE });
    player.onDownload = downloadStem;
    showPlayer();
  } catch (err) {
    fail(`Could not load that track from the library: ${err.message || err}`);
  } finally {
    busy = false;
  }
}

async function renderLibrary() {
  if (!library.available) return;
  let rows;
  try { rows = await library.list(); } catch { rows = []; }
  els.libraryList.innerHTML = '';
  if (!rows.length) { show(els.libraryCard, false); return; }

  let total = 0;
  for (const r of rows) {
    total += r.bytes || 0;
    const li = document.createElement('li');
    li.className = 'lib-item' + (current?.id === r.id ? ' current' : '');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.innerHTML = `
      <svg class="lib-icon" viewBox="0 0 24 24" aria-hidden="true">${
        r.source?.kind === 'youtube'
          ? '<path d="M10 15.5v-7l6 3.5-6 3.5zM21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.3 5 12 5 12 5s-6.3 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.7 19 12 19 12 19s6.3 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8z"/>'
          : '<path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>'
      }</svg>
      <span class="lib-text">
        <span class="lib-name"></span>
        <span class="lib-sub"></span>
      </span>
      <button class="lib-del" title="Remove from library" aria-label="Remove from library">×</button>`;
    li.querySelector('.lib-name').textContent = r.name;
    li.querySelector('.lib-sub').textContent =
      [fmtDuration(r.duration), fmtBytes(r.bytes), fmtDate(r.createdAt)].filter(Boolean).join(' · ');

    li.addEventListener('click', () => openFromLibrary(r.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFromLibrary(r.id); }
    });
    li.querySelector('.lib-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${r.name}" from the library?`)) return;
      await library.remove(r.id);
      if (current?.id === r.id) current.id = newId();   // keep the player; it's just no longer stored
      renderLibrary();
    });
    els.libraryList.appendChild(li);
  }

  const est = await library.estimate();
  els.libraryMeta.textContent = `${rows.length} ${rows.length === 1 ? 'track' : 'tracks'} · ${fmtBytes(total)}` +
    (est?.quota ? ` · ${fmtBytes(est.quota - (est.usage || 0))} free` : '');
  if (!busy && els.errorCard.classList.contains('hidden')) show(els.libraryCard, true);
}

function showLibraryIfAny() {
  if (els.libraryList.children.length) show(els.libraryCard, true);
}

/* ---------- downloads ---------- */

async function downloadStem(name, buffer) {
  setBusy(`encoding ${name}…`);
  try {
    const [out] = await encodeMp3([{ name, buffer }], (m) => setBusy(`encoding ${name} ${m.pct}%`));
    saveBlob(new Blob([out.bytes], { type: 'audio/mpeg' }),
             `${baseName(current.name)} - ${name}.mp3`);
  } finally {
    setBusy(null);
  }
}

/* Bounce the current balance -- volumes, mutes and solos exactly as they sound --
 * to a single MP3. */
els.downloadMix.addEventListener('click', async () => {
  if (!current) return;
  const btn = els.downloadMix;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const stems = player.currentMix();
    if (!stems.some((s) => s.gain > 0)) throw new Error('Everything is muted, so the mix would be silent.');

    btn.textContent = 'mixing…';
    await new Promise((r) => setTimeout(r));   // let the label paint before we block
    const { left, right, reduction } = mixdown(stems);

    const [out] = await encodeMp3Pcm('mix', left, right, SAMPLE_RATE,
      (m) => { btn.textContent = `encoding ${m.pct}%`; });

    saveBlob(new Blob([out.bytes], { type: 'audio/mpeg' }),
             `${baseName(current.name)} - mix.mp3`);
    // The balance itself is on screen in the sliders; only say what isn't.
    setBusy(reduction > 0.05
      ? `saved mix · turned down ${reduction.toFixed(1)} dB to avoid clipping`
      : 'saved mix');
    setTimeout(() => setBusy(null), 6000);
  } catch (err) {
    fail(err.message || String(err));
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

els.downloadAll.addEventListener('click', async () => {
  if (!current) return;
  const btn = els.downloadAll;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const items = current.order.map((n) => ({
      name: n, buffer: player.tracks.find((t) => t.name === n).buffer,
    }));
    const results = await encodeMp3(items, (m) => {
      btn.textContent = `encoding ${m.overall}%`;
    });
    btn.textContent = 'zipping…';
    const base = baseName(current.name);
    const zip = makeZip(results.map((r) => ({ name: `${base}/${r.name}.mp3`, bytes: r.bytes })));
    saveBlob(zip, `${base} - stems.zip`);
  } catch (err) {
    fail(err.message || String(err));
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

/* ---------- ui helpers ---------- */

function setProgress(pct, stage) {
  els.barFill.style.width = `${pct}%`;
  els.progressStage.textContent = stage;
}
function metaDefault() {
  if (!current) return '';
  const base = `${current.order.length} stems · ${current.provider} · ${current.elapsed}s`;
  return saving ? `${base} · ${saving}` : base;
}
function setBusy(text) {
  els.playerMeta.textContent = text || metaDefault();
}
function fail(message) {
  els.errorText.textContent = message;
  show(els.progressCard, false);
  show(els.errorCard, true);
  show(els.uploadCard, false);
  show(els.libraryCard, false);
}
function show(el, visible) { el.classList.toggle('hidden', !visible); }

/* ---------- storage ---------- */

// The cached model and the library are evictable by default. Asking for
// persistence makes the browser keep them.
navigator.storage?.persist?.().catch(() => {});
renderLibrary();

/* ---------- capability check ---------- */

if (!self.crossOriginIsolated) {
  fail('This page is not cross-origin isolated, so separation would be very slow. ' +
       'Serve it with python3 serve.py rather than opening the file directly.');
  show(els.uploadCard, false);
}
