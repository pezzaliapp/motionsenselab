// ============================================================================
// steps.js — Modulo "Passi e attività".
//
// Conta passi a partire dall'accelerometro:
//   1) calcoliamo la magnitudo |a| includendo la gravità;
//   2) la filtriamo con un passa-banda 0.6–3 Hz (camminata umana 1.5–2.5 Hz,
//      corsa fino a 3+ Hz) → isola il "ritmo" del passo eliminando deriva
//      gravitazionale e rumore alto;
//   3) cerchiamo picchi locali al di sopra di una soglia adattativa,
//      con refrattarietà 280 ms (cadenza massima ≈ 215 passi/min);
//   4) classifichiamo l'attività in base a cadenza recente e ampiezza:
//       - 0 passi attivi negli ultimi 3 s → fermo
//       - cadenza < 130 spm e ampiezza moderata → cammino
//       - cadenza ≥ 130 spm o ampiezza alta → corsa
// ============================================================================

import { el, RingBuffer, BandPass, PeakDetector, fmt, drawTrace } from '../utils.js';
import { requestMotionPermission } from '../permissions.js';

const SAMPLE_HZ = 50;     // stima media; il filtro usa dt reale
const WINDOW_S = 6;

export function mount(container) {
  let active = false;
  let handler = null;
  let rafId = null;
  let lastTs = 0;
  let stepCount = 0;
  const recentSteps = [];           // timestamp degli ultimi N passi → cadenza
  const ampWindow = new RingBuffer(30);

  // Filtri & detector
  // 0.6 Hz HP = rimuove gravità (≈0 Hz) e oscillazioni lente.
  // 3 Hz LP  = lascia passare la cadenza umana.
  const bp = new BandPass(0.6, 3.0);
  const peaks = new PeakDetector({ minIntervalMs: 280, k: 0.7 });

  // Buffer grafico
  const filtBuf = new RingBuffer(SAMPLE_HZ * WINDOW_S);

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Passi e attività'),
    el('p', {}, "Filtro passa-banda 0.6–3 Hz sulla magnitudo dell'accelerazione e conteggio dei picchi → un picco = un passo. La cadenza recente determina l'attività in corso."),
    el('p', { class: 'muted', style: 'font-size:12.5px' }, "Tieni il telefono in tasca o in mano in modo stabile, poi cammina o corri."),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva conteggio');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const resetBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Reset contatore');

  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { style: 'margin-top:10px' }, resetBtn),
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'),    el('dd', { id: 'sStatus' }, '—'),
      el('dt', {}, 'Attività'), el('dd', { id: 'sAct' },    '—'),
      el('dt', {}, 'Cadenza'),  el('dd', { id: 'sCad' },    '— spm'),
    ),
  );

  const counter = el('div', { class: 'card', style: 'text-align:center' },
    el('h3', {}, 'Passi sessione'),
    el('div', { class: 'metric', id: 'sCount', style: 'justify-content:center' }, '0'),
  );

  const canvas = el('canvas', { height: 140 });
  const graph = el('div', { class: 'card' },
    el('h3', {}, 'Segnale passo (filtrato)'),
    canvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, "Ogni oscillazione sopra la soglia adattativa è un passo conteggiato."),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(counter);
  container.appendChild(graph);

  // ---- Logica ----
  function setText(sel, txt) {
    const n = container.querySelector(sel);
    if (n) n.textContent = txt;
  }
  function setStatus(s, badgeClass = '') {
    const n = container.querySelector('#sStatus');
    if (!n) return;
    n.innerHTML = '';
    n.appendChild(el('span', { class: `badge ${badgeClass}` }, s));
  }
  function setActivity(label, cls) {
    const n = container.querySelector('#sAct');
    if (!n) return;
    n.innerHTML = '';
    n.appendChild(el('span', { class: `badge ${cls}` }, label));
  }

  function currentCadence() {
    // Cadenza (passi al minuto) calcolata sugli ultimi 5 s di passi.
    const cutoff = performance.now() - 5000;
    while (recentSteps.length && recentSteps[0] < cutoff) recentSteps.shift();
    if (recentSteps.length < 2) return 0;
    const span = recentSteps[recentSteps.length - 1] - recentSteps[0];
    if (span <= 0) return 0;
    return ((recentSteps.length - 1) / span) * 60000;
  }
  function avgAmplitude() { return ampWindow.mean(); }

  function classifyActivity() {
    const cadence = currentCadence();
    const cutoff = performance.now() - 3000;
    while (recentSteps.length && recentSteps[0] < cutoff) recentSteps.shift();
    if (recentSteps.length < 2) return { label: 'fermo', cls: 'ok' };
    const amp = avgAmplitude();
    if (cadence < 70 && amp < 1.5)  return { label: 'movimento leggero', cls: 'info' };
    if (cadence < 130 && amp < 4.5) return { label: 'cammino', cls: 'info' };
    return { label: 'corsa', cls: 'warn' };
  }

  function onMotion(ev) {
    const a = ev.accelerationIncludingGravity || {};
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);   // m/s²
    const now = performance.now();
    const dt = lastTs ? (now - lastTs) / 1000 : 1 / SAMPLE_HZ;
    lastTs = now;

    const filt = bp.step(mag, dt);
    filtBuf.push(filt);

    const { isPeak } = peaks.step(filt, now);
    if (isPeak) {
      stepCount += 1;
      recentSteps.push(now);
      ampWindow.push(Math.abs(filt));
    }
  }

  function render() {
    if (!active) return;
    drawTrace(canvas, filtBuf.toArray(), { color: '#8af0c8', min: -6, max: 6 });
    setText('#sCount', String(stepCount));
    const cadence = currentCadence();
    setText('#sCad', `${Math.round(cadence)} spm`);
    const act = classifyActivity();
    setActivity(act.label, act.cls);
    rafId = requestAnimationFrame(render);
  }

  async function start() {
    setStatus('richiesta permessi…', 'info');
    const r = await requestMotionPermission();
    if (r !== 'granted') {
      setStatus('permesso negato', 'bad');
      return;
    }
    bp.reset(); peaks.reset(); filtBuf.clear(); ampWindow.clear();
    lastTs = 0;
    handler = onMotion;
    window.addEventListener('devicemotion', handler);
    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('conteggio attivo', 'ok');
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
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  resetBtn.addEventListener('click', () => {
    stepCount = 0;
    recentSteps.length = 0;
    ampWindow.clear();
    setText('#sCount', '0');
  });

  return { unmount() { stop(); } };
}
