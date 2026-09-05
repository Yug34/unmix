/* Multitrack player.
 *
 * Every stem is decoded into an AudioBuffer and played through its own
 * AudioBufferSourceNode -> GainNode. All sources are started with the same
 * `when` and `offset`, which is what keeps them sample-accurately in sync --
 * six independent <audio> elements would drift.
 *
 * AudioBufferSourceNodes are one-shot, so pause and seek both mean "stop
 * everything, remember the offset, build new sources on the next play".
 */

const STEM_COLORS = {
  vocals: '#6ea8fe',
  drums:  '#ff8fa3',
  bass:   '#9d8cff',
  guitar: '#5fd6a4',
  piano:  '#ffd166',
  other:  '#8d97a8',
};

class MultitrackPlayer {
  constructor(root) {
    this.root = root;
    this.ctx = null;
    this.tracks = [];       // { name, buffer, gain, source, peaks, canvas, dim, lit, row }
    this.duration = 0;
    this.playing = false;
    this.offset = 0;        // playback position captured at the last stop
    this.startedAt = 0;     // ctx.currentTime when the current sources started
    this.muted = new Set();
    this.soloed = new Set();
    this.raf = null;

    this.playBtn = document.getElementById('play-btn');
    this.scrub = document.getElementById('scrub');
    this.scrubFill = document.getElementById('scrub-fill');
    this.timeEl = document.getElementById('time');

    this.playBtn.addEventListener('click', () => this.toggle());
    this.scrub.addEventListener('click', (e) => {
      const r = this.scrub.getBoundingClientRect();
      this.seek(((e.clientX - r.left) / r.width) * this.duration);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.tracks.length && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /* ---------- loading ---------- */

  /* `stems` is {name: {left: Float32Array, right: Float32Array}} straight from the
   * worker -- already PCM, so there is nothing to fetch and nothing to decode. */
  load({ stems, order, sampleRate }) {
    this.destroy();
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });

    for (const name of order) {
      const pcm = stems[name];
      if (!pcm) continue;

      const buffer = this.ctx.createBuffer(2, pcm.left.length, sampleRate);
      buffer.copyToChannel(pcm.left, 0);
      buffer.copyToChannel(pcm.right, 1);

      const gain = this.ctx.createGain();
      gain.connect(this.ctx.destination);

      const track = { name, buffer, gain, source: null, volume: 1, peaks: null };
      track.row = this.buildRow(track);
      this.tracks.push(track);
      this.duration = Math.max(this.duration, buffer.duration);
      this.observe(track);
    }

    this.offset = 0;
    this.applyGains();
    this.tick();
  }

  buildRow(track) {
    const row = document.createElement('div');
    row.className = 'stem';

    const name = document.createElement('span');
    name.className = 'stem-name';
    name.textContent = track.name;

    const mute = document.createElement('button');
    mute.className = 'toggle mute';
    mute.textContent = 'M';
    mute.title = `Mute ${track.name}`;
    mute.setAttribute('aria-label', `Mute ${track.name}`);
    mute.addEventListener('click', () => {
      this.muted.has(track.name) ? this.muted.delete(track.name) : this.muted.add(track.name);
      this.applyGains();
    });

    const solo = document.createElement('button');
    solo.className = 'toggle solo';
    solo.textContent = 'S';
    solo.title = `Solo ${track.name}`;
    solo.setAttribute('aria-label', `Solo ${track.name}`);
    solo.addEventListener('click', () => {
      this.soloed.has(track.name) ? this.soloed.delete(track.name) : this.soloed.add(track.name);
      this.applyGains();
    });

    const canvas = document.createElement('canvas');
    canvas.className = 'wave';
    track.canvas = canvas;
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      this.seek(((e.clientX - r.left) / r.width) * this.duration);
    });

    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'vol';
    vol.min = 0; vol.max = 1.5; vol.step = 0.01; vol.value = 1;
    vol.title = `${track.name} volume`;
    vol.setAttribute('aria-label', `${track.name} volume`);
    const pct = document.createElement('span');
    pct.className = 'vol-pct';
    pct.textContent = '100%';

    vol.addEventListener('input', () => {
      track.volume = parseFloat(vol.value);
      pct.textContent = `${Math.round(track.volume * 100)}%`;
      this.applyGains();
    });
    track.pctEl = pct;

    const dl = document.createElement('button');
    dl.className = 'btn ghost';
    dl.textContent = '↓';
    dl.title = `Download ${track.name}`;
    dl.addEventListener('click', async () => {
      if (!this.onDownload) return;
      const label = dl.textContent;
      dl.textContent = '…';
      dl.disabled = true;
      try { await this.onDownload(track.name, track.buffer); }
      finally { dl.textContent = label; dl.disabled = false; }
    });

    const toggles = document.createElement('span');
    toggles.append(mute, solo);
    toggles.style.display = 'flex';
    toggles.style.gap = '4px';

    const volWrap = document.createElement('span');
    volWrap.className = 'vol-wrap';
    volWrap.append(vol, pct);

