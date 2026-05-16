// ============================================================================
// sound.js — Modulo "Ambiente sonoro".
//
// Catena Web Audio:
//   MediaStream (microfono) → MediaStreamAudioSourceNode → AnalyserNode
//   - getFloatTimeDomainData → calcolo RMS → dB relativo (grafico livello)
//   - getByteFrequencyData   → colonna dello spettrogramma scorrevole
//
// Note Safari iOS (PWA standalone):
//   - AudioContext deve essere creato e usato all'interno di un user gesture
//     (tap). Lo stato può tornare 'suspended' al ritorno in foreground:
//     gestiamo con resume() automatico.
//   - Un <canvas> dimensionato solo via CSS resta completamente trasparente
//     (apparire "nero" sullo sfondo dark): bisogna SEMPRE settare canvas.width
//     e canvas.height in pixel reali (cssW * devicePixelRatio).
//   - drawImage di un canvas su sé stesso ("self-blit") con regioni che si
//     sovrappongono può renderizzare nero su WebKit iOS: il driver GPU non
//     garantisce la lettura prima della scrittura. Per lo spettrogramma
//     scorrevole usiamo una coppia di canvas off-screen in ping-pong: ogni
//     frame copiamo il contenuto da src→dst shiftato di 1 px (drawImage tra
//     canvas diversi è ben definito), disegniamo la nuova colonna su dst,
//     poi blittiamo dst sul canvas visibile. Niente self-blit.
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
const ZERO_FREQ_WARN_MS = 1000; // soglia diagnostica freq-tutta-zero

