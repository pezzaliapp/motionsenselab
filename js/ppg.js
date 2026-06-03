// ============================================================================
// ppg.js — motore di cattura PPG condiviso (fotopletismografia da fotocamera).
//
// Estrae la pipeline che prima viveva dentro heart.js, così sia il modulo
// "Battito" sia il modulo "Stress (HRV)" usano la STESSA acquisizione senza
// duplicarla. La pipeline è invariata rispetto a heart.js:
//   1) video → drawImage su canvas off-screen 160×120
//   2) media del canale rosso su ROI centrale 80×80
//   3) passa-banda 0.7–4 Hz (42–240 bpm)
//   4) peak detector adattivo (refrattarietà 280 ms) → intervalli battito (≈RR)
//   5) stima di qualità grossolana (ampiezza del filtrato)
//
// Il consumatore riceve, per ogni frame, un oggetto sample con il risultato
// (filt, fingerOk, quality, isPeak, intervalMs) e decide cosa farne:
//   - heart.js  → RateEstimator → bpm
//   - stress.js → serie di RR → HRV (RMSSD) → indice di stress
//
// Limiti dichiarati (come in heart.js): su iOS la torcia non è accessibile da
// PWA, serve buona luce ambientale e dito FERMO sulla lente.
// ============================================================================

import { RingBuffer, BandPass, PeakDetector } from './utils.js';
import { requestCamera } from './permissions.js';

const ROI_SIZE = 80;              // ROI 80×80 al centro del frame
const PROC_W = 160, PROC_H = 120; // canvas off-screen
const WINDOW_S = 8;
const SAMPLE_HZ = 30;             // frame rate video tipico

export class PpgCapture {
  // onSample(sample) viene chiamato a ogni frame con il dito plausibile o no.
  constructor(onSample) {
    this.onSample = onSample;
    this.stream = null;
    this.video = null;
    this.off = null;
    this.offCtx = null;
    this.active = false;
    this.rafId = null;
    this.lastTs = 0;

    // Banda PPG 0.7–4 Hz; refrattarietà 280 ms ≈ max 214 bpm.
    this.bp = new BandPass(0.7, 4.0);
    this.peaks = new PeakDetector({ minIntervalMs: 280, k: 0.5 });
    this.filtBuf = new RingBuffer(SAMPLE_HZ * WINDOW_S);
    this.quality = 0;
  }

  // Buffer del segnale filtrato (per il grafico live nel consumatore).
  filtered() { return this.filtBuf.toArray(); }

  async start() {
    this.stream = await requestCamera();   // può rilanciare: gestito dal chiamante
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    try { await video.play(); } catch {}
    this.video = video;

    this.off = document.createElement('canvas');
    this.off.width = PROC_W; this.off.height = PROC_H;
    this.offCtx = this.off.getContext('2d', { willReadFrequently: true });

    this.bp.reset(); this.peaks.reset(); this.filtBuf.clear();
    this.lastTs = 0; this.quality = 0;
    this.active = true;
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _loop() {
    if (!this.active) return;
    const video = this.video;
    if (video && video.readyState >= 2) {
      this.offCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
      const sx = (PROC_W - ROI_SIZE) >> 1;
      const sy = (PROC_H - ROI_SIZE) >> 1;
      const img = this.offCtx.getImageData(sx, sy, ROI_SIZE, ROI_SIZE).data;

      let sumR = 0, sumG = 0, sumB = 0;
      const n = ROI_SIZE * ROI_SIZE;
      for (let i = 0; i < img.length; i += 4) {
        sumR += img[i]; sumG += img[i + 1]; sumB += img[i + 2];
      }
      const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;

      // Dito ben appoggiato: il rosso domina su verde/blu.
      const fingerOk = meanR > 60 && meanR > meanG * 1.2 && meanR > meanB * 1.2;

      const now = performance.now();
      const dt = this.lastTs ? (now - this.lastTs) / 1000 : 1 / SAMPLE_HZ;
      this.lastTs = now;

      const filt = this.bp.step(meanR, dt);
      this.filtBuf.push(filt);

      // Qualità ≈ ampiezza del filtrato (std), normalizzata in 0..1.
      const arr = this.filtBuf.toArray();
      if (arr.length > 30) {
        let mean = 0; for (let i = 0; i < arr.length; i++) mean += arr[i]; mean /= arr.length;
        let varr = 0; for (let i = 0; i < arr.length; i++) varr += (arr[i] - mean) * (arr[i] - mean);
        varr /= arr.length;
        this.quality = Math.min(1, Math.sqrt(varr) / 2);
      }

      let isPeak = false, intervalMs = 0;
      if (fingerOk) {
        const r = this.peaks.step(filt, now);
        isPeak = r.isPeak; intervalMs = r.intervalMs;
      } else {
        this.peaks.reset();
      }

      if (this.onSample) {
        this.onSample({ meanR, meanG, meanB, fingerOk, filt, quality: this.quality, isPeak, intervalMs, ts: now });
      }
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  stop() {
    this.active = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    if (this.video) { try { this.video.pause(); this.video.srcObject = null; } catch {} }
    this.stream = null; this.video = null; this.off = null; this.offCtx = null;
  }
}
