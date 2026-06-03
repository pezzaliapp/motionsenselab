// ============================================================================
// stress.js — "Indice di stress da HRV" (variabilità della frequenza cardiaca).
//
// Base fisica REALE: il PPG dal polpastrello (motore condiviso ppg.js) produce
// gli intervalli battito-battito (≈ RR). Dalla loro variabilità si stima l'HRV,
// da cui Garmin/Fitbit & co. derivano un indice di stress/recupero.
//
// Catena:
//   PpgCapture → intervalli RR → filtro artefatti → RMSSD/SDNN su finestra
//   mobile (~60 s) → mappa euristica HRV→stress (0–100) → gauge.
//
//   RMSSD = sqrt( mean( (RR[i+1]-RR[i])^2 ) )   [ms]
//   stress = clamp(100 - scale(RMSSD), 0, 100)
//   scale(RMSSD) = clamp( (RMSSD-10)/(80-10) * 100, 0, 100 )   ← euristica dichiarata
//
// ⚠️ È un INDICE INDICATIVO derivato dall'HRV, NON una misura clinica dello
//    stress. La scala 10–80 ms è una calibrazione plausibile ma arbitraria.
//    Richiede un PPG pulito: con qualità bassa o pochi battiti mostriamo "—".
// ============================================================================

import { el, clamp } from '../utils.js';
import { PpgCapture } from '../ppg.js';
import { drawGauge } from '../gauge.js';
import { setMetric } from '../store.js';

const WINDOW_MS = 60000;   // finestra mobile di RR considerati
const MIN_RR = 20;         // battiti validi minimi prima di mostrare un numero
const RMSSD_LO = 10;       // ms: HRV "bassa" → stress alto
const RMSSD_HI = 80;       // ms: HRV "alta"  → stress basso

// Categoria testuale dell'indice (solo descrittiva).
function category(stress) {
  if (stress < 34) return 'Recupero';
  if (stress < 67) return 'Moderato';
  return 'Elevato';
}

