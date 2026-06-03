// ============================================================================
// ppg.js — motore di cattura PPG (fotopletismografia da fotocamera).
//
// Riscrittura completa, robusta al rumore. Differenze chiave rispetto al primo
// approccio "conta i picchi" (fragile sul segnale reale, frastagliato):
//
//  1) CAMPIONAMENTO PULITO: usa requestVideoFrameCallback (un callback per
//     fotogramma video reale) invece di requestAnimationFrame. Su display
//     ProMotion (120 Hz) rAF girava 4× più veloce dei 30 fps del video e
//     rielaborava lo STESSO frame → gradini nel filtro → onda frastagliata.
//     Fallback: rAF con throttle a ~30 Hz dove rVFC non c'è.
//
//  2) STIMA BPM PER AUTOCORRELAZIONE: la frequenza si stima trovando la
//     periodicità dominante del segnale filtrato su una finestra di ~8 s, non
//     contando i singoli picchi. Il rumore si de-correla → è molto più robusto.
//     Si prende il PRIMO massimo locale "forte" dell'autocorrelazione (la
//     fondamentale), evitando gli errori di ottava (mezzo/doppio bpm).
//     L'altezza del picco di autocorrelazione è una CONFIDENZA onesta (0..1):
//     se non c'è un vero battito periodico resta bassa → la UI mostra "—".
//
//  3) Mantiene un peak detector per gli intervalli RR, usati dal modulo Stress
//     (HRV): l'autocorrelazione dà la frequenza, non i singoli RR.
//
// Validato in simulazione su PPG realistico (48–135 bpm) con rumore forte,
// deriva respiratoria e ampiezza variabile: la frequenza torna corretta e la
// confidenza distingue il segnale vero dal rumore. Va comunque provato sul
// device — la simulazione non sostituisce la prova reale.
// ============================================================================

import { RingBuffer, BandPass, PeakDetector } from './utils.js';
import { requestCamera } from './permissions.js';

const ROI_SIZE = 80;               // ROI 80×80 al centro del frame
const PROC_W = 160, PROC_H = 120;  // canvas off-screen
const WINDOW_S = 8;                // finestra per l'autocorrelazione
const TARGET_HZ = 30;              // frame rate video tipico
const EST_EVERY_MS = 400;          // ogni quanto ricalcolare la stima
const HR_MIN = 40, HR_MAX = 180;   // banda fisiologica ammessa

export class PpgCapture {
  // onSample(sample): chiamato a ogni frame con
  //   { meanR, meanG, meanB, fingerOk, filt, quality, isPeak, intervalMs,
  //     bpm, conf, fps, ts }
  //   - bpm/conf: frequenza stimata (autocorrelazione) e confidenza 0..1 → heart.js
  //   - isPeak/intervalMs: battiti per gli RR → stress.js
  // onTorch({available, on}): stato torcia (toggle in UI solo dove esposta).
  constructor(onSample, onTorch) {
    this.onSample = onSample;
    this.onTorch = onTorch;
    this.stream = null; this.video = null; this.track = null;
    this.off = null; this.offCtx = null;
    this.active = false;
    this.rafId = null;
    this.lastTs = 0;
    this._lastProc = 0;            // throttle del fallback rAF
    this._lastEst = 0;

    // Torcia (iOS 17+/Android via track constraints, se getCapabilities la espone)
    this.torchAvailable = false; this.torchOn = false; this._torchTimer = null;
    this.ppgConstraintsApplied = null; this._ppgTimer = null;

    // Banda PPG 0.7–3.5 Hz (≈42–210 bpm): più larga in basso per non perdere il
    // fondamentale a riposo, low-pass a 3.5 per togliere rumore alto.
    this.bp = new BandPass(0.7, 3.5);
    // Peak detector (solo per gli RR di Stress): soglia su inviluppo normalizzato.
    this.peaks = new PeakDetector({
      minIntervalMs: 350,
      envelope: { thr: 0.5, reArm: -0.25, aEnv: 0.04, minEnv: 0.08, aSmooth: 0.5 },
    });

    this.filtBuf = new RingBuffer(TARGET_HZ * WINDOW_S);  // grafico live
    this.win = [];                // { v, t } finestra mobile per l'autocorrelazione
    this.quality = 0;
    this.fingerLost = 0;
    this.fingerWas = false;

    this.bpm = 0;                 // bpm visualizzato (mediana + smoothing)
    this.conf = 0;                // confidenza 0..1 dell'ultima stima
    this.fps = TARGET_HZ;
    this.bpmHist = [];            // ultime stime accettate (mediana anti-glitch)
    this.bpmSmooth = 0;
  }

