// ============================================================================
// sound.js — Modulo "Ambiente sonoro".
//
// Catena Web Audio:
//   MediaStream (microfono) → MediaStreamAudioSourceNode → AnalyserNode
//   - getFloatTimeDomainData → calcolo RMS → dB relativo
//   - getByteFrequencyData   → colonna dello spettrogramma scorrevole
//
// Nota Safari iOS: AudioContext deve essere creato e usato all'interno di un
// user gesture (tap). Inoltre lo stato può tornare 'suspended' al ritorno
// in foreground: gestiamo con resume() automatico.
//
// La misura dB è RELATIVA (ref = 1.0 sull'ampiezza float -1..1). Non è
// calibrata in dB SPL: serve come confronto qualitativo, non come fonometro.
// ============================================================================

import { el, RingBuffer, fmt } from '../utils.js';
import { requestMicrophone } from '../permissions.js';

const FFT_SIZE = 1024;
const PRES_BASELINE_MS = 3000;  // tempo di calibrazione baseline
const PRES_DELTA_DB = 6;        // sopra baseline → "presenza"
const PRES_HOLD_MS = 2000;      // deve persistere almeno questo tempo

export function mount(container) {
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let stream = null;
  let active = false;
  let rafId = null;

  // Buffer per il grafico livello dB (ultimi ~8 s, ~30 fps → 240 campioni)
  const dbBuf = new RingBuffer(240);

  // Stato presence detector
  let baselineStart = 0;
  let baselineSum = 0, baselineCount = 0;
  let baselineDb = null;
  let presenceSince = 0;
  let presenceActive = false;

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Ambiente sonoro'),
    el('p', {}, "Acquisiamo il microfono via getUserMedia, calcoliamo RMS e spettro con AnalyserNode. Il valore dB è relativo (non calibrato), utile per confrontare condizioni."),
    el('p', { class: 'muted', style: 'font-size:12.5px' }, "Privacy: l'audio non viene salvato né inviato da nessuna parte; viene analizzato e scartato."),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva microfono');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'),      el('dd', { id: 'aStatus' }, '—'),
      el('dt', {}, 'Livello'),    el('dd', { id: 'aLvl' },    '— dB'),
      el('dt', {}, 'Baseline'),   el('dd', { id: 'aBase' },   '— dB'),
      el('dt', {}, 'Ambiente'),   el('dd', { id: 'aEnv' },    '—'),
      el('dt', {}, 'Presenza'),   el('dd', { id: 'aPres' },   '—'),
    ),
  );

  const dbCanvas = el('canvas', { height: 100 });
  const dbCard = el('div', { class: 'card' },
    el('h3', {}, 'Livello sonoro (dB relativo, ultimi 8 s)'),
    dbCanvas,
  );

  const specCanvas = el('canvas', { height: 180 });
  const specCard = el('div', { class: 'card' },
    el('h3', {}, 'Spettrogramma'),
    specCanvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, "Asse X: tempo (scrolling). Asse Y: frequenza (0 in basso). Colore: ampiezza."),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(dbCard);
  container.appendChild(specCard);

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
  function setStatus(s, cls = '') { setBadge('#aStatus', s, cls); }

  // ---- Spettrogramma scorrevole ----
  // Strategia: ridisegniamo a ogni frame copiando il contenuto del canvas
  // di una colonna verso sinistra, e disegniamo una nuova colonna a destra
  // con la magnitudo FFT. Su Safari iOS questo è performante perché il
  // canvas resta in GPU.
  function paintSpectrogramColumn(freqData) {
    const ctx = specCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = specCanvas.clientWidth, cssH = specCanvas.clientHeight;
    if (specCanvas.width !== cssW * dpr || specCanvas.height !== cssH * dpr) {
      specCanvas.width = cssW * dpr; specCanvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Scroll left
    ctx.drawImage(specCanvas, 0, 0, cssW, cssH, -1, 0, cssW, cssH);
    // New column on the right
    const colX = cssW - 1;
    const bins = freqData.length;
    for (let y = 0; y < cssH; y++) {
      // bin per pixel: mappiamo verticalmente con scala log per leggibilità
      const norm = 1 - (y / cssH);
      const bin = Math.floor(Math.pow(norm, 2) * bins);
      const v = freqData[bin] / 255;   // 0..1
      // colore: scuro → ciano → magenta per ampiezza crescente
      const r = Math.floor(20 + 220 * Math.pow(v, 1.5));
      const g = Math.floor(40 + 150 * v);
      const b = Math.floor(80 + 175 * (1 - Math.pow(1 - v, 2)));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(colX, y, 1, 1);
    }
  }

  function paintDbTrace() {
    const arr = dbBuf.toArray();
    const ctx = dbCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = dbCanvas.clientWidth, cssH = dbCanvas.clientHeight;
    if (dbCanvas.width !== cssW * dpr || dbCanvas.height !== cssH * dpr) {
      dbCanvas.width = cssW * dpr; dbCanvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < 4; i++) {
      const y = (cssH / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
    }
    if (arr.length < 2) return;
    // Range fisso: -80 dB → 0 dB (RMS = 1.0).
    const lo = -80, hi = 0;
    ctx.strokeStyle = '#8af0c8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = (i / (arr.length - 1)) * cssW;
      const v = Math.max(lo, Math.min(hi, arr[i]));
      const y = cssH - ((v - lo) / (hi - lo)) * cssH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ---- Loop di analisi ----
  const timeBuf = new Float32Array(FFT_SIZE);
  const freqBuf = new Uint8Array(FFT_SIZE / 2);

  function tick() {
    if (!active || !analyser) return;

    analyser.getFloatTimeDomainData(timeBuf);
    // RMS sull'ampiezza float (-1..1)
    let sumSq = 0;
    for (let i = 0; i < timeBuf.length; i++) sumSq += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sumSq / timeBuf.length);
    // dB relativi: 20 log10(rms / 1.0); evitiamo log(0).
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    dbBuf.push(db);

    analyser.getByteFrequencyData(freqBuf);
    paintSpectrogramColumn(freqBuf);
    paintDbTrace();

    // Etichetta ambiente
    let envLabel = 'silenzio', envCls = 'ok';
    if (db > -60) { envLabel = 'ambiente normale'; envCls = 'info'; }
    if (db > -35) { envLabel = 'rumoroso';        envCls = 'warn'; }
    if (db > -20) { envLabel = 'molto rumoroso';  envCls = 'bad';  }
    setText('#aLvl', fmt(db, 1) + ' dB');
    setBadge('#aEnv', envLabel, envCls);

    // Calibrazione baseline (mediamo il primo PRES_BASELINE_MS).
    const now = performance.now();
    if (baselineDb == null) {
      if (baselineStart === 0) baselineStart = now;
      baselineSum += db; baselineCount += 1;
      if (now - baselineStart >= PRES_BASELINE_MS) {
        baselineDb = baselineSum / Math.max(1, baselineCount);
      }
      setText('#aBase', baselineDb == null ? 'calibrazione…' : (fmt(baselineDb, 1) + ' dB'));
    } else {
      setText('#aBase', fmt(baselineDb, 1) + ' dB');
      // Presence detection: db > baseline + Δ per HOLD_MS continuativi.
      if (db > baselineDb + PRES_DELTA_DB) {
        if (presenceSince === 0) presenceSince = now;
        if (!presenceActive && now - presenceSince >= PRES_HOLD_MS) {
          presenceActive = true;
        }
      } else {
        presenceSince = 0;
        if (presenceActive && db < baselineDb + 2) presenceActive = false;
      }
      setBadge('#aPres', presenceActive ? 'qualcosa si muove' : 'ambiente stabile',
        presenceActive ? 'warn' : 'ok');
    }

    rafId = requestAnimationFrame(tick);
  }

  async function start() {
    setStatus('richiesta microfono…', 'info');
    try {
      stream = await requestMicrophone({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (err) {
      setStatus('permesso negato o microfono non disponibile', 'bad');
      return;
    }
    // AudioContext deve essere creato all'interno del gesto utente.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch {}
    }
    source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    // NB: non colleghiamo l'analyser a destination → nessun feedback audio.

    baselineStart = 0; baselineSum = 0; baselineCount = 0; baselineDb = null;
    presenceSince = 0; presenceActive = false;
    dbBuf.clear();
    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('attivo (calibrazione…)', 'ok');
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    try { source && source.disconnect(); } catch {}
    try { analyser && analyser.disconnect(); } catch {}
    if (stream) { for (const tr of stream.getTracks()) tr.stop(); }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
    }
    audioCtx = analyser = source = stream = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return { unmount() { stop(); } };
}