export function mount(container) {
  let capture = null;
  const rr = [];            // { v:ms, ts:ms } intervalli validati, finestra mobile
  let prevInRange = 0;      // ultimo RR in range fisiologico (per filtro salti)
  let lastStress = null;    // ultimo indice valido (per salvataggio allo stop)

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Indice di stress (da HRV)'),
    el('p', {}, "Stessa misura del Battito: appoggia il polpastrello sulla fotocamera posteriore e resta fermo ~60 secondi. Dagli intervalli tra un battito e l'altro calcoliamo la variabilità cardiaca (HRV) e, da quella, un indice di stress/recupero — lo stesso principio degli smartwatch."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Indice indicativo derivato dall’HRV — non è una misura clinica dello stress. '),
      "La scala è euristica (RMSSD 10–80 ms). Serve un segnale PPG pulito: con qualità bassa o pochi battiti l'indice resta “—”."
    ),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva fotocamera');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  // Toggle torcia: visibile solo se la fotocamera espone 'torch' (vedi onTorch).
  const torchBtn = el('button', { class: 'btn ghost hidden', type: 'button' }, '🔦 Torcia');
  const torchHint = el('p', { class: 'muted hidden', style: 'font-size:12px;margin-top:8px' },
    'Torcia non disponibile su questo dispositivo (iPhone con iOS ≤16 o fotocamera senza flash): per un HRV affidabile servono buona luce ambientale e dito fermo.');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { style: 'margin-top:10px' }, torchBtn),
    torchHint,
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'),   el('dd', { id: 'stStatus' }, '—'),
      el('dt', {}, 'Qualità'), el('dd', { id: 'stQual' },   '—'),
      el('dt', {}, 'Dito'),    el('dd', { id: 'stFinger' }, '—'),
    ),
  );

  const gaugeCanvas = el('canvas', { class: 'gauge', role: 'img', 'aria-label': 'Indice di stress da HRV, da 0 a 100' });
  const gaugeBox = el('div', { class: 'gauge-wrap' }, gaugeCanvas);
  const gaugeCard = el('div', { class: 'card' },
    el('h3', { style: 'text-align:center' }, 'Indice di stress'),
    gaugeBox,
    el('div', { class: 'kv', style: 'margin-top:6px' },
      el('dt', {}, 'RMSSD'),   el('dd', { id: 'stRmssd' }, '—'),
      el('dt', {}, 'SDNN'),    el('dd', { id: 'stSdnn' },  '—'),
      el('dt', {}, 'Battiti'), el('dd', { id: 'stCount' }, '0'),
    ),
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
      'HRV alta → stress basso (verde). HRV bassa → stress alto (rosso). Indice indicativo, non clinico.'),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(gaugeCard);

  // Disegno iniziale (gauge vuoto → "—"). Al frame successivo, così il canvas
  // ha già la larghezza di layout.
  requestAnimationFrame(() => drawGauge(gaugeCanvas, NaN, { label: 'Stress', unit: '/100' }));

  // ---- helpers ----
  function setBadge(sel, label, cls) {
    const n = container.querySelector(sel);
    if (!n) return;
    n.innerHTML = '';
    n.appendChild(el('span', { class: `badge ${cls}` }, label));
  }
  function setText(sel, txt) {
    const n = container.querySelector(sel);
    if (n) n.textContent = txt;
  }
  function setStatus(s, cls = '') { setBadge('#stStatus', s, cls); }

  // Filtro artefatti sugli RR: scarta valori non fisiologici e salti bruschi
  // (movimento del dito) — necessario per un RMSSD onesto.
  function pushRR(v, ts) {
    if (v < 300 || v > 1500) { prevInRange = 0; return; }      // fuori 40–200 bpm → rompe la catena
    if (prevInRange && Math.abs(v - prevInRange) / prevInRange > 0.25) { prevInRange = v; return; }
    rr.push({ v, ts });
    prevInRange = v;
  }

  function prune(now) {
    const cutoff = now - WINDOW_MS;
    while (rr.length && rr[0].ts < cutoff) rr.shift();
  }

  function computeHrv() {
    if (rr.length < 2) return null;
    const vals = rr.map(r => r.v);
    // RMSSD
    let s = 0;
    for (let i = 1; i < vals.length; i++) { const d = vals[i] - vals[i - 1]; s += d * d; }
    const rmssd = Math.sqrt(s / (vals.length - 1));
    // SDNN
    let mean = 0; for (const v of vals) mean += v; mean /= vals.length;
    let varr = 0; for (const v of vals) varr += (v - mean) * (v - mean);
    const sdnn = Math.sqrt(varr / vals.length);
    return { rmssd, sdnn, n: vals.length };
  }

  function stressFromRmssd(rmssd) {
    const scale = clamp(((rmssd - RMSSD_LO) / (RMSSD_HI - RMSSD_LO)) * 100, 0, 100);
    return clamp(100 - scale, 0, 100);
  }

  function onSample(s) {
    setBadge('#stFinger', s.fingerOk ? 'rilevato' : 'posiziona il dito', s.fingerOk ? 'ok' : 'warn');

    let qLbl, qCls;
    if (!s.fingerOk)            { qLbl = 'in attesa'; qCls = ''; }
    else if (s.quality < 0.2)  { qLbl = 'bassa';     qCls = 'bad'; }
    else if (s.quality < 0.5)  { qLbl = 'media';     qCls = 'warn'; }
    else                        { qLbl = 'buona';    qCls = 'ok'; }
    setBadge('#stQual', qLbl, qCls);

    // Raccogliamo RR solo con dito presente e qualità non infima.
    if (s.fingerOk && s.isPeak && s.intervalMs > 0 && s.quality >= 0.2) {
      pushRR(s.intervalMs, s.ts);
    }
    prune(s.ts);

    const hrv = computeHrv();
    setText('#stCount', String(rr.length));

    // Mostriamo l'indice solo con abbastanza battiti validi e qualità decente.
    const ready = hrv && rr.length >= MIN_RR && s.quality >= 0.2;
    if (ready) {
      const stress = stressFromRmssd(hrv.rmssd);
      lastStress = stress;
      setText('#stRmssd', `${Math.round(hrv.rmssd)} ms`);
      setText('#stSdnn', `${Math.round(hrv.sdnn)} ms`);
      drawGauge(gaugeCanvas, stress, { label: 'Stress', unit: '/100', sub: category(stress) });
    } else {
      const need = Math.max(0, MIN_RR - rr.length);
      drawGauge(gaugeCanvas, NaN, {
        label: 'Stress', unit: '/100',
        sub: need > 0 ? `raccolgo… ${rr.length}/${MIN_RR}` : 'segnale debole',
      });
      if (hrv) { setText('#stRmssd', `${Math.round(hrv.rmssd)} ms`); setText('#stSdnn', `${Math.round(hrv.sdnn)} ms`); }
    }
  }

  // Stato torcia → toggle visibile solo dove 'torch' è esposto, altrimenti avviso.
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
    rr.length = 0; prevInRange = 0; lastStress = null;
    setText('#stRmssd', '—'); setText('#stSdnn', '—'); setText('#stCount', '0');
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
    gaugeBox.classList.add('scanning');   // effetto visivo decorativo (non diagnostico)
    setStatus('misura in corso', 'ok');
  }

  function stop() {
    if (capture) { capture.stop(); capture = null; }
    gaugeBox.classList.remove('scanning');
    resetTorchUI();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
    // Salviamo l'ultimo indice valido per gli anelli salute della Home.
    if (lastStress != null) setMetric('stress', Math.round(lastStress), '/100');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  torchBtn.addEventListener('click', () => { if (capture) capture.setTorch(!capture.torchOn); });

  return { unmount() { stop(); } };
}
