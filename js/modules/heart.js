// ============================================================================
// heart.js — Modulo "Battito cardiaco" (PPG ottica).
//
// Principio fisico (fotopletismografia):
//   Il sangue ossigenato assorbe maggiormente la luce verde/rossa rispetto
//   al tessuto. Quando il cuore pompa, il volume di sangue capillare al
//   polpastrello aumenta brevemente → l'intensità della luce trasmessa
//   diminuisce di un piccolo ΔI. Posando il dito sulla lente, la camera
//   "vede" la pulsazione come una piccola modulazione del canale rosso.
//
// Pipeline implementata:
//   1) videoElement → drawImage su canvas off-screen (160×120, riduce CPU)
//   2) per ogni frame, media del canale rosso su una ROI centrale
//   3) filtro passa-banda 0.7 Hz – 4 Hz (42–240 bpm)
//   4) peak detector adattivo → battiti
//   5) RateEstimator (mediana mobile su 8 intervalli) → bpm stabile
//
// Limiti dichiarati:
//   - torcia non accessibile da PWA su iOS: serve buona luce ambientale,
//     oppure puntare verso una sorgente luminosa stabile.
//   - mantenere il dito FERMO è essenziale: rumore di movimento >> segnale PPG.
// ============================================================================

import { el, RateEstimator, drawTrace } from '../utils.js';
import { PpgCapture } from '../ppg.js';
import { setMetric } from '../store.js';

export function mount(container) {
  // La cattura PPG (camera, filtro, picchi, qualità) è incapsulata in PpgCapture
  // e condivisa con il modulo Stress. Qui consumiamo i campioni per stimare i bpm.
  let capture = null;

  const rate = new RateEstimator(8);

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Battito cardiaco (PPG)'),
    el('p', {}, "Appoggia delicatamente il polpastrello dell'indice sulla fotocamera posteriore. Tieni fermo per circa 20 secondi. L'app analizza la luminosità del canale rosso, isola la componente cardiaca (0.7–4 Hz) e conta i picchi."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Misurazione indicativa, non uso medico. '),
      "Usa un cardiofrequenzimetro o un saturimetro per misure affidabili. Su iOS la torcia non è accessibile da PWA: serve buona luce ambientale e dito fermo."
    ),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva fotocamera');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'),    el('dd', { id: 'hStatus' }, '—'),
      el('dt', {}, 'Qualità'),  el('dd', { id: 'hQual' },   '—'),
      el('dt', {}, 'Luce'),     el('dd', { id: 'hLight' },  '—'),
    ),
  );

  const bpmCard = el('div', { class: 'card', style: 'text-align:center' },
    el('h3', {}, 'Frequenza cardiaca stimata'),
    el('div', { class: 'metric', id: 'hBpmWrap', style: 'justify-content:center' },
      el('span', { id: 'hBpm' }, '—'),
      el('span', { class: 'unit' }, 'bpm'),
    ),
  );

  const canvas = el('canvas', { height: 140, 'aria-label': 'Onda PPG' });
  const graphCard = el('div', { class: 'card' },
    el('h3', {}, 'Forma d\'onda PPG (filtrata)'),
    canvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, "Ogni picco corrisponde a una sistole. Se il segnale è piatto: il dito non copre la lente o c'è poca luce."),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(bpmCard);
  container.appendChild(graphCard);

  // ---- helpers UI ----
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
  function setStatus(s, cls = '') { setBadge('#hStatus', s, cls); }

  // ---- Consumo dei campioni PPG ----
  // Per ogni frame aggiorniamo l'indicatore "dito/luce" e, sui picchi validi,
  // alimentiamo il RateEstimator. Il rendering del grafico e dei bpm avviene qui.
  function onSample(s) {
    setBadge('#hLight', s.fingerOk ? 'dito rilevato' : 'posiziona il dito', s.fingerOk ? 'ok' : 'warn');

    if (s.fingerOk && s.isPeak && s.intervalMs > 0) rate.push(s.intervalMs);

    drawTrace(canvas, capture.filtered(), { color: '#ff5b6e' });
    const bpm = rate.perMinute();
    setText('#hBpm', bpm > 0 ? Math.round(bpm).toString() : '—');

    let qLbl, qCls;
    if (!s.fingerOk)            { qLbl = 'in attesa'; qCls = ''; }
    else if (s.quality < 0.2)  { qLbl = 'bassa';     qCls = 'bad'; }
    else if (s.quality < 0.5)  { qLbl = 'media';     qCls = 'warn'; }
    else                        { qLbl = 'buona';    qCls = 'ok'; }
    setBadge('#hQual', qLbl, qCls);
  }

  async function start() {
    setStatus('richiesta fotocamera…', 'info');
    rate.reset();
    capture = new PpgCapture(onSample);
    try {
      await capture.start();
    } catch (err) {
      capture = null;
      setStatus('permesso negato o fotocamera non disponibile', 'bad');
      return;
    }
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('attivo', 'ok');
  }

  function stop() {
    if (capture) { capture.stop(); capture = null; }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
    // Salva l'ultimo bpm per gli anelli salute della Home.
    const bpm = rate.perMinute();
    if (bpm > 0) setMetric('hr', Math.round(bpm), 'bpm');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return { unmount() { stop(); } };
}
