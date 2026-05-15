// ============================================================================
// utils.js — utility matematiche e DOM per Motion Sense Lab.
// Tutte le funzioni qui sono pure o stateful "leggere"; nessuna dipendenza esterna.
// ============================================================================

// ---------------------------------------------------------------------------
// Ring buffer (FIFO a capacità fissa). Utile per i grafici live degli ultimi
// N campioni e per il calcolo di metriche su finestra mobile (media, std, FFT).
// ---------------------------------------------------------------------------
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
    this.size = 0;
    this.head = 0; // prossimo slot di scrittura
  }
  push(v) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }
  // Restituisce array in ordine cronologico (più vecchio → più recente).
  toArray() {
    const out = new Float32Array(this.size);
    if (this.size < this.capacity) {
      for (let i = 0; i < this.size; i++) out[i] = this.data[i];
    } else {
      let idx = this.head;
      for (let i = 0; i < this.size; i++) {
        out[i] = this.data[idx];
        idx = (idx + 1) % this.capacity;
      }
    }
    return out;
  }
  last(n = 1) {
    const arr = this.toArray();
    return arr.slice(Math.max(0, arr.length - n));
  }
  clear() { this.size = 0; this.head = 0; }
  mean() {
    if (this.size === 0) return 0;
    const a = this.toArray();
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  std() {
    if (this.size < 2) return 0;
    const a = this.toArray();
    const m = this.mean();
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / a.length);
  }
}

// ---------------------------------------------------------------------------
// Filtri IIR del primo ordine. Per un passa-banda colleghiamo in cascata
// un high-pass (rimuove DC/derive lente) e un low-pass (rimuove rumore alto).
//
// Modello high-pass (RC):  y[n] = α (y[n-1] + x[n] - x[n-1])
//   con α = RC / (RC + dt) ,  RC = 1/(2π fc)
//
// Modello low-pass (RC):   y[n] = α x[n] + (1-α) y[n-1]
//   con α = dt / (RC + dt)
//
// dt è il passo di campionamento medio. Per sensori a frequenza variabile
// (DeviceMotion ~50–60 Hz, video ~30 fps) ricalcoliamo α a ogni campione.
// ---------------------------------------------------------------------------
export class HighPass {
  constructor(cutoffHz) {
    this.fc = cutoffHz;
    this.yPrev = 0;
    this.xPrev = 0;
    this.initialized = false;
  }
  step(x, dt) {
    if (dt <= 0) return this.yPrev;
    const RC = 1 / (2 * Math.PI * this.fc);
    const alpha = RC / (RC + dt);
    if (!this.initialized) {
      this.xPrev = x; this.yPrev = 0; this.initialized = true;
      return 0;
    }
    const y = alpha * (this.yPrev + x - this.xPrev);
    this.xPrev = x; this.yPrev = y;
    return y;
  }
  reset() { this.yPrev = 0; this.xPrev = 0; this.initialized = false; }
}

export class LowPass {
  constructor(cutoffHz) {
    this.fc = cutoffHz;
    this.y = 0;
    this.initialized = false;
  }
  step(x, dt) {
    if (dt <= 0) return this.y;
    const RC = 1 / (2 * Math.PI * this.fc);
    const alpha = dt / (RC + dt);
    if (!this.initialized) { this.y = x; this.initialized = true; return x; }
    this.y = this.y + alpha * (x - this.y);
    return this.y;
  }
  reset() { this.y = 0; this.initialized = false; }
}

// Passa-banda = HP seguito da LP, oppure due IIR del 2° ordine (qui basta il
// primo ordine: bastevole per PPG e respiro nella loro banda di interesse).
export class BandPass {
  constructor(lowHz, highHz) {
    this.hp = new HighPass(lowHz);
    this.lp = new LowPass(highHz);
  }
  step(x, dt) {
    return this.lp.step(this.hp.step(x, dt), dt);
  }
  reset() { this.hp.reset(); this.lp.reset(); }
}

