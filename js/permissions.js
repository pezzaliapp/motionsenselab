// ============================================================================
// permissions.js — wrapper per i permessi sensori, con stato osservabile.
//
// Su iOS 13+, DeviceMotionEvent.requestPermission() / DeviceOrientationEvent.
// requestPermission() ESISTONO ma DEVONO essere invocate da un user gesture
// (tap), altrimenti vengono rifiutate silenziosamente. Per questo motivo
// l'app NON chiede nulla all'avvio: ogni modulo offre un pulsante "Attiva".
// ============================================================================

// Stato cache dei permessi (in memoria, non persistito: vogliamo che a ogni
// avvio l'utente confermi consapevolmente cosa attivare).
const state = {
  motion: 'unknown',   // 'granted' | 'denied' | 'unknown'
  mic:    'unknown',
  camera: 'unknown',
};

const listeners = new Set();
function emit() { for (const fn of listeners) try { fn({ ...state }); } catch {} }
export function onPermissionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getPermissions() { return { ...state }; }

// ---------------------------------------------------------------------------
// DeviceMotion / DeviceOrientation — sensori inerziali (accelerometro + gyro).
// ---------------------------------------------------------------------------
export async function requestMotionPermission() {
  // iOS 13+: la classe è DeviceMotionEvent e ha un metodo statico requestPermission.
  // Su altri browser (Android Chrome, desktop) l'evento è già accessibile.
  if (typeof DeviceMotionEvent === 'undefined') {
    state.motion = 'denied'; emit();
    return 'denied';
  }
  const needsExplicit = typeof DeviceMotionEvent.requestPermission === 'function';
  if (!needsExplicit) {
    state.motion = 'granted'; emit();
    return 'granted';
  }
  try {
    const res = await DeviceMotionEvent.requestPermission();
    // res può essere 'granted' o 'denied'
    state.motion = res === 'granted' ? 'granted' : 'denied';
    // Se disponibile, richiediamo anche orientation (per il cubo 3D).
    if (state.motion === 'granted' && typeof DeviceOrientationEvent !== 'undefined'
        && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { await DeviceOrientationEvent.requestPermission(); } catch {}
    }
    emit();
    return state.motion;
  } catch (err) {
    // Tipicamente succede quando la chiamata non parte da un gesto utente.
    state.motion = 'denied'; emit();
    return 'denied';
  }
}

// ---------------------------------------------------------------------------
// Microfono — getUserMedia({ audio: true }).
// Restituisce lo stream così il modulo può collegarlo a un AudioContext.
// ---------------------------------------------------------------------------
export async function requestMicrophone(constraints = { audio: true, video: false }) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.mic = 'denied'; emit();
    throw new Error('getUserMedia non supportato in questo browser.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.mic = 'granted'; emit();
    return stream;
  } catch (err) {
    state.mic = 'denied'; emit();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fotocamera — getUserMedia({ video: { facingMode: 'environment' } }).
// Usiamo posteriore per il PPG (polpastrello sulla lente). Su iOS è OK in PWA.
// Nota: la torcia non è accessibile da PWA su iOS (track.applyConstraints
// con torch fallisce); per questo il modulo PPG funziona con luce ambientale.
// ---------------------------------------------------------------------------
export async function requestCamera(constraints) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.camera = 'denied'; emit();
    throw new Error('getUserMedia non supportato in questo browser.');
  }
  const c = constraints || {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width:  { ideal: 320 },
      height: { ideal: 240 },
      frameRate: { ideal: 30, max: 30 },
    },
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(c);
    state.camera = 'granted'; emit();
    return stream;
  } catch (err) {
    state.camera = 'denied'; emit();
    throw err;
  }
}
