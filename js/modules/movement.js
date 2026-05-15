// ============================================================================
// movement.js — Modulo "Movimento".
//
// Mostra in tempo reale:
//   - accelerazione lineare X/Y/Z (m/s², senza gravità se disponibile)
//   - velocità angolare X/Y/Z (rad/s) da giroscopio
//   - magnitudo dell'accelerazione meno gravità
//   - grafico live degli ultimi 10 s della magnitudo
//   - cubo 3D che si orienta con DeviceOrientation
//
// API usate:
//   - DeviceMotionEvent: accelerometro + gyro (campionato a ~50-60 Hz su iOS)
//   - DeviceOrientationEvent: alpha (yaw), beta (pitch), gamma (roll)
//
// Permessi: su iOS 13+ servono `requestPermission()` da un tap utente.
// ============================================================================

import { el, fmt, RingBuffer, drawTrace } from '../utils.js';
import { requestMotionPermission } from '../permissions.js';

// Frequenza tipica DeviceMotion su iOS ≈ 60 Hz → 10 s ≈ 600 campioni.
const SAMPLE_HZ = 60;
const WINDOW_S = 10;

export function mount(container) {
  // Stato del modulo
  let active = false;
  let motionHandler = null;
  let orientHandler = null;
  let rafId = null;

  // Buffer per il grafico
  const magBuf = new RingBuffer(SAMPLE_HZ * WINDOW_S);

  // Snapshot ultimi valori per il rendering throttled
  let last = { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0, mag: 0 };
  let orient = { alpha: 0, beta: 0, gamma: 0 };

  // ---- UI ----
  const info = el('div', { class: 'card' },
    el('h2', {}, 'Movimento'),
    el('p', {}, 'Accelerometro e giroscopio del telefono in tempo reale. La magnitudo è |a| − 9.81 m/s², cioè quanto il telefono accelera oltre la gravità.'),
    el('p', { class: 'muted', style: 'font-size:12.5px' }, 'Permessi richiesti: DeviceMotion (al tap su "Attiva").'),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva sensori');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'), el('dd', { id: 'mvStatus' }, '—'),
      el('dt', {}, 'Magn.'), el('dd', { id: 'mvMagState' }, '—'),
    ),
  );

  const values = el('div', { class: 'card' },
    el('h3', {}, 'Valori live'),
    el('div', { class: 'kv' },
      el('dt', {}, 'a.x'), el('dd', { id: 'ax' }, '—'),
      el('dt', {}, 'a.y'), el('dd', { id: 'ay' }, '—'),
      el('dt', {}, 'a.z'), el('dd', { id: 'az' }, '—'),
      el('dt', {}, 'ω.x'), el('dd', { id: 'gx' }, '—'),
      el('dt', {}, 'ω.y'), el('dd', { id: 'gy' }, '—'),
      el('dt', {}, 'ω.z'), el('dd', { id: 'gz' }, '—'),
      el('dt', {}, '|a|−g'), el('dd', { id: 'mag' }, '—'),
    ),
  );

  const canvas = el('canvas', { height: 160, 'aria-label': 'Grafico magnitudo ultimi 10 secondi' });
  const graph = el('div', { class: 'card' },
    el('h3', {}, 'Magnitudo accelerazione (ultimi 10 s)'),
    canvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Asse Y: m/s² oltre la gravità. Le oscillazioni rappresentano i movimenti del telefono.'),
  );

  const cube = el('div', { class: 'cube' },
    el('div', { class: 'face f-front' }, 'F'),
    el('div', { class: 'face f-back' },  'B'),
    el('div', { class: 'face f-right' }, 'R'),
    el('div', { class: 'face f-left' },  'L'),
    el('div', { class: 'face f-top' },   'T'),
    el('div', { class: 'face f-bottom' },'D'),
  );
  const cubeBox = el('div', { class: 'card' },
    el('h3', {}, 'Orientamento (DeviceOrientation)'),
    el('div', { class: 'scene' }, cube),
    el('p', { class: 'muted', style: 'font-size:12px;text-align:center' }, 'Inclina e ruota il telefono: il blocco segue l\'orientamento.'),
  );

  container.appendChild(info);
  container.appendChild(controls);
  container.appendChild(values);
  container.appendChild(graph);
  container.appendChild(cubeBox);

  // ---- Helpers UI ----
  const setText = (sel, txt) => { const n = container.querySelector(sel); if (n) n.textContent = txt; };

  function setStatus(s, badgeClass = '') {
    const n = container.querySelector('#mvStatus');
    if (!n) return;
    n.innerHTML = '';
    n.appendChild(el('span', { class: `badge ${badgeClass}` }, s));
  }

  function classifyMag(mag) {
    // |a|-g ≈ 0 quando fermo; piccoli movimenti < 2 m/s²; ampi > 5 m/s².
    const abs = Math.abs(mag);
    if (abs < 0.5)  return { label: 'fermo', cls: 'ok' };
    if (abs < 2.5)  return { label: 'piccolo movimento', cls: 'info' };
    if (abs < 5.0)  return { label: 'movimento', cls: 'warn' };
    return { label: 'movimento ampio', cls: 'bad' };
  }

  // ---- Handlers eventi ----
  function onMotion(ev) {
    // DeviceMotionEvent fornisce:
    //   acceleration: senza gravità (può essere null su alcuni device)
    //   accelerationIncludingGravity: con gravità (sempre disponibile)
    //   rotationRate: velocità angolare in deg/s (iOS) o rad/s (varia)
    const a  = ev.acceleration || {};
    const aG = ev.accelerationIncludingGravity || {};
    const r  = ev.rotationRate || {};

    const ax = a.x ?? 0, ay = a.y ?? 0, az = a.z ?? 0;
    // Magnitudo tolta la gravità: usiamo accelerationIncludingGravity per
    // calcolare |a| e poi sottraiamo 9.81. Questo è più stabile che usare
    // direttamente acceleration.x/y/z, che su alcuni device è rumorosa.
    const magG = Math.hypot(aG.x ?? 0, aG.y ?? 0, aG.z ?? 0);
    const mag  = magG - 9.81;

    last = { ax, ay, az, gx: r.alpha ?? 0, gy: r.beta ?? 0, gz: r.gamma ?? 0, mag };
    magBuf.push(mag);
  }

  function onOrient(ev) {
    orient = { alpha: ev.alpha || 0, beta: ev.beta || 0, gamma: ev.gamma || 0 };
  }

  // ---- Loop rendering (RAF disaccoppia event rate da paint rate) ----
  function render() {
    setText('#ax', fmt(last.ax) + ' m/s²');
    setText('#ay', fmt(last.ay) + ' m/s²');
    setText('#az', fmt(last.az) + ' m/s²');
    setText('#gx', fmt(last.gx) + ' °/s');
    setText('#gy', fmt(last.gy) + ' °/s');
    setText('#gz', fmt(last.gz) + ' °/s');
    setText('#mag', fmt(last.mag) + ' m/s²');

    const cls = classifyMag(last.mag);
    const magState = container.querySelector('#mvMagState');
    if (magState) {
      magState.innerHTML = '';
      magState.appendChild(el('span', { class: `badge ${cls.cls}` }, cls.label));
    }

    // Grafico magnitudo. Range fisso ±8 m/s² per stabilità visiva.
    drawTrace(canvas, magBuf.toArray(), { color: '#5ad1ff', min: -8, max: 8 });

    // Cubo: pitch = beta, roll = gamma, yaw = alpha. (Convenzione W3C.)
    cube.style.transform = `rotateX(${orient.beta}deg) rotateY(${orient.gamma}deg) rotateZ(${-orient.alpha}deg)`;

    if (active) rafId = requestAnimationFrame(render);
  }

  // ---- Avvio / stop ----
  async function start() {
    setStatus('richiesta permessi…', 'info');
    const r = await requestMotionPermission();
    if (r !== 'granted') {
      setStatus('permesso negato', 'bad');
      return;
    }
    // Aggancio listener
    motionHandler = onMotion;
    orientHandler = onOrient;
    window.addEventListener('devicemotion', motionHandler);
    window.addEventListener('deviceorientation', orientHandler);
    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('attivo', 'ok');
    rafId = requestAnimationFrame(render);
  }

  function stop() {
    active = false;
    if (motionHandler) window.removeEventListener('devicemotion', motionHandler);
    if (orientHandler) window.removeEventListener('deviceorientation', orientHandler);
    motionHandler = orientHandler = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    magBuf.clear();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return { unmount() { stop(); } };
}
