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
//   3) filtro passa-banda 0.9 Hz – 4 Hz (≈54–240 bpm)
//   4) peak detector normalizzato → battiti (intervalli RR)
//   5) filtro outlier sugli RR + mediana mobile + gate di coerenza e smoothing
//      → bpm stabile (mostrato solo se gli ultimi battiti sono consistenti)
//
// Limiti dichiarati:
//   - torcia non accessibile da PWA su iOS: serve buona luce ambientale,
//     oppure puntare verso una sorgente luminosa stabile.
//   - mantenere il dito FERMO è essenziale: rumore di movimento >> segnale PPG.
// ============================================================================

import { el, drawTrace } from '../utils.js';
import { PpgCapture } from '../ppg.js';
import { setMetric } from '../store.js';

export function mount(container) {
  // La cattura PPG (camera, filtro, picchi, qualità) è incapsulata in PpgCapture
  // e condivisa con il modulo Stress. Qui consumiamo i campioni per stimare i bpm.
  let capture = null;

  // Stima bpm robusta: gli intervalli RR passano un filtro outlier (range
  // fisiologico + scarto dei salti bruschi da sfarfallio del dito / doppi
  // conteggi), poi mediana su finestra mobile. Il numero si mostra solo quando
  // gli ultimi battiti sono COERENTI (segnale davvero periodico) ed è smussato,
  // così non salta 120→75→35. Altrimenti "—" (onesto: sta ancora misurando).
  const recentRR = [];     // ultimi intervalli RR validi (ms)
  let dispBpm = 0;         // bpm visualizzato, smussato (EMA)
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function pushRR(v) {
    if (v < 333 || v > 1500) return;                 // fuori 40–180 bpm
    if (recentRR.length >= 3) {
      const m = median(recentRR);
      if (Math.abs(v - m) / m > 0.30) return;        // scarta l'outlier (flicker/doppio conteggio)
    }
    recentRR.push(v);
    if (recentRR.length > 8) recentRR.shift();
  }

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Battito cardiaco (PPG)'),
    el('p', {}, "Appoggia delicatamente il polpastrello dell'indice sulla fotocamera posteriore. Tieni fermo per circa 20 secondi. L'app analizza la luminosità del canale rosso, isola la componente cardiaca (0.9–4 Hz) e conta i picchi."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Misurazione indicativa, non uso medico. '),
      "Usa un cardiofrequenzimetro o un saturimetro per misure affidabili. Su iPhone (iOS 17+) l'app può accendere la torcia per un segnale più pulito; dove non è disponibile servono buona luce ambientale e dito fermo."
    ),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva fotocamera');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  // Toggle torcia: visibile solo se la fotocamera espone 'torch' (vedi onTorch).
  const torchBtn = el('button', { class: 'btn ghost hidden', type: 'button' }, '🔦 Torcia');
  const torchHint = el('p', { class: 'muted hidden', style: 'font-size:12px;margin-top:8px' },
    'Torcia non disponibile su questo dispositivo (iPhone con iOS ≤16 o fotocamera senza flash): misura affidabile solo con buona luce ambientale e dito fermo.');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { style: 'margin-top:10px' }, torchBtn),
    torchHint,
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
  // alimentiamo il buffer RR filtrato. Il rendering del grafico e dei bpm qui.
  function onSample(s) {
    setBadge('#hLight', s.fingerOk ? 'dito rilevato' : 'posiziona il dito', s.fingerOk ? 'ok' : 'warn');

    if (s.fingerOk && s.isPeak && s.intervalMs > 0) pushRR(s.intervalMs);
    // Dito assente per davvero: butta la storia, così al rientro si riparte pulito.
    if (!s.fingerOk) { recentRR.length = 0; dispBpm = 0; }

    drawTrace(canvas, capture.filtered(), { color: '#ff5b6e' });

    // Mostra il numero solo con abbastanza battiti COERENTI tra loro (segnale
    // periodico): mediana + dispersione bassa. Altrimenti "—" (sta misurando).
    let shown = '—';
    if (s.fingerOk && recentRR.length >= 5) {
      const m = median(recentRR);
      const spread = (Math.max(...recentRR) - Math.min(...recentRR)) / m;
      const bpm = 60000 / m;
      if (spread < 0.35 && bpm >= 40 && bpm <= 200) {
        dispBpm = dispBpm ? dispBpm * 0.8 + bpm * 0.2 : bpm;   // smoothing
        shown = Math.round(dispBpm).toString();
      } else if (dispBpm) {
        shown = Math.round(dispBpm).toString();                // tieni l'ultimo stabile
      }
    }
    setText('#hBpm', shown);

    let qLbl, qCls;
    if (!s.fingerOk)            { qLbl = 'in attesa'; qCls = ''; }
    else if (s.quality < 0.2)  { qLbl = 'bassa';     qCls = 'bad'; }
    else if (s.quality < 0.5)  { qLbl = 'media';     qCls = 'warn'; }
    else                        { qLbl = 'buona';    qCls = 'ok'; }
    setBadge('#hQual', qLbl, qCls);
  }

  // Stato torcia → mostra il toggle solo dove 'torch' è esposto, altrimenti
  // mostra l'avviso onesto sull'affidabilità senza torcia.
  function onTorch({ available, on }) {
    if (available) {
      torchHint.classList.add('hidden');
      torchBtn.classList.remove('hidden');
      torchBtn.classList.toggle('ok', on);
      torchBtn.textContent = on ? '🔦 Torcia accesa — tocca per spegnere' : '🔦 Accendi torcia';
    } else {
      torchBtn.classList.add('hidden');
      torchHint.classList.remove('hidden');
    }
  }

  function resetTorchUI() {
    torchBtn.classList.add('hidden');
    torchBtn.classList.remove('ok');
    torchHint.classList.add('hidden');
  }

  async function start() {
    setStatus('richiesta fotocamera…', 'info');
    recentRR.length = 0; dispBpm = 0;
    setText('#hBpm', '—');
    capture = new PpgCapture(onSample, onTorch);
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
    resetTorchUI();
    setStatus('fermo', '');
    // Salva l'ultimo bpm STABILE per gli anelli salute della Home.
    if (dispBpm > 0) setMetric('hr', Math.round(dispBpm), 'bpm');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  torchBtn.addEventListener('click', () => { if (capture) capture.setTorch(!capture.torchOn); });

  return { unmount() { stop(); } };
}