    row.append(name, toggles, canvas, volWrap, dl);
    this.root.appendChild(row);
    track.muteBtn = mute;
    track.soloBtn = solo;
    return row;
  }

  /* ---------- waveforms ---------- */

  observe(track) {
    // The player card is display:none while stems load, so the canvas has no size
    // yet. Render on the first resize that gives it real dimensions, and on every
    // later one, rather than guessing when layout has settled.
    const ro = new ResizeObserver(() => {
      const w = Math.floor(track.canvas.clientWidth);
      const h = Math.floor(track.canvas.clientHeight);
      if (w < 2 || h < 2 || (w === track.renderedW && h === track.renderedH)) return;
      this.renderWave(track);
    });
    ro.observe(track.canvas);
    track.observer = ro;
  }

  renderWave(track) {
    const canvas = track.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.clientWidth));
    const h = Math.max(1, Math.floor(canvas.clientHeight));
    track.renderedW = w;
    track.renderedH = h;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    track.peaks = computePeaks(track.buffer, w);

    // Pre-render the waveform twice, dim and lit. Each frame then only needs two
    // drawImage calls per stem to show the played/unplayed split.
    track.dim = paintWave(track.peaks, w, h, dpr, '#3a4150');
    track.lit = paintWave(track.peaks, w, h, dpr, STEM_COLORS[track.name] || '#6ea8fe');
    track.lastPx = -1;
    this.paintTrack(track, this.position());
  }

  paintTrack(track, pos) {
    if (!track.dim) return;
    const canvas = track.canvas;
    const px = Math.round((this.duration ? pos / this.duration : 0) * canvas.width);
    if (px === track.lastPx) return;
    track.lastPx = px;

    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (px > 0) g.drawImage(track.lit, 0, 0, px, canvas.height, 0, 0, px, canvas.height);
    if (px < canvas.width) {
      const rest = canvas.width - px;
      g.drawImage(track.dim, px, 0, rest, canvas.height, px, 0, rest, canvas.height);
    }
  }

  /* ---------- gain ---------- */

  applyGains() {
    const soloing = this.soloed.size > 0;
    for (const t of this.tracks) {
      const audible = soloing ? this.soloed.has(t.name) : !this.muted.has(t.name);
      // Short ramp instead of a step, so toggling mid-playback doesn't click.
      t.gain.gain.setTargetAtTime(audible ? t.volume : 0, this.ctx.currentTime, 0.01);
      t.muteBtn.classList.toggle('on', this.muted.has(t.name));
      t.soloBtn.classList.toggle('on', this.soloed.has(t.name));
      t.row.classList.toggle('muted', !audible);
      if (t.pctEl) t.pctEl.textContent = audible ? `${Math.round(t.volume * 100)}%` : '0%';
    }
  }

  /** The gain each stem is actually contributing right now, mute and solo included.
   *  This is the contract for "download what I'm hearing". */
  currentMix() {
    const soloing = this.soloed.size > 0;
    return this.tracks.map((t) => {
      const audible = soloing ? this.soloed.has(t.name) : !this.muted.has(t.name);
      return { name: t.name, buffer: t.buffer, gain: audible ? t.volume : 0 };
    });
  }

  /* ---------- transport ---------- */

  position() {
    if (!this.playing) return this.offset;
    return Math.min(this.offset + (this.ctx.currentTime - this.startedAt), this.duration);
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  async play() {
    if (!this.tracks.length || this.playing) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;

    const when = this.ctx.currentTime + 0.08;  // small lead so every source starts together
    for (const t of this.tracks) {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      src.start(when, Math.min(this.offset, t.buffer.duration));
      t.source = src;
    }
    this.startedAt = when;
    this.playing = true;
    this.setPlayIcon(true);
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.stopSources();
    this.playing = false;
    this.setPlayIcon(false);
  }

  seek(seconds) {
    const pos = Math.max(0, Math.min(seconds, this.duration));
    if (this.playing) {
      this.stopSources();
      this.offset = pos;
      this.playing = false;
      this.play();
    } else {
      this.offset = pos;
      this.render(pos);
    }
  }

  stopSources() {
    for (const t of this.tracks) {
      if (t.source) {
        try { t.source.stop(); } catch { /* already stopped */ }
        t.source.disconnect();
        t.source = null;
      }
    }
  }

  setPlayIcon(playing) {
    this.playBtn.querySelector('.icon-play').classList.toggle('hidden', playing);
    this.playBtn.querySelector('.icon-pause').classList.toggle('hidden', !playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  tick() {
    const step = () => {
      const pos = this.position();
      // Sources end on their own at the buffer end; catch up and reset.
      if (this.playing && pos >= this.duration - 0.02) {
        this.pause();
        this.offset = 0;
        this.render(0);
      } else {
        this.render(pos);
      }
      this.raf = requestAnimationFrame(step);
    };
    step();
  }

  render(pos) {
    const pct = this.duration ? (pos / this.duration) * 100 : 0;
    this.scrubFill.style.width = `${pct}%`;
    this.timeEl.textContent = `${fmt(pos)} / ${fmt(this.duration)}`;
    for (const t of this.tracks) this.paintTrack(t, pos);
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.stopSources();
    for (const t of this.tracks) t.observer?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.tracks = [];
    this.duration = 0;
    this.offset = 0;
    this.playing = false;
    this.muted.clear();
    this.soloed.clear();
    this.root.innerHTML = '';
    this.setPlayIcon(false);
  }
}

/* ---------- helpers ---------- */

function computePeaks(buffer, width) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const step = buffer.length / width;
  const peaks = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(Math.floor((i + 1) * step), buffer.length);
    let peak = 0;
    // Stride large windows; sample accuracy is invisible at one pixel wide.
    const stride = Math.max(1, Math.floor((end - start) / 400));
    for (const data of chans) {
      for (let j = start; j < end; j += stride) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > peak) peak = v;
      }
    }
    peaks[i] = peak;
  }
  return peaks;
}

function paintWave(peaks, w, h, dpr, color) {
  const c = document.createElement('canvas');
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = color;
  const mid = h / 2;
  for (let i = 0; i < w; i++) {
    const amp = Math.max(1, peaks[i] * (h - 2));
    g.fillRect(i, mid - amp / 2, 1, amp);
  }
  return c;
}

function fmt(seconds) {
  if (!isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds % 60);
  return `${Math.floor(seconds / 60)}:${String(s).padStart(2, '0')}`;
}
