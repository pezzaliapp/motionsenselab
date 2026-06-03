// ============================================================================
// ppg.js — motore di cattura PPG condiviso (fotopletismografia da fotocamera).
//
// Estrae la pipeline che prima viveva dentro heart.js, così sia il modulo
// "Battito" sia il modulo "Stress (HRV)" usano la STESSA acquisizione senza
// duplicarla. La pipeline è invariata rispetto a heart.js:
//   1) video → drawImage su canvas off-screen 160×120
//   2) media del canale rosso su ROI centrale 80×80
//   3) passa-banda 0.9–4 Hz (≈54–240 bpm)
//   4) peak detector adattivo (refrattarietà 300 ms + isteresi) → RR (≈battiti)
//   5) stima di qualità grossolana (ampiezza del filtrato)
//
// Il consumatore riceve, per ogni frame, un oggetto sample con il risultato
// (filt, fingerOk, quality, isPeak, intervalMs) e decide cosa farne:
//   - heart.js  → RateEstimator → bpm
//   - stress.js → serie di RR → HRV (RMSSD) → indice di stress
//
// Torcia: da iOS 17+ (e Android Chrome) è controllabile via track constraints
// se getCapabilities() espone 'torch' — vedi setTorch()/_detectTorch(). Dove
// non è esposta (iOS ≤16, fotocamera senza flash) si ricade su buona luce
// ambientale. In ogni caso serve il dito FERMO sulla lente.
// ============================================================================

import { RingBuffer, BandPass, PeakDetector } from './utils.js';
import { requestCamera } from './permissions.js';

const ROI_SIZE = 80;              // ROI 80×80 al centro del frame
const PROC_W = 160, PROC_H = 120; // canvas off-screen
const WINDOW_S = 8;
const SAMPLE_HZ = 30;             // frame rate video tipico

export class PpgCapture {
  // onSample(sample) viene chiamato a ogni frame con il dito plausibile o no.
  // onTorch({available, on}) (opzionale) notifica lo stato della torcia: il
  // modulo lo usa per mostrare il toggle solo dove la torcia è davvero esposta.
  constructor(onSample, onTorch, onDiag) {
    this.onSample = onSample;
    this.onTorch = onTorch;
    // onDiag(info) (opzionale, read-only): sonda diagnostica chiamata una volta
    // a start() con { settings, capabilities, videoInputs }. Serve a verificare
    // sul device reale QUALE lente viene aperta e se 'torch' è esposto, senza
    // alterare in nulla la pipeline di cattura.
    this.onDiag = onDiag;
    this.stream = null;
    this.video = null;
    this.track = null;
    this.off = null;
    this.offCtx = null;
    this.active = false;
    this.rafId = null;
    this.lastTs = 0;

    // Torcia: controllabile da iOS 17+ e Android Chrome via track constraints,
    // ma SOLO se getCapabilities() espone 'torch' (camera posteriore con flash).
    this.torchAvailable = false;
    this.torchOn = false;
    this._torchTimer = null;

    // Lente + constraints PPG (vedi start / _maybeSwitchToUltraWide /
    // _applyPpgConstraints): su iPhone la lente giusta per il contatto è
    // l'ULTRA-GRANDANGOLO posteriore (fuoco ravvicinato), e l'AWB va bloccato.
    this.lensSwitched = false;          // true se abbiamo ri-aperto l'ultra-wide
    this.ppgConstraintsApplied = null;  // { whiteBalanceMode?, focusDistance?, ... }
    this._ppgConstraintsTimer = null;

    // Banda PPG 0.9–4 Hz; refrattarietà 300 ms ≈ max 200 bpm + isteresi
    // (vedi PeakDetector): un picco per ciclo, niente doppio conteggio dicrota.
    // High-pass alzato 0.7→0.9 Hz: attenua la deriva lenta (respiro/movimento,
    // ondulazioni ~1 Hz) che sollevava la baseline e faceva perdere battiti.
    // Pavimento ~0.9 Hz ≈ 54 bpm: la componente cardiaca sotto i 54 bpm viene
    // attenuata — accettabile per misure a riposo (a riposo si sta sopra),
    // sotto i 54 bpm il bpm va considerato inaffidabile.
    this.bp = new BandPass(0.9, 4.0);
    this.peaks = new PeakDetector({ minIntervalMs: 300, k: 0.5 });
    this.filtBuf = new RingBuffer(SAMPLE_HZ * WINDOW_S);
    this.quality = 0;
  }

  // Buffer del segnale filtrato (per il grafico live nel consumatore).
  filtered() { return this.filtBuf.toArray(); }