  filtered() { return this.filtBuf.toArray(); }

  async start() {
    this.stream = await requestCamera();
    this.track = this.stream.getVideoTracks()[0] || null;

    // Fotocamera posteriore di DEFAULT (la principale): è co-locata con il LED/
    // torcia, quindi col dito a contatto è quella illuminata correttamente. NON
    // forziamo l'ultra-grandangolo (lontano dalla torcia → dito mal illuminato).
    const video = document.createElement('video');
    video.playsInline = true; video.muted = true; video.autoplay = true;
    video.srcObject = this.stream;
    try { await video.play(); } catch {}
    this.video = video;

    this.off = document.createElement('canvas');
    this.off.width = PROC_W; this.off.height = PROC_H;
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true });

    this.bp.reset(); this.peaks.reset(); this.filtBuf.clear();
    this.win = []; this.bpmHist = []; this.bpmSmooth = 0; this.bpm = 0; this.conf = 0;
    this.lastTs = 0; this._lastProc = 0; this._lastEst = 0;
    this.quality = 0; this.fingerLost = 0; this.fingerWas = false;
    this.active = true;

    this._startSampling();

    // Torcia: rileva e accendi (getUserMedia la resetta a OFF → accendi DOPO).
    this._detectTorch();
    if (this.torchAvailable) this.setTorch(true);

    // Blocca l'AWB (e prova il fuoco ravvicinato) dopo che torcia/esposizione si
    // assestano: l'auto-white-balance altrimenti "insegue" la pulsazione e la
    // attenua. Ogni constraint applicato singolarmente, fallback onesto.
    this._ppgTimer = setTimeout(() => {
      this._ppgTimer = null;
      if (this.active) this._applyPpgConstraints();
    }, 600);
  }

  // Campionamento: un frame video reale per callback (rVFC) → niente duplicati.
  _startSampling() {
    const v = this.video;
    if (v && typeof v.requestVideoFrameCallback === 'function') {
      const cb = () => { if (!this.active) return; this._frame(); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      const loop = () => {
        if (!this.active) return;
        this.rafId = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - this._lastProc < 30) return;   // throttle ~30 Hz (anti frame duplicati)
        this._lastProc = now;
        this._frame();
      };
      this.rafId = requestAnimationFrame(loop);
    }
  }

  _frame() {
    const video = this.video;
    if (!video || video.readyState < 2) return;
    this.offCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
    const sx = (PROC_W - ROI_SIZE) >> 1, sy = (PROC_H - ROI_SIZE) >> 1;
    const img = this.offCtx.getImageData(sx, sy, ROI_SIZE, ROI_SIZE).data;

    let sumR = 0, sumG = 0, sumB = 0, satCount = 0;
    const n = ROI_SIZE * ROI_SIZE;
    for (let i = 0; i < img.length; i += 4) {
      const R = img[i];
      sumR += R; sumG += img[i + 1]; sumB += img[i + 2];
      if (R >= 250) satCount++;
    }
    const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
    const satPct = satCount / n;

    // Dito appoggiato (rosso domina) con ISTERESI anti-sfarfallio: una volta
    // agganciato si mantiene con soglie più morbide, così la pulsazione stessa
    // non lo fa "perdere" per qualche frame.
    const acquire  = meanR > 55 && meanR > meanG * 1.15 && meanR > meanB * 1.15;
    const maintain = meanR > 45 && meanR > meanG * 1.05 && meanR > meanB * 1.05;
    const fingerOk = this.fingerWas ? maintain : acquire;
    this.fingerWas = fingerOk;

    const now = performance.now();
    const dt = this.lastTs ? (now - this.lastTs) / 1000 : 1 / TARGET_HZ;
    this.lastTs = now;

    const filt = this.bp.step(meanR, dt);
    this.filtBuf.push(filt);

    // Qualità grezza ≈ ampiezza del filtrato (per il gate RR di Stress).
    const arr = this.filtBuf.toArray();
    if (arr.length > 30) {
      let mean = 0; for (let i = 0; i < arr.length; i++) mean += arr[i]; mean /= arr.length;
      let varr = 0; for (let i = 0; i < arr.length; i++) varr += (arr[i] - mean) * (arr[i] - mean);
      this.quality = Math.min(1, Math.sqrt(varr / arr.length) / 2);
    }

    // RR per Stress (peak detector). Reset solo dopo perdita SOSTENUTA del dito.
    let isPeak = false, intervalMs = 0;
    if (fingerOk) {
      this.fingerLost = 0;
      const r = this.peaks.step(filt, now);
      isPeak = r.isPeak; intervalMs = r.intervalMs;
      this.win.push({ v: filt, t: now });
    } else {
      if (++this.fingerLost > 20) { this.peaks.reset(); this.win = []; this.bpm = 0; this.conf = 0; this.bpmHist = []; this.bpmSmooth = 0; }
    }

    // Finestra mobile di ~WINDOW_S secondi per l'autocorrelazione.
    const cutoff = now - WINDOW_S * 1000;
    while (this.win.length && this.win[0].t < cutoff) this.win.shift();

    // Stima periodica della frequenza.
    if (fingerOk && now - this._lastEst > EST_EVERY_MS) {
      this._lastEst = now;
      this._estimate();
    }

    if (this.onSample) {
      this.onSample({
        meanR, meanG, meanB, satPct, fingerOk, filt, quality: this.quality,
        isPeak, intervalMs, bpm: this.bpmSmooth, conf: this.conf, fps: this.fps, ts: now,
      });
    }
  }

  // Stima della frequenza per autocorrelazione del segnale filtrato sulla
  // finestra mobile. Ritorna periodicità dominante (bpm) e confidenza (0..1).
  _estimate() {
    const w = this.win;
    const N = w.length;
    if (N < TARGET_HZ * 3) { this.conf = 0; return; }   // servono ≥3 s

    const dur = (w[N - 1].t - w[0].t) / 1000;
    if (dur <= 0) { this.conf = 0; return; }
    const fps = (N - 1) / dur;
    this.fps = fps;

    // Centra e calcola la varianza.
    const y = new Float64Array(N);
    let mean = 0; for (let i = 0; i < N; i++) { y[i] = w[i].v; mean += y[i]; } mean /= N;
    let varr = 0; for (let i = 0; i < N; i++) { y[i] -= mean; varr += y[i] * y[i]; } varr /= N;
    if (varr < 1e-9) { this.conf = 0; return; }

    const minLag = Math.max(2, Math.floor(fps * 60 / HR_MAX));
    const maxLag = Math.min(N - 2, Math.ceil(fps * 60 / HR_MIN));
    if (maxLag <= minLag + 1) { this.conf = 0; return; }

    // Autocorrelazione NON distorta (media sull'overlap / varianza), precalcolata.
    const ac = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      if (lag < 1) continue;
      let s = 0; const m = N - lag;
      for (let i = 0; i < m; i++) s += y[i] * y[i + lag];
      ac[lag] = (s / m) / varr;
    }

    // Massimi locali; la fondamentale è il massimo locale a lag più CORTO la cui
    // forza è ≥ 60% del massimo (evita di agganciare 2×periodo → bpm dimezzato).
    let maxR = -Infinity; const locals = [];
    for (let lag = minLag + 1; lag <= maxLag - 1; lag++) {
      const r = ac[lag];
      if (r > ac[lag - 1] && r >= ac[lag + 1]) { locals.push(lag); if (r > maxR) maxR = r; }
    }
    if (!locals.length || maxR <= 0) { this.conf = 0; return; }
    let fund = locals[0];
    for (const lag of locals) { if (ac[lag] >= 0.6 * maxR) { fund = lag; break; } }

    // Interpolazione parabolica per il sub-campione.
    const r0 = ac[fund - 1], r1 = ac[fund], r2 = ac[fund + 1];
    let lag = fund; const den = r0 - 2 * r1 + r2; if (den < 0) lag = fund + 0.5 * (r0 - r2) / den;
    const bpm = 60 * fps / lag;
    const conf = Math.max(0, Math.min(1, r1));
    this.conf = conf;
    if (bpm < HR_MIN || bpm > HR_MAX) return;
    this.bpm = bpm;

    // Smoothing temporale: mediana delle ultime stime (anti-glitch d'ottava) +
    // EMA. Si aggiorna solo con confidenza decente, così un colpo di rumore non
    // sposta il numero mostrato.
    if (conf >= 0.45) {
      this.bpmHist.push(bpm);
      if (this.bpmHist.length > 5) this.bpmHist.shift();
      const sorted = [...this.bpmHist].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      this.bpmSmooth = this.bpmSmooth ? this.bpmSmooth * 0.7 + med * 0.3 : med;
    }
  }

  // ---- Torcia ----
  _detectTorch() {
    let caps = {};
    try { caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch { caps = {}; }
    this.torchAvailable = !!caps.torch;
    if (this.onTorch) this.onTorch({ available: this.torchAvailable, on: this.torchOn });
    if (!this.torchAvailable && !this._torchTimer) {
      this._torchTimer = setTimeout(() => {
        this._torchTimer = null;
        if (!this.active) return;
        try { caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch { caps = {}; }
        const was = this.torchAvailable;
        this.torchAvailable = !!caps.torch;
        if (this.torchAvailable && !was) this.setTorch(true);
        else if (this.onTorch) this.onTorch({ available: this.torchAvailable, on: this.torchOn });
      }, 500);
    }
  }

  async setTorch(on) {
    if (!this.track || !this.torchAvailable) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      if (this.onTorch) this.onTorch({ available: true, on: this.torchOn });
      return true;
    } catch { return false; }
  }

  // Blocca l'AWB su 'manual' e, se esposto, forza il fuoco ravvicinato. Ogni
  // constraint da solo: un rifiuto non blocca gli altri (fallback onesto).
  async _applyPpgConstraints() {
    if (!this.track) return;
    let caps = {};
    try { caps = this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch {}
    const tries = [];
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual')) {
      tries.push({ whiteBalanceMode: 'manual' });
    }
    if (caps.focusDistance && typeof caps.focusDistance.min === 'number') {
      const fd = Math.max(caps.focusDistance.min, Math.min(0.05, caps.focusDistance.max ?? 0.05));
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('manual')) tries.push({ focusMode: 'manual', focusDistance: fd });
      else tries.push({ focusDistance: fd });
    }
    const applied = {};
    for (const c of tries) {
      try { await this.track.applyConstraints({ advanced: [c] }); Object.assign(applied, c); } catch {}
    }
    this.ppgConstraintsApplied = applied;
  }

  stop() {
    this.active = false;
    if (this._torchTimer) { clearTimeout(this._torchTimer); this._torchTimer = null; }
    if (this._ppgTimer) { clearTimeout(this._ppgTimer); this._ppgTimer = null; }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.track && this.torchOn) { try { this.track.applyConstraints({ advanced: [{ torch: false }] }); } catch {} }
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    if (this.video) { try { this.video.pause(); this.video.srcObject = null; } catch {} }
    this.stream = null; this.video = null; this.track = null; this.off = null; this.offCtx = null;
    this.torchAvailable = false; this.torchOn = false;
  }
}