export function mount(container) {
  let audioCtx = null;
  let analyser = null;
  let source = null;
  let stream = null;
  let active = false;

  // RAF handles separati: uno per il grafico del livello dB, uno per lo
  // spettrogramma. Vengono entrambi cancellati in stop()/unmount() per
  // evitare leak; durante l'uso del modulo entrambi girano in parallelo.
  let dbRafId = null;
  let specRafId = null;

  // Buffer per il grafico livello dB (ultimi ~8 s, ~30 fps → 240 campioni)
  const dbBuf = new RingBuffer(240);

  // Stato presence detector
  let baselineStart = 0;
  let baselineSum = 0, baselineCount = 0;
  let baselineDb = null;
  let presenceSince = 0;
  let presenceActive = false;

  // Ping-pong di buffer off-screen per lo spettrogramma. Dimensioni in pixel
  // reali (allineate al device pixel ratio). Ricreati al primo paint e ad
  // ogni resize/orientation change.
  let specBufA = null;
  let specBufB = null;
  let specCurrent = null;

  // Diagnostica: timestamp dell'ultimo campione freq con almeno un valore !=0
  // mentre lo stream è attivo. Se restiamo a zero >ZERO_FREQ_WARN_MS, log.
  let lastNonZeroFreqTs = 0;
  let zeroFreqWarned = false;

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

  // Height esplicito in CSS: il canvas è un elemento "replaced", la sua
  // dimensione CSS intrinseca riflette l'attributo height. Senza un height
  // CSS fisso, ogni "canvas.height = cssH*dpr" propagherebbe al layout e
  // farebbe crescere il canvas frame dopo frame (cssH cresce → buffer cresce).
  const dbCanvas = el('canvas', { style: 'height:100px' });
  const dbCard = el('div', { class: 'card' },
    el('h3', {}, 'Livello sonoro (dB relativo, ultimi 8 s)'),
    dbCanvas,
  );

  const specCanvas = el('canvas', { style: 'height:180px' });
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

  // Allinea il buffer (canvas.width/height in pixel reali) al box CSS attuale.
  // Su Safari iOS è OBBLIGATORIO settare width/height >0, altrimenti il
  // canvas resta vuoto. Ritorna true se le dimensioni sono cambiate.
  function syncCanvasPixelSize(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const pxW = Math.max(1, Math.round(rect.width * dpr));
    const pxH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
      return true;
    }
    return false;
  }

  function ensureSpecBuffers(pxW, pxH) {
    if (specBufA && specBufA.width === pxW && specBufA.height === pxH) return;
    specBufA = document.createElement('canvas');
    specBufA.width = pxW; specBufA.height = pxH;
    specBufB = document.createElement('canvas');
    specBufB.width = pxW; specBufB.height = pxH;
    specCurrent = specBufA;
  }

  // ---- Spettrogramma scorrevole (ping-pong di buffer off-screen) ----
  // Strategia: ogni frame il contenuto "vecchio" (src) viene copiato sul
  // buffer "dst" shiftato di 1 px a sinistra; src e dst sono canvas distinti
  // → niente self-blit (su WebKit iOS si rischia rendering nero). Disegniamo
  // poi la nuova colonna sull'ultimo pixel di destra di dst e blittiamo dst
  // sul canvas visibile.
  function paintSpectrogramColumn(freqData) {
    syncCanvasPixelSize(specCanvas);
    const pxW = specCanvas.width;
    const pxH = specCanvas.height;
    if (pxW < 2 || pxH < 2) return;
    ensureSpecBuffers(pxW, pxH);

    const src = specCurrent;
    const dst = (src === specBufA) ? specBufB : specBufA;
    const dctx = dst.getContext('2d');
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, pxW, pxH);
    // Shift left di 1 pixel reale (drawImage cross-canvas: safe su iOS).
    dctx.drawImage(src, -1, 0);

    // Nuova colonna sul bordo destro in pixel reali. Mappiamo l'asse Y con
    // scala quadratica per dare più risoluzione alle frequenze basse.
    const colX = pxW - 1;
    const bins = freqData.length;
    for (let py = 0; py < pxH; py++) {
      const norm = 1 - (py / pxH);
      const bin = Math.min(bins - 1, Math.floor(Math.pow(norm, 2) * bins));
      const v = freqData[bin] / 255; // 0..1
      // Palette: scuro → ciano → magenta. Anche v=0 produce un grigio
      // bluastro tenue (rgb(20,40,80)) ben visibile sullo sfondo #07090f,
      // così il canvas non risulta "nero" anche in silenzio.
      const r = Math.floor(20 + 220 * Math.pow(v, 1.5));
      const g = Math.floor(40 + 150 * v);
      const b = Math.floor(80 + 175 * (1 - Math.pow(1 - v, 2)));
      dctx.fillStyle = `rgb(${r},${g},${b})`;
      dctx.fillRect(colX, py, 1, 1);
    }

    // Blit del buffer corrente sul canvas visibile (cross-canvas, safe).
    const vctx = specCanvas.getContext('2d');
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, pxW, pxH);
    vctx.drawImage(dst, 0, 0);

    specCurrent = dst;
  }

  function paintDbTrace() {
    syncCanvasPixelSize(dbCanvas);
    const ctx = dbCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = dbCanvas.width / dpr;
    const cssH = dbCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < 4; i++) {
      const y = (cssH / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
    }
    const arr = dbBuf.toArray();
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

  // ---- Loop livello dB (grafico, baseline, presence detector) ----
  const timeBuf = new Float32Array(FFT_SIZE);
  const freqBuf = new Uint8Array(FFT_SIZE / 2);

  function tickDb() {
    if (!active || !analyser) return;

    analyser.getFloatTimeDomainData(timeBuf);
    let sumSq = 0;
    for (let i = 0; i < timeBuf.length; i++) sumSq += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sumSq / timeBuf.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    dbBuf.push(db);
    paintDbTrace();

    let envLabel = 'silenzio', envCls = 'ok';
    if (db > -60) { envLabel = 'ambiente normale'; envCls = 'info'; }
    if (db > -35) { envLabel = 'rumoroso';        envCls = 'warn'; }
    if (db > -20) { envLabel = 'molto rumoroso';  envCls = 'bad';  }
    setText('#aLvl', fmt(db, 1) + ' dB');
    setBadge('#aEnv', envLabel, envCls);

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
      if (db > baselineDb + PRES_DELTA_DB) {
        if (presenceSince === 0) presenceSince = now;
        if (!presenceActive && now - presenceSince >= PRES_HOLD_MS) presenceActive = true;
      } else {
        presenceSince = 0;
        if (presenceActive && db < baselineDb + 2) presenceActive = false;
      }
      setBadge('#aPres', presenceActive ? 'qualcosa si muove' : 'ambiente stabile',
        presenceActive ? 'warn' : 'ok');
    }

    dbRafId = requestAnimationFrame(tickDb);
  }

  // ---- Loop spettrogramma (RAF separato, indipendente dal grafico dB) ----
  function tickSpec() {
    if (!active || !analyser) return;
    analyser.getByteFrequencyData(freqBuf);

    // Diagnostica: se >1s di freq tutte a zero mentre lo stream gira,
    // qualcosa nella catena audio non sta producendo dati (permessi
    // negati silenziosamente, AudioContext suspended dopo background,
    // analyser non collegato...).
    let anyNonZero = false;
    for (let i = 0; i < freqBuf.length; i++) {
      if (freqBuf[i] !== 0) { anyNonZero = true; break; }
    }
    const now = performance.now();
    if (anyNonZero) {
      lastNonZeroFreqTs = now;
      zeroFreqWarned = false;
    } else if (!zeroFreqWarned && lastNonZeroFreqTs > 0
               && now - lastNonZeroFreqTs > ZERO_FREQ_WARN_MS) {
      console.warn('[sound] AnalyserNode restituisce dati di frequenza tutti a zero da >1s mentre lo stream microfono è attivo. AudioContext.state =',
        audioCtx && audioCtx.state, '— verifica catena source→analyser e permessi.');
      zeroFreqWarned = true;
      // Tentativo di recovery: se il context è suspended (es. dopo
      // ritorno da background su iOS), proviamo a riprenderlo.
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }

    paintSpectrogramColumn(freqBuf);
    specRafId = requestAnimationFrame(tickSpec);
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

    // Reset diagnostica: lasciamo lastNonZeroFreqTs=now così il warn parte
    // solo dopo ZERO_FREQ_WARN_MS effettivi di silenzio anomalo.
    lastNonZeroFreqTs = performance.now();
    zeroFreqWarned = false;

    // Buffer spettrogramma: ricreati al primo paint (dimensioni dipendono
    // dal layout corrente, che potrebbe non essere ancora stabile).
    specBufA = specBufB = specCurrent = null;

    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('attivo (calibrazione…)', 'ok');
    dbRafId = requestAnimationFrame(tickDb);
    specRafId = requestAnimationFrame(tickSpec);
  }

  function stop() {
    active = false;
    if (dbRafId)   cancelAnimationFrame(dbRafId);
    if (specRafId) cancelAnimationFrame(specRafId);
    dbRafId = specRafId = null;
    try { source && source.disconnect(); } catch {}
    try { analyser && analyser.disconnect(); } catch {}
    if (stream) { for (const tr of stream.getTracks()) tr.stop(); }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
    }
    audioCtx = analyser = source = stream = null;
    specBufA = specBufB = specCurrent = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
  }

  // Resize / rotazione: riallinea il buffer del canvas livello al nuovo box
  // CSS. Per lo spettrogramma resettiamo i buffer off-screen: ricreati al
  // prossimo paint con le nuove dimensioni (perdiamo la storia scrollata,
  // ma evitiamo artefatti di stretching).
  function onResize() {
    if (!active) return;
    syncCanvasPixelSize(dbCanvas);
    if (syncCanvasPixelSize(specCanvas)) {
      specBufA = specBufB = specCurrent = null;
    }
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return {
    unmount() {
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    }
  };
}
