/* Stem separation worker.
 *
 * Runs htdemucs_6s over the track in overlapping windows and reassembles the
 * result. Lives in a worker because a full song is a minute-plus of solid
 * compute -- on the main thread the page would simply freeze.
 *
 * The chunking here mirrors the reference implementation exactly. Getting the
 * window or the stride wrong does not throw, it just quietly degrades the
 * output, so treat these constants as fixed.
 */

importScripts('/vendor/ort/ort.all.min.js');

const MODEL_URL = '/models/htdemucs_6s_fp16.onnx';
// Used when this worker runs inside the extension, where /models/ is not a
// file. The extension service worker usually fills the cache first, because a
// cross-origin-isolated worker can be refused the Hugging Face response.
const MODEL_REMOTE = 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx';

// Channel order of the model's output. NOT alphabetical, and not the order the
// stems are displayed in -- verified by correlating against reference demucs.
const SOURCES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

const N = 343980;              // 7.8s at 44.1kHz: the model's fixed input length
const OVERLAP = N / 4;         // 85,995
const STRIDE = N - OVERLAP;    // 257,985

// ORT's defaults try to allocate more than the 32-bit wasm heap can hold and the
// session fails to create at all with std::bad_alloc. These three are required.
const SESSION_OPTS = {
  graphOptimizationLevel: 'disabled',
  enableMemPattern: false,
  enableCpuMemArena: false,
};

let session = null;
let provider = null;
let forceEp = null;

function fadeWindow() {
  const w = new Float32Array(N).fill(1);
  for (let i = 0; i < OVERLAP; i++) {
    const v = i / (OVERLAP - 1);
    w[i] = v;
    w[N - 1 - i] = v;
  }
  return w;
}

const MODEL_CACHE = 'split-model-v1';

/* Fetch the weights via the Cache API, not the HTTP cache.
 *
 * Chrome refuses to store a single resource larger than a fraction of its disk
 * cache, so a 130 MB model is silently re-downloaded on every page load no matter
 * what Cache-Control says. Cache Storage has no such per-entry limit. */
async function loadWeights(onStatus) {
  const cache = await caches.open(MODEL_CACHE);
  // The extension cannot cache a chrome-extension:// URL, so the remote https
  // URL is the key there. The site keeps the local path.
  const key = location.protocol === 'chrome-extension:' ? MODEL_REMOTE : MODEL_URL;
  const hit = await cache.match(key);
  if (hit) {
    onStatus('loading model (cached)');
    return new Uint8Array(await hit.arrayBuffer());
  }

  onStatus('downloading model (first run only)');
  const source = key;
  let res;
  try {
    res = await fetch(source);
  } catch (err) {
    const late = await cache.match(MODEL_URL);
    if (late) return new Uint8Array(await late.arrayBuffer());
    throw err;
  }
  if (!res.ok) {
    const late = await cache.match(MODEL_URL);
    if (late) return new Uint8Array(await late.arrayBuffer());
    throw new Error(`could not fetch the model (${res.status})`);
  }
  await cache.put(MODEL_URL, res.clone());

  // Read with progress: this is a 130 MB download and silence looks like a hang.
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onStatus(`downloading model ${Math.floor((got / total) * 100)}% (first run only)`);
  }
  const bytes = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return bytes;
}

async function getSession(onStatus) {
  if (session) return session;
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

  const weights = await loadWeights(onStatus);

  // forceEp comes from ?ep=wasm on the page, for debugging and for exercising the
  // fallback that Safari and Firefox will actually take.
  const eps = forceEp ? [forceEp] : (navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']);
  let lastErr;
  for (const ep of eps) {
    try {
      onStatus(`starting model (${ep})`);
      session = await ort.InferenceSession.create(
        weights, Object.assign({ executionProviders: [ep] }, SESSION_OPTS));
      provider = ep;
      return session;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not start the model: ${lastErr}`);
}

async function separate(left, right, onProgress, onStatus) {
  const total = left.length;
  await getSession(onStatus);

  const win = fadeWindow();
  const weight = new Float32Array(total);
  // One interleaved-by-channel buffer per source: [left, right].
  const out = SOURCES.map(() => [new Float32Array(total), new Float32Array(total)]);

  const input = new Float32Array(2 * N);
  const nChunks = Math.max(1, Math.ceil(total / STRIDE));

  for (let c = 0; c < nChunks; c++) {
    const start = c * STRIDE;
    const end = Math.min(start + N, total);
    const len = end - start;

    input.fill(0);
    input.set(left.subarray(start, end), 0);
    input.set(right.subarray(start, end), N);

    const res = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, N]) });
    const stems = res.stems.data;   // [source][channel][sample]

    for (let s = 0; s < SOURCES.length; s++) {
      for (let ch = 0; ch < 2; ch++) {
        const base = (s * 2 + ch) * N;
        const dst = out[s][ch];
        for (let i = 0; i < len; i++) dst[start + i] += stems[base + i] * win[i];
      }
    }
    for (let i = 0; i < len; i++) weight[start + i] += win[i];

    onProgress(c + 1, nChunks);
  }

  // Undo the window weighting. Overlapping regions were summed twice.
  for (let s = 0; s < SOURCES.length; s++) {
    for (let ch = 0; ch < 2; ch++) {
      const d = out[s][ch];
      for (let i = 0; i < total; i++) d[i] /= Math.max(weight[i], 1e-8);
    }
  }

  return out;
}

self.onmessage = async (e) => {
  const { left, right, forceEp: ep } = e.data;
  if (ep) forceEp = ep;
  const post = (m) => self.postMessage(m);
  try {
    const started = performance.now();
    const out = await separate(
      left, right,
      (done, totalChunks) => post({ type: 'progress', done, total: totalChunks, provider }),
      (stage) => post({ type: 'status', stage }),
    );
    const stems = {};
    const transfer = [];
    SOURCES.forEach((name, i) => {
      stems[name] = { left: out[i][0], right: out[i][1] };
      transfer.push(out[i][0].buffer, out[i][1].buffer);
    });
    post({
      type: 'done', stems, provider,
      elapsed: +((performance.now() - started) / 1000).toFixed(1),
    }, transfer);
  } catch (err) {
    post({ type: 'error', error: String(err && err.message || err) });
  }
};