// ---------------------------------------------------------------------------
// Peak detector "robusto" su segnale filtrato.
//   - Rileva un picco quando il valore corrente è un massimo locale
//     superiore a una soglia adattativa (es. media + k * std finestrata)
//     e quando dall'ultimo picco è passato almeno `minIntervalMs`.
//   - minIntervalMs serve a evitare doppi conteggi (refrattarietà):
//       60 bpm → 1000 ms, 240 bpm → 250 ms → per PPG usiamo ~250 ms.
//   - L'output è { isPeak, intervalMs } da consumare al chiamante.
// ---------------------------------------------------------------------------
export class PeakDetector {
  constructor({ minIntervalMs = 250, k = 0.6 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.k = k;
    this.lastPeakTs = 0;
    this.prevValue = -Infinity;
    this.prevPrev = -Infinity;
    this.window = new RingBuffer(64);
  }
  step(value, ts) {
    this.window.push(value);
    const mean = this.window.mean();
    const std = this.window.std();
    const threshold = mean + this.k * std;

    let isPeak = false;
    let intervalMs = 0;

    // Massimo locale: il campione precedente è maggiore di quello prima e di
    // quello dopo (i.e. value, che ora è "il dopo"). Quindi controlliamo
    // se prevValue > prevPrev && prevValue > value e prevValue > threshold.
    if (
      this.prevValue > this.prevPrev &&
      this.prevValue > value &&
      this.prevValue > threshold
    ) {
      const dt = ts - this.lastPeakTs;
      if (dt >= this.minIntervalMs) {
        isPeak = true;
        intervalMs = this.lastPeakTs === 0 ? 0 : dt;
        this.lastPeakTs = ts;
      }
    }
    this.prevPrev = this.prevValue;
    this.prevValue = value;
    return { isPeak, intervalMs };
  }
  reset() {
    this.lastPeakTs = 0;
    this.prevValue = -Infinity;
    this.prevPrev = -Infinity;
    this.window.clear();
  }
}

// ---------------------------------------------------------------------------
// Stima della frequenza da intervalli (inter-beat / inter-step / inter-breath)
// con mediana mobile per essere robusta a outlier.
// ---------------------------------------------------------------------------
export class RateEstimator {
  constructor(windowSize = 8) {
    this.windowSize = windowSize;
    this.intervals = [];
  }
  push(intervalMs) {
    if (intervalMs <= 0) return;
    this.intervals.push(intervalMs);
    if (this.intervals.length > this.windowSize) this.intervals.shift();
  }
  // Restituisce eventi/minuto (60_000 / mediana intervalli in ms).
  perMinute() {
    if (this.intervals.length === 0) return 0;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) return 0;
    return 60000 / median;
  }
  reset() { this.intervals = []; }
}

// ---------------------------------------------------------------------------
// Helper DOM minimi (niente framework).
// ---------------------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function lerp(a, b, t) { return a + (b - a) * t; }

// Formattatori sicuri (gestiscono undefined/NaN/Infinity).
export function fmt(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

// Vibrazione: API non supportata su iOS Safari, ma su Android sì. Wrappiamo
// per evitare crash e per fornire un fallback silenzioso.
export function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch { /* ignora */ }
}

// Toast effimero (es. avviso caduta rilevata).
let toastTimer = null;
export function toast(msg, ms = 2500) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', { class: 'toast', role: 'status', 'aria-live': 'assertive' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Disegno di una traccia su canvas (asse X tempo, Y valore mappato a [0,1]).
// Usato dai moduli movimento/respiro/PPG per la visualizzazione live.
export function drawTrace(canvas, data, { color = '#5ad1ff', min, max, grid = true } = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (grid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (cssH / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
    }
  }

  if (!data || data.length < 2) return;

  let lo = min, hi = max;
  if (lo == null || hi == null) {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    if (lo === hi) { lo -= 1; hi += 1; }
  }
  const range = hi - lo;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * cssW;
    const y = cssH - ((data[i] - lo) / range) * cssH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Stato globale per sapere se l'utente ha già toccato la pagina (necessario
// per audio context su Safari e per requestPermission DeviceMotion su iOS).
let userGestureSeen = false;
export function markGesture() { userGestureSeen = true; }
export function hasGesture() { return userGestureSeen; }
document.addEventListener('touchstart', markGesture, { once: true, passive: true });
document.addEventListener('click', markGesture, { once: true, passive: true });
