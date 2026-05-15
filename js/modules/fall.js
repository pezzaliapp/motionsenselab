// ============================================================================
// fall.js — Modulo "Caduta".
//
// Algoritmo a stati finiti:
//   IDLE      → in attesa di un impatto.
//   IMPACT    → rilevato |a| > 2.5 g; controlliamo i prossimi 1 s.
//   STILLNESS → durante l'ultimo secondo la deviazione standard di |a|
//               è stata < 0.3 g → caduta confermata.
//
// Riferimenti:
//   - Bourke et al. "Threshold-based fall detection algorithm" (2008).
//   - Il pattern caratteristico è: free-fall (|a|≈0g) → impatto (|a|>2g)
//     → immobilità (deviazione bassa intorno a 1g).
//
// Su iOS DeviceMotionEvent.accelerationIncludingGravity è in m/s²; convertiamo
// in g (1 g = 9.81 m/s²) per lavorare con soglie naturali.
//
// AVVISO MEDICO: questo NON sostituisce un dispositivo certificato.
// ============================================================================

import { el, RingBuffer, fmt, vibrate, toast, drawTrace } from '../utils.js';
import { requestMotionPermission } from '../permissions.js';

const G = 9.81;
const PEAK_G = 2.5;                  // soglia picco totale (in g)
const STILLNESS_G = 0.3;             // deviazione std massima in fase ferma
const STILLNESS_MS = 1000;           // durata richiesta di immobilità
const COOLDOWN_MS = 4000;            // dead-time post-evento per non duplicare

export function mount(container) {
  let active = false;
  let handler = null;

  // Buffer scrollante per il grafico (ultimi ~8 s a 60 Hz).
  const magBuf = new RingBuffer(60 * 8);

  // Stato FSM
  let state = 'IDLE';                // 'IDLE' | 'IMPACT'
  let impactTs = 0;                  // quando è scattato l'impatto
  let lastEventTs = 0;
  const stillWindow = new RingBuffer(60);   // ~1 s di campioni per la std

  const events = [];                 // cronologia eventi sessione

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Rilevamento cadute'),
    el('p', {}, "Cerchiamo un pattern tipico: un picco di accelerazione totale > 2.5 g seguito da almeno un secondo di quasi-immobilità (std < 0.3 g). È l'impronta classica di una caduta — impatto e poi corpo a terra."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Questo non sostituisce un dispositivo medico di rilevamento cadute. '),
      "L'algoritmo è dimostrativo: può generare falsi positivi (telefono lanciato sul divano) e falsi negativi (cadute lente)."
    ),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Inizia monitoraggio');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'), el('dd', { id: 'fStatus' }, '—'),
      el('dt', {}, '|a|'),   el('dd', { id: 'fMag' },    '—'),
      el('dt', {}, 'σ |a|'), el('dd', { id: 'fStd' },    '—'),
    ),
  );

  const canvas = el('canvas', { height: 160 });
  const graph = el('div', { class: 'card' },
    el('h3', {}, 'Accelerazione totale (g)'),
    canvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, '1 g è la gravità (telefono fermo). Le righe orizzontali a 2.5 g segnano la soglia di impatto.'),
  );

  const list = el('ul', { class: 'events', id: 'fEvents' });
  const log = el('div', { class: 'card' },
    el('h3', {}, 'Eventi rilevati in questa sessione'),
    list,
    el('p', { class: 'muted', id: 'fEmpty' }, 'Nessuna caduta rilevata.'),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(graph);
  container.appendChild(log);

  // ---- Logica ----
  function setText(sel, txt) {
    const n = container.querySelector(sel);
    if (n) n.textContent = txt;
  }
  function setStatus(s, badgeClass = '') {
    const n = container.querySelector('#fStatus');
    if (!n) return;
    n.innerHTML = '';
    n.appendChild(el('span', { class: `badge ${badgeClass}` }, s));
  }

  function pushEvent(ts) {
    events.unshift(ts);
    const empty = container.querySelector('#fEmpty');
    if (empty) empty.classList.add('hidden');
    list.innerHTML = '';
    for (const t of events.slice(0, 30)) {
      const d = new Date(t);
      const hhmmss = d.toLocaleTimeString();
      list.appendChild(el('li', {}, `⚠ ${hhmmss}`));
    }
  }

  function onMotion(ev) {
    const a = ev.accelerationIncludingGravity || {};
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) / G;   // in g
    const ts = performance.now();
    magBuf.push(mag);
    stillWindow.push(mag);

    const std = stillWindow.std();
    setText('#fMag', fmt(mag, 2) + ' g');
    setText('#fStd', fmt(std, 3) + ' g');

    // FSM
    if (state === 'IDLE') {
      if (mag > PEAK_G && ts - lastEventTs > COOLDOWN_MS) {
        state = 'IMPACT';
        impactTs = ts;
        setStatus('impatto rilevato — verifica immobilità…', 'warn');
      }
    } else if (state === 'IMPACT') {
      const elapsed = ts - impactTs;
      if (elapsed >= STILLNESS_MS) {
        // Valutazione: l'ultimo secondo deve essere "fermo".
        if (std < STILLNESS_G) {
          // Caduta confermata
          pushEvent(Date.now());
          vibrate([200, 80, 200, 80, 400]);
          toast('Possibile caduta rilevata');
          setStatus('caduta rilevata', 'bad');
          lastEventTs = ts;
          state = 'IDLE';
        } else {
          // Non è stato un evento di caduta: il telefono si è rimesso in moto.
          state = 'IDLE';
          setStatus('attivo (falso allarme scartato)', 'info');
        }
      }
    }
  }

  // Render del canvas a 30 fps (RAF) per non saturare la CPU.
  let rafId = null;
  let lastDraw = 0;
  function loop(ts) {
    if (!active) return;
    if (ts - lastDraw > 33) {
      drawTrace(canvas, magBuf.toArray(), { color: '#ff5b6e', min: 0, max: 4 });
      // disegniamo le linee di soglia sopra
      const ctx = canvas.getContext('2d');
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.strokeStyle = 'rgba(255,181,71,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const yThresh = h - (PEAK_G / 4) * h;
      ctx.moveTo(0, yThresh); ctx.lineTo(w, yThresh); ctx.stroke();
      ctx.setLineDash([]);
      lastDraw = ts;
    }
    rafId = requestAnimationFrame(loop);
  }

  async function start() {
    setStatus('richiesta permessi…', 'info');
    const r = await requestMotionPermission();
    if (r !== 'granted') {
      setStatus('permesso negato', 'bad');
      return;
    }
    state = 'IDLE'; magBuf.clear(); stillWindow.clear();
    handler = onMotion;
    window.addEventListener('devicemotion', handler);
    active = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('monitoraggio attivo', 'ok');
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    active = false;
    if (handler) window.removeEventListener('devicemotion', handler);
    handler = null;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('fermo', '');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  return { unmount() { stop(); } };
}
