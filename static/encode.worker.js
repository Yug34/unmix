/* MP3 encoding worker.
 *
 * lamejs is pure JS and runs at roughly 10-20x realtime, so encoding six
 * five-minute stems is tens of seconds of solid work. Off the main thread it
 * goes, with progress, rather than freezing the page on a download click.
 */

importScripts('/vendor/lamejs.iife.js');

const BITRATE = 320;
const BLOCK = 1152;   // MP3 frame size; lamejs expects multiples of this

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeMp3(left, right, sampleRate, onProgress) {
  const enc = new lamejs.Mp3Encoder(2, sampleRate, BITRATE);
  const l = toInt16(left);
  const r = toInt16(right);
  const parts = [];
  let lastPct = -1;

  for (let i = 0; i < l.length; i += BLOCK) {
    const buf = enc.encodeBuffer(l.subarray(i, i + BLOCK), r.subarray(i, i + BLOCK));
    if (buf.length) parts.push(buf);
    const pct = Math.floor((i / l.length) * 100);
    if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
  }
  const end = enc.flush();
  if (end.length) parts.push(end);

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

self.onmessage = (e) => {
  const { jobs, sampleRate } = e.data;   // [{name, left, right}]
  try {
    const results = [];
    jobs.forEach((job, i) => {
      const bytes = encodeMp3(job.left, job.right, sampleRate, (pct) => {
        self.postMessage({ type: 'progress', name: job.name, pct, index: i, total: jobs.length });
      });
      results.push({ name: job.name, bytes });
    });
    self.postMessage({ type: 'done', results }, results.map((r) => r.bytes.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
