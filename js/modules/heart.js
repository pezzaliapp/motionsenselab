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

  // ---- Sonda diagnostica (read-only) ----
  // Mostra cosa la fotocamera sta realmente usando: quale lente (deviceId/label),
  // i settings della traccia e le capabilities (in particolare se 'torch' è esposto).
  // Su iPhone non c'è una console comoda: stampiamo qui + bottone "Copia".
  // -webkit-user-select/-webkit-touch-callout espliciti: su iOS in PWA la
  // clipboard API spesso fallisce; così il JSON resta selezionabile a mano
  // (long-press → Seleziona) o fotografabile, e la copia col bottone è solo un extra.
  // Read-out LIVE (aggiornato ~1×/s): meanR/G/B e % saturazione del rosso.
  // Serve a distinguere "AGC che schiaccia la AC" da "rosso clippato a 255":
  // se la saturazione è alta il segnale è tagliato; se è bassa ma l'onda resta
  // sbavata il sospetto resta l'auto-esposizione/white-balance.
  const diagLive = el('pre', { id: 'hDiagLive', style: 'white-space:pre-wrap;font-size:11px;margin:0 0 8px;background:rgba(255,255,255,.04);padding:10px;border-radius:8px;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default' }, '— canale rosso live: attiva la fotocamera —');
  const diagPre = el('pre', { id: 'hDiag', style: 'white-space:pre-wrap;word-break:break-word;font-size:11px;margin:0;max-height:280px;overflow:auto;-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;background:rgba(255,255,255,.04);padding:10px;border-radius:8px' }, '— attiva la fotocamera per leggere i dati —');
  const diagCopy = el('button', { class: 'btn ghost', type: 'button', style: 'margin-top:8px' }, 'Copia diagnostica');
  const diagCard = el('div', { class: 'card' },
    el('h3', {}, '🔍 Diagnostica camera (read-only)'),
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'Quale lente viene aperta, i suoi settings, quali controlli sono manuali e se il rosso è saturo. Non altera la misura.'),
    diagLive,
    diagPre,
    diagCopy,
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
  container.appendChild(diagCard);
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
  let lastLiveTs = 0;
  function onSample(s) {
    setBadge('#hLight', s.fingerOk ? 'dito rilevato' : 'posiziona il dito', s.fingerOk ? 'ok' : 'warn');

    // Diagnostica live (~1×/s): canale rosso medio + saturazione. Read-only.
    if (s.ts - lastLiveTs > 900) {
      lastLiveTs = s.ts;
      const sat = (s.satPct * 100);
      diagLive.textContent =
        `meanR=${s.meanR.toFixed(1)}  meanG=${s.meanG.toFixed(1)}  meanB=${s.meanB.toFixed(1)}\n` +
        `saturazione rosso (R≥250): ${sat.toFixed(1)}%${sat > 50 ? '  ← CLIPPING: segnale tagliato' : ''}\n` +
        `dito: ${s.fingerOk ? 'sì' : 'no'}   ampiezza AC (qualità): ${s.quality.toFixed(3)}`;
    }

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

  // Riceve la sonda read-only da PpgCapture e la rende leggibile/copiabile.
  let lastDiag = null;
  function onDiag(info) {
    lastDiag = info;
    const caps = info.capabilities || {};
    const ctrl = info.controls || {};

    // Quali controlli AGC/AWB/AF sono davvero pilotabili su questo device:
    // un 'modo' è utile se ammette 'manual'; un range se espone min/max/step.
    const fmtMode = (name, arr) => {
      if (!arr) return `  ${name}: (assente)`;
      const list = Array.isArray(arr) ? arr : [arr];
      const ok = list.includes('manual');
      return `  ${name}: [${list.join(', ')}]${ok ? '  ← manual disponibile' : '  (no manual)'}`;
    };
    const fmtRange = (name, r) => {
      if (!r) return `  ${name}: (assente)`;
      return `  ${name}: min=${r.min} max=${r.max} step=${r.step}  ← regolabile`;
    };

    const lines = [
      `torch esposto: ${'torch' in caps ? caps.torch : '(assente)'}`,
      `zoom esposto:  ${'zoom' in caps ? JSON.stringify(caps.zoom) : '(assente)'}`,
      '',
      'controlli manuali (le leve per i prossimi commit):',
      fmtMode('exposureMode', ctrl.exposureMode),
      fmtMode('focusMode', ctrl.focusMode),
      fmtMode('whiteBalanceMode', ctrl.whiteBalanceMode),
      fmtRange('exposureCompensation', ctrl.exposureCompensation),
      fmtRange('focusDistance', ctrl.focusDistance),
      fmtRange('zoom', ctrl.zoom),
      '',
      'settings (lente attiva):',
      JSON.stringify(info.settings || {}, null, 2),
      '',
      'capabilities:',
      JSON.stringify(caps, null, 2),
      '',
      `camere posteriori viste (${(info.videoInputs || []).length}):`,
      JSON.stringify(info.videoInputs || [], null, 2),
    ];
    diagPre.textContent = lines.join('\n');
  }
  diagCopy.addEventListener('click', async () => {
    const txt = lastDiag ? JSON.stringify(lastDiag, null, 2) : diagPre.textContent;
    try { await navigator.clipboard.writeText(txt); diagCopy.textContent = 'Copiato ✓'; }
    catch { diagCopy.textContent = 'Copia non riuscita — seleziona il testo'; }
    setTimeout(() => { diagCopy.textContent = 'Copia diagnostica'; }, 1800);
  });

  function resetTorchUI() {
    torchBtn.classList.add('hidden');
    torchBtn.classList.remove('ok');
    torchHint.classList.add('hidden');
  }

  async function start() {
    setStatus('richiesta fotocamera…', 'info');
    rate.reset();
    capture = new PpgCapture(onSample, onTorch, onDiag);
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
    // Salva l'ultimo bpm per gli anelli salute della Home.
    const bpm = rate.perMinute();
    if (bpm > 0) setMetric('hr', Math.round(bpm), 'bpm');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  torchBtn.addEventListener('click', () => { if (capture) capture.setTorch(!capture.torchOn); });

  return { unmount() { stop(); } };
}
