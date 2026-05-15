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

import { el, RingBuffer, BandPass, PeakDetector, RateEstimator, fmt, drawTrace } from '../utils.js';
import { requestCamera } from '../permissions.js';

const ROI_SIZE = 80;              // ROI 80x80 al centro del frame
const PROC_W = 160, PROC_H = 120; // dimensione canvas off-screen
const WINDOW_S = 8;
const SAMPLE_HZ = 30;             // tipico frame rate video

export function mount(container) {
  let stream = null;
  let video = null;
  let off = null, offCtx = null;
  let active = false;
  let rafId = null;
  let lastTs = 0;

  // Filtri & detector
  // Banda PPG: 0.7 Hz (42 bpm) – 4 Hz (240 bpm).
  const bp = new BandPass(0.7, 4.0);
  // Refrattarietà 280 ms ≈ massimo 214 bpm (oltre è artefatto).
  const peaks = new PeakDetector({ minIntervalMs: 280, k: 0.5 });
  const rate = new RateEstimator(8);

  const filtBuf = new RingBuffer(SAMPLE_HZ * WINDOW_S);
  let qualityScore = 0;            // 0..1, ratio segnale/rumore

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

  // ---- Pipeline frame ----
  // Calcola la media del canale rosso sulla ROI centrale del video.
  function processFrame(ts) {
    if (!active) return;
    if (video.readyState >= 2) {
      // Disegniamo il frame su canvas off-screen.
      offCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
      // ROI centrale
      const sx = (PROC_W - ROI_SIZE) >> 1;
      const sy = (PROC_H - ROI_SIZE) >> 1;
      const img = offCtx.getImageData(sx, sy, ROI_SIZE, ROI_SIZE).data;

      let sumR = 0, sumG = 0, sumB = 0;
      const n = ROI_SIZE * ROI_SIZE;
      for (let i = 0; i < img.length; i += 4) {
        sumR += img[i];
        sumG += img[i + 1];
        sumB += img[i + 2];
      }
      const meanR = sumR / n;
      const meanG = sumG / n;
      const meanB = sumB / n;

      // Diagnostica qualitativa: se il dito è ben appoggiato, R domina su G/B
      // (luce filtrata dal sangue → il rosso passa, verde/blu vengono assorbiti).
      // Se R, G, B sono simili → la camera vede l'ambiente, non un dito.
      const fingerOk = meanR > 60 && meanR > meanG * 1.2 && meanR > meanB * 1.2;
      setBadge('#hLight', fingerOk ? 'dito rilevato' : 'posiziona il dito', fingerOk ? 'ok' : 'warn');

      // dt reale: video.requestVideoFrameCallback non è ancora universale su
      // iOS → usiamo performance.now su RAF, che è "abbastanza buono".
      const now = performance.now();
      const dt = lastTs ? (now - lastTs) / 1000 : 1 / SAMPLE_HZ;
      lastTs = now;

      // Filtro passa-banda sul valore medio del rosso.
      const filt = bp.step(meanR, dt);
      filtBuf.push(filt);

      // Stima qualità: SNR grossolano = std(filtrato) / std(grezzo).
      // Quando il filtrato ha ampiezza significativa rispetto al rumore →
      // la pulsazione è chiara. Normalizziamo in 0..1.
      const arr = filtBuf.toArray();
      if (arr.length > 30) {
        let mean = 0; for (let i = 0; i < arr.length; i++) mean += arr[i]; mean /= arr.length;
        let varr = 0; for (let i = 0; i < arr.length; i++) varr += (arr[i] - mean) * (arr[i] - mean);
        varr /= arr.length;
        // amplitude usable se varianza > 0.2 (unità grezze del canale R filtrato)
        qualityScore = Math.min(1, Math.sqrt(varr) / 2);
      }

      // Peak detection solo se il dito è plausibilmente rilevato.
      if (fingerOk) {
        const r = peaks.step(filt, now);
        if (r.isPeak && r.intervalMs > 0) {
          rate.push(r.intervalMs);
        }
      } else {
        peaks.reset();
      }

      // Render
      drawTrace(canvas, arr, { color: '#ff5b6e' });
      const bpm = rate.perMinute();
      setText('#hBpm', bpm > 0 ? Math.round(bpm).toString() : '—');

      // Qualità label
      let qLbl, qCls;
      if (!fingerOk)          { qLbl = 'in attesa'; qCls = ''; }
      else if (qualityScore < 0.2) { qLbl = 'bassa';     qCls = 'bad'; }
      else if (qualityScore < 0.5) { qLbl = 'media';     qCls = 'warn'; }
      else                          { qLbl = 'buona';    qCls = 'ok'; }
      setBadge('#hQual', qLbl, qCls);
    }
    rafId = requestAnimationFrame(processFrame);
  }

  async function start() {
    setStatus('richiesta fotocamera…', 'info');
    try {
      stream = await requestCamera();
    } catch (err) {
      setStatus('permesso negato o fotocamera non disponibile', 'bad');
      return;
    }
    // <video> nascosto: serve solo come "sorgente" per drawImage.
    video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = stream;
    try { await video.play(); } catch {}

    off = document.createElement('canvas');
    off.width = PROC_W; off.height = PROC_H;
    offCtx = off.getContext('2d', { willReadFrequently: true });

    bp.reset(); peaks.reset(); rate.reset(); filtBuf.clear();
    lastTs = 0; qualityScore = 0;
    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('attivo', 'ok');
    rafId = requestAnimationFrame(processFrame);
  }

  function stop() {
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) { for (const t of stream.getTracks()) t.stop(); }
    if (video) { try { video.pause(); video.srcObject = null; } catch {} }
    stream = null; video = null; off = null; offCtx = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return { unmount() { stop(); } };
}