  async start() {
    this.lensSwitched = false;
    this.ppgConstraintsApplied = null;
    this.stream = await requestCamera();   // può rilanciare: gestito dal chiamante
    this.track = this.stream.getVideoTracks()[0] || null;

    // Lente giusta per il PPG a contatto: l'ULTRA-GRANDANGOLO posteriore ha
    // fuoco ravvicinato, mentre la wide/tele standard col dito a contatto
    // (focusDistance min ~0.02) è quasi sempre fuori fuoco. enumerateDevices
    // espone le label solo DOPO il primo getUserMedia (permesso appena
    // concesso qui sopra), quindi solo ora possiamo individuarla e ri-aprirla.
    await this._maybeSwitchToUltraWide();

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

    // Torcia: rileva e, se disponibile, accendi (getUserMedia l'ha appena
    // resettata a OFF — va accesa DOPO sulla traccia live).
    this._detectTorch();
    if (this.torchAvailable) this.setTorch(true);

    // Blocca l'AWB (whiteBalanceMode 'manual') e, se possibile, forza il fuoco
    // ravvicinato. L'auto-white-balance/auto-exposure altrimenti "inseguono" la
    // pulsazione e ne cancellano la AC (causa probabile del bpm dimezzato e
    // dell'onda sbavata). Lo facciamo DOPO che torcia ed esposizione si sono
    // assestate (~600 ms), così congeliamo lo stato giusto. Ogni constraint è
    // applicato singolarmente con fallback onesto se rifiutato.
    this._ppgConstraintsTimer = setTimeout(() => {
      this._ppgConstraintsTimer = null;
      if (this.active) this._applyPpgConstraints();
    }, 600);

    // Sonda diagnostica read-only (solo se richiesta dal consumatore).
    if (this.onDiag) this._collectDiagnostics();
  }

