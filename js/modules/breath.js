// ============================================================================
// breath.js — Modulo "Respiro".
//
// Principio: con il telefono sul petto (schermo verso l'alto), l'espansione
// toracica modula leggermente l'accelerazione lungo l'asse Z dell'IMU.
// L'oscillazione è MOLTO lenta (6–30 atti/minuto → 0.1–0.5 Hz) ed è
// dominata dal rumore di alta frequenza e dalla gravità (≈ 9.81 sull'asse Z
// quando il dispositivo è orizzontale).
//
// Pipeline:
//   1) accelerationIncludingGravity.z (m/s²) come input grezzo
//   2) passa-banda 0.1–0.5 Hz → rimuove gravità (≈DC) e rumore alto
//   3) peak detector con refrattarietà 1500 ms (max ~40 atti/min)
//   4) RateEstimator → atti/minuto stabile
//
// SNR (indicatore qualità):
//   ratio = std(segnale filtrato in banda) / std(segnale grezzo high-pass)
//   - elevato → respiro pulito, telefono fermo
//   - basso → rumore di movimento o telefono non sul petto
// ============================================================================

import { el, RingBuffer, BandPass, PeakDetector, RateEstimator, fmt, drawTrace } from '../utils.js';
import { requestMotionPermission } from '../permissions.js';
import { setMetric } from '../store.js';

const WINDOW_S = 30;
const SAMPLE_HZ = 50;

export function mount(container) {
  let active = false;
  let handler = null;
  let rafId = null;
  let lastTs = 0;

  // Passa-banda della banda respiratoria: 0.1 Hz (6 atti/min) – 0.5 Hz (30 atti/min).
  const bp = new BandPass(0.1, 0.5);
  // Refrattarietà 1500 ms ≈ massimo 40 atti/min, sufficiente per uso umano.
  const peaks = new PeakDetector({ minIntervalMs: 1500, k: 0.5 });
  const rate = new RateEstimator(6);

  const filtBuf = new RingBuffer(SAMPLE_HZ * WINDOW_S);
  const rawBuf  = new RingBuffer(SAMPLE_HZ * WINDOW_S);

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Frequenza respiratoria'),
    el('p', {}, "Sdraiati supino e appoggia il telefono sul petto, schermo verso l'alto. Resta fermo per circa 30 secondi: il leggero movimento toracico modula l'accelerazione Z."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Misurazione indicativa. '),
      "La qualità dipende molto da quanto resti immobile. Movimenti, parlato e ambiente in moto rovinano il segnale."
    ),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva sensore');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'),    el('dd', { id: 'bStatus' }, '—'),
      el('dt', {}, 'Qualità'),  el('dd', { id: 'bQual' },   '—'),
    ),
  );

  const valueCard = el('div', { class: 'card', style: 'text-align:center' },
    el('h3', {}, 'Frequenza respiratoria stimata'),
    el('div', { class: 'metric', style: 'justify-content:center' },
      el('span', { id: 'bRate' }, '—'),
      el('span', { class: 'unit' }, 'atti/min'),
    ),
  );

  const canvas = el('canvas', { height: 140 });
  const graphCard = el('div', { class: 'card' },
    el('h3', {}, 'Onda respiratoria (filtrata)'),
    canvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, "Ogni picco è un'inspirazione (espansione toracica → accelerazione Z verso l'alto)."),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(valueCard);
  container.appendChild(graphCard);

  // ---- helpers ----
  function setText(sel, txt) {
    const n = container.querySelector(sel);
    if (n) n.textContent = txt;
  }
  function setBadge(sel, label, cls) {
    const n = container.querySelector(sel);
    if (!n) return;
    n.innerHTML = '';
    n.appendChild(el('span', { class: `badge ${cls}` }, label));
  }
  function setStatus(s, cls = '') { setBadge('#bStatus', s, cls); }

  function onMotion(ev) {
    const a = ev.accelerationIncludingGravity || {};
    const z = a.z ?? 0;
    const now = performance.now();
    const dt = lastTs ? (now - lastTs) / 1000 : 1 / SAMPLE_HZ;
    lastTs = now;

    rawBuf.push(z);
    const filt = bp.step(z, dt);
    filtBuf.push(filt);

    const r = peaks.step(filt, now);
    if (r.isPeak && r.intervalMs > 0) rate.push(r.intervalMs);
  }

  function quality() {
    // SNR = std(filtrato) / std(grezzo). Sopra 0.05 = segnale plausibile.
    const filtStd = filtBuf.std();
    const rawStd = rawBuf.std() || 1e-6;
    const snr = filtStd / rawStd;
    return { snr, filtStd, rawStd };
  }

  function render() {
    if (!active) return;
    drawTrace(canvas, filtBuf.toArray(), { color: '#8af0c8' });
    const v = rate.perMinute();
    setText('#bRate', v > 0 ? fmt(v, 1) : '—');
    const q = quality();
    let lbl, cls;
    if (q.filtStd < 0.01)    { lbl = 'in attesa';   cls = ''; }
    else if (q.snr < 0.03)   { lbl = 'rumore alto'; cls = 'bad'; }
    else if (q.snr < 0.08)   { lbl = 'media';       cls = 'warn'; }
    else                      { lbl = 'buona';       cls = 'ok'; }
    setBadge('#bQual', lbl, cls);
    rafId = requestAnimationFrame(render);
  }

  async function start() {
    setStatus('richiesta permessi…', 'info');
    const r = await requestMotionPermission();
    if (r !== 'granted') {
      setStatus('permesso negato', 'bad');
      return;
    }
    bp.reset(); peaks.reset(); rate.reset();
    filtBuf.clear(); rawBuf.clear();
    lastTs = 0;
    handler = onMotion;
    window.addEventListener('devicemotion', handler);
    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('attivo', 'ok');
    rafId = requestAnimationFrame(render);
  }

  function stop() {
    active = false;
    if (handler) window.removeEventListener('devicemotion', handler);
    handler = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
    // Salva l'ultima frequenza respiratoria per gli anelli salute.
    const v = rate.perMinute();
    if (v > 0) setMetric('breath', Math.round(v), '/min');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return { unmount() { stop(); } };
}
