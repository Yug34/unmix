/* Orchestration: file in, stems out, player wired up. No server involved. */

import { encodeMp3, encodeMp3Pcm, mixdown, makeZip, saveBlob, baseName } from '/export.js';

const SAMPLE_RATE = 44100;   // the model's rate; the AudioContext must match or
                             // decodeAudioData will resample to the device rate
const DISPLAY_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const LONG_TRACK_MINUTES = 8;
// 6 stems x 2 channels x 4 bytes x 44,100 samples = ~2.12 MB per second of audio.
const BYTES_PER_SECOND = 6 * 2 * 4 * SAMPLE_RATE;

const els = {
  uploadCard:  document.getElementById('upload-card'),
  dropzone:    document.getElementById('dropzone'),
  fileInput:   document.getElementById('file-input'),

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
let current = null;   // { name, stems, order, elapsed, provider }

/* ---------- file selection ---------- */

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) run(els.fileInput.files[0]);
});
for (const t of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add('drag'); });
}
for (const t of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.remove('drag'); });
}
els.dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) run(f);
});
els.errorDismiss.addEventListener('click', () => { show(els.errorCard, false); show(els.uploadCard, true); });

/* ---------- the job ---------- */

async function run(file) {
  player.destroy();
  current = null;
  show(els.playerCard, false);
  show(els.errorCard, false);
  show(els.uploadCard, false);
  show(els.progressCard, true);
  els.progressName.textContent = file.name;
  els.progressElapsed.textContent = '';
  setProgress(0, 'reading audio');
  els.fileInput.value = '';

  const started = performance.now();
  const ticker = setInterval(() => {
    els.progressElapsed.textContent = `${Math.round((performance.now() - started) / 1000)}s`;
  }, 500);

  try {
    // The browser's own decoder handles far more than the file extension suggests,
    // including video and streaming containers.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error('Could not decode this file. It may be corrupt, or not contain audio.');
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
      name: file.name,
      stems: result.stems,
      order: DISPLAY_ORDER.filter((n) => result.stems[n]),
      elapsed: result.elapsed,
      provider: result.provider,
    };

    player.load({ stems: current.stems, order: current.order, sampleRate: SAMPLE_RATE });
    player.onDownload = downloadStem;
    // The player now owns copies of the PCM; keeping ours as well would double
    // peak memory (~1.2 GB on a 5-minute track instead of ~0.6 GB).
    current.stems = null;

    els.playerName.textContent = file.name;
    els.playerMeta.textContent =
      `${current.order.length} stems · ${current.provider} · ${current.elapsed}s`;
    show(els.progressCard, false);
    show(els.playerCard, true);
    show(els.uploadCard, true);
  } catch (err) {
    fail(err.message || String(err));
  } finally {
    clearInterval(ticker);
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
      btn.textContent = `encoding ${m.name} (${m.index + 1}/${m.total})`;
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
function setBusy(text) {
  els.playerMeta.textContent = text || (current
    ? `${current.order.length} stems · ${current.provider} · ${current.elapsed}s` : '');
}
function fail(message) {
  els.errorText.textContent = message;
  show(els.progressCard, false);
  show(els.errorCard, true);
  show(els.uploadCard, false);
}
function show(el, visible) { el.classList.toggle('hidden', !visible); }

/* ---------- storage ---------- */

// The cached 130 MB model is evictable by default. Asking for persistence makes
// the browser keep it, so the first-run download really is once.
navigator.storage?.persist?.().catch(() => {});

/* ---------- capability check ---------- */

if (!self.crossOriginIsolated) {
  fail('This page is not cross-origin isolated, so separation would be very slow. ' +
       'Serve it with python3 serve.py rather than opening the file directly.');
  show(els.uploadCard, false);
}