  // Cerca la lente ultra-grandangolo posteriore tra le camere esposte e, se
  // trovata e diversa da quella attuale, ri-apre lo stream su quel deviceId.
  // Fallback onesto: se non c'è o getUserMedia la rifiuta, resta sulla lente
  // corrente. Usa getUserMedia diretto (non requestCamera) per non sporcare lo
  // stato 'camera' dei permessi in caso di rifiuto non fatale.
  async _maybeSwitchToUltraWide() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const uw = devs.find(d =>
      d.kind === 'videoinput' && d.deviceId &&
      /ultra|grandangol/i.test(d.label) &&
      /posterior|back|rear|environment/i.test(d.label));
    if (!uw) return;                                    // niente ultra-wide: resta com'è
    let cur = null;
    try { cur = this.track && this.track.getSettings ? this.track.getSettings().deviceId : null; } catch {}
    if (cur && cur === uw.deviceId) return;             // già su quella lente
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: uw.deviceId },
          width:  { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      for (const t of this.stream.getTracks()) t.stop();   // chiudi la vecchia lente
      this.stream = newStream;
      this.track = newStream.getVideoTracks()[0] || this.track;
      this.lensSwitched = true;
    } catch {
      // rifiutata: teniamo lo stream attuale (fallback onesto)
    }
  }

  // Applica i constraint utili al PPG: blocca l'AWB su 'manual' (congela il
  // bilanciamento del bianco) e, se esposto, forza focusDistance al ravvicinato.
  // Ogni constraint è applicato da solo: se uno è rifiutato, gli altri reggono.
  // Registra cosa è andato a buon fine per la diagnostica.
  async _applyPpgConstraints() {
    if (!this.track) return;
    let caps = {};
    try { caps = this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch {}
    const tries = [];
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual')) {
      tries.push({ whiteBalanceMode: 'manual' });
    }
    if (caps.focusDistance && typeof caps.focusDistance.min === 'number') {
      // fuoco ravvicinato per il dito a contatto: vicino al minimo (~0.02–0.05)
      const fd = Math.max(caps.focusDistance.min, Math.min(0.05, caps.focusDistance.max ?? 0.05));
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('manual')) {
        tries.push({ focusMode: 'manual', focusDistance: fd });
      } else {
        tries.push({ focusDistance: fd });   // alcune implementazioni l'accettano senza focusMode
      }
    }
    const applied = {};
    for (const c of tries) {
      try { await this.track.applyConstraints({ advanced: [c] }); Object.assign(applied, c); }
      catch { /* fallback onesto: lascia il default per questo constraint */ }
    }
    this.ppgConstraintsApplied = applied;
    // Ri-leggi la diagnostica così l'utente vede lente + settings DOPO le modifiche.
    if (this.active && this.onDiag) this._collectDiagnostics();
  }

  // Read-only: NON cambia la cattura. Riporta cosa sta realmente usando la
  // traccia (settings: deviceId/width/height/frameRate, facingMode se esposto),
  // cosa dichiara capace (capabilities: torch? zoom? facingMode?) e l'elenco
  // delle camere posteriori viste da enumerateDevices (label + deviceId), così
  // si può capire QUALE lente è attiva e dove sta rispetto al LED.
  async _collectDiagnostics() {
    let settings = {}, capabilities = {};
    try { settings = this.track && this.track.getSettings ? this.track.getSettings() : {}; } catch {}
    try { capabilities = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch {}
    let videoInputs = [];
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      videoInputs = devs
        .filter(d => d.kind === 'videoinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }));
    } catch {}
    if (!this.active) return;            // l'utente può aver già fermato
    // Quale lente è realmente aperta (match deviceId → label) e cosa abbiamo
    // bloccato: serve a verificare che sia l'ultra-grandangolo e che l'AWB lock
    // sia passato.
    let activeLabel = null;
    try {
      const did = settings && settings.deviceId;
      const hit = did && videoInputs.find(v => v.deviceId === did);
      activeLabel = hit ? hit.label : null;
    } catch {}
    // Sintesi read-only dei controlli che CONTANO per l'AGC/AWB/AF: diciamo
    // esplicitamente quali sono esposti e se ammettono 'manual'/un range, così
    // i prossimi commit (lock esposizione/WB/focus) sono mirati, non a tentativi.
    const c = capabilities || {};
    const controls = {
      exposureMode:         c.exposureMode || null,          // es. ['continuous','manual']
      focusMode:            c.focusMode || null,             // es. ['continuous','manual']
      whiteBalanceMode:     c.whiteBalanceMode || null,      // es. ['continuous','manual']
      exposureCompensation: c.exposureCompensation || null,  // {min,max,step}
      focusDistance:        c.focusDistance || null,         // {min,max,step}
      zoom:                 c.zoom || null,                  // {min,max,step}
    };
    if (this.onDiag) this.onDiag({
      settings, capabilities, videoInputs, controls,
      activeLabel,
      lensSwitched: this.lensSwitched,
      ppgConstraintsApplied: this.ppgConstraintsApplied,
    });
  }

  // Legge getCapabilities() sulla traccia live. Su alcuni device le capabilities
  // si popolano con lieve ritardo → un singolo re-check dopo 500 ms.
  _detectTorch() {
    let caps = {};
    try { caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}; }
    catch { caps = {}; }
    this.torchAvailable = !!caps.torch;
    if (this.onTorch) this.onTorch({ available: this.torchAvailable, on: this.torchOn });
    if (!this.torchAvailable && !this._torchTimer) {
      this._torchTimer = setTimeout(() => {
        this._torchTimer = null;
        if (!this.active) return;
        try { caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch { caps = {}; }
        const was = this.torchAvailable;
        this.torchAvailable = !!caps.torch;
        if (this.torchAvailable && !was) {
          this.setTorch(true);                       // accendi appena diventa disponibile
        } else if (this.onTorch) {
          this.onTorch({ available: this.torchAvailable, on: this.torchOn });
        }
      }, 500);
    }
  }

  // Accende/spegne la torcia. Ritorna true se applicato. No-op onesto quando
  // 'torch' non è esposto (iOS ≤16, fotocamera senza flash, browser non supportati).
  async setTorch(on) {
    if (!this.track || !this.torchAvailable) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      if (this.onTorch) this.onTorch({ available: true, on: this.torchOn });
      return true;
    } catch {
      return false;
    }
  }

  _loop() {
    if (!this.active) return;
    const video = this.video;
    if (video && video.readyState >= 2) {
      this.offCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
      const sx = (PROC_W - ROI_SIZE) >> 1;
      const sy = (PROC_H - ROI_SIZE) >> 1;
      const img = this.offCtx.getImageData(sx, sy, ROI_SIZE, ROI_SIZE).data;

      let sumR = 0, sumG = 0, sumB = 0, satCount = 0;
      const n = ROI_SIZE * ROI_SIZE;
      for (let i = 0; i < img.length; i += 4) {
        const R = img[i];
        sumR += R; sumG += img[i + 1]; sumB += img[i + 2];
        if (R >= 250) satCount++;        // diagnostica: pixel col rosso a fondo scala (clipping)
      }
      const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
      const satPct = satCount / n;       // 0..1: frazione della ROI col rosso saturo

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
        this.onSample({ meanR, meanG, meanB, satPct, fingerOk, filt, quality: this.quality, isPeak, intervalMs, ts: now });
      }
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  stop() {
    this.active = false;
    if (this._torchTimer) { clearTimeout(this._torchTimer); this._torchTimer = null; }
    if (this._ppgConstraintsTimer) { clearTimeout(this._ppgConstraintsTimer); this._ppgConstraintsTimer = null; }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    // Spegni esplicitamente la torcia prima di chiudere (track.stop() la spegne
    // comunque, ma essere espliciti evita flash "appesi" su alcuni device).
    if (this.track && this.torchOn) { try { this.track.applyConstraints({ advanced: [{ torch: false }] }); } catch {} }
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    if (this.video) { try { this.video.pause(); this.video.srcObject = null; } catch {} }
    this.stream = null; this.video = null; this.track = null; this.off = null; this.offCtx = null;
    this.torchAvailable = false; this.torchOn = false;
    this.lensSwitched = false; this.ppgConstraintsApplied = null;
  }
}
