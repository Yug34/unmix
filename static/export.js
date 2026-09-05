/* Turning stems into files: MP3 encoding (in a worker) and a minimal zip. */

const ENCODER = { worker: null, queue: null };

function encoder() {
  if (!ENCODER.worker) {
    ENCODER.worker = new Worker('/encode.worker.js');
    ENCODER.worker.onmessage = (e) => {
      const m = e.data;
      if (!ENCODER.queue) return;
      if (m.type === 'progress') ENCODER.queue.onProgress?.(m);
      else if (m.type === 'done') { const q = ENCODER.queue; ENCODER.queue = null; q.resolve(m.results); }
      else if (m.type === 'error') { const q = ENCODER.queue; ENCODER.queue = null; q.reject(new Error(m.error)); }
    };
  }
  return ENCODER.worker;
}

/** Encode AudioBuffers to MP3. `items` is [{name, buffer}]. */
export function encodeMp3(items, onProgress) {
  const w = encoder();
  return new Promise((resolve, reject) => {
    if (ENCODER.queue) return reject(new Error('an export is already running'));
    ENCODER.queue = { resolve, reject, onProgress };
    // Copy the channel data: the worker takes ownership of what it is sent, and
    // the player still needs its buffers afterwards.
    const jobs = items.map(({ name, buffer }) => ({
      name,
      left: buffer.getChannelData(0).slice(),
      right: buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice()
                                         : buffer.getChannelData(0).slice(),
    }));
    const transfer = jobs.flatMap((j) => [j.left.buffer, j.right.buffer]);
    w.postMessage({ jobs, sampleRate: items[0].buffer.sampleRate }, transfer);
  });
}

/* ---------- mixdown ---------- */

/** Sum stems at the given gains into one stereo pair.
 *
 * `stems` is [{buffer, gain}]. Returns {left, right, peak, reduction} where
 * `reduction` is the dB of headroom applied, if any: boosting several stems at
 * once easily sums past full scale, and hard clipping sounds like distortion
 * rather than a loud mix. Scaling everything by one factor keeps the balance the
 * user set while getting the peak back under 0 dBFS.
 */
export function mixdown(stems) {
  const active = stems.filter((s) => s.gain > 0);
  const length = active.reduce((n, s) => Math.max(n, s.buffer.length), 0);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  for (const { buffer, gain } of active) {
    const l = buffer.getChannelData(0);
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    for (let i = 0; i < l.length; i++) {
      left[i] += l[i] * gain;
      right[i] += r[i] * gain;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = left[i] < 0 ? -left[i] : left[i];
    const b = right[i] < 0 ? -right[i] : right[i];
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }

  // Ceiling sits a little under full scale rather than at it: lossy encoding
  // reconstructs peaks slightly higher than the PCM it was given, so normalising
  // to 0.999 still comes back over 1.0 and clips on integer output paths.
  const CEILING = 0.97;   // about -0.26 dBFS
  let reduction = 0;
  if (peak > CEILING) {
    const scale = CEILING / peak;
    for (let i = 0; i < length; i++) { left[i] *= scale; right[i] *= scale; }
    reduction = -20 * Math.log10(scale);
  }

  return { left, right, peak, reduction };
}

/** Encode raw stereo PCM (rather than an AudioBuffer) to MP3. */
export function encodeMp3Pcm(name, left, right, sampleRate, onProgress) {
  const w = encoder();
  return new Promise((resolve, reject) => {
    if (ENCODER.queue) return reject(new Error('an export is already running'));
    ENCODER.queue = { resolve, reject, onProgress };
    w.postMessage({ jobs: [{ name, left, right }], sampleRate }, [left.buffer, right.buffer]);
  });
}

/* ---------- zip (store only) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a zip from [{name, bytes}]. Stored, not deflated -- MP3 will not compress. */
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0, true);           // flags
    local.setUint16(8, 0, true);           // method: store
    local.setUint16(10, 0, true);          // time
    local.setUint16(12, 0, true);          // date
    local.setUint32(14, crc, true);
    local.setUint32(18, f.bytes.length, true);
    local.setUint32(22, f.bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, f.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.bytes.length, true);
    cd.setUint32(24, f.bytes.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + f.bytes.length;
  }

  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
                  { type: 'application/zip' });
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Filename-safe version of the uploaded track's name. */
export function baseName(filename) {
  const stem = String(filename).replace(/\.[^.]+$/, '');
  return [...stem].filter((c) => /[\w \-()[\].]/.test(c)).join('').trim() || 'track';
}
