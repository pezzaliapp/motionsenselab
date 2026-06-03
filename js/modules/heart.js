// ============================================================================
// heart.js — Modulo "Battito cardiaco" (PPG ottica).
//
// Principio (fotopletismografia): col polpastrello sulla fotocamera posteriore
// e la torcia accesa, il volume di sangue capillare modula la luce riflessa →
// il canale rosso pulsa al ritmo del cuore. Il motore PpgCapture filtra il
// segnale e ne stima la FREQUENZA per autocorrelazione (robusta al rumore),
// con una CONFIDENZA 0..1: se non c'è un vero battito periodico mostriamo "—"
// invece di un numero a caso.
//
// Misurazione indicativa, NON a uso medico.
// ============================================================================

import { el, drawTrace } from '../utils.js';
import { PpgCapture } from '../ppg.js';
import { setMetric } from '../store.js';

const CONF_SHOW = 0.40;   // confidenza minima per mostrare un numero

export function mount(container) {
  let capture = null;
  let lastBpm = 0;        // ultimo bpm mostrato (salvato allo stop)

  // ---- UI ----
  const intro = el('div', { class: 'card' },
    el('h2', {}, 'Battito cardiaco (PPG)'),
    el('p', {}, "Appoggia delicatamente il polpastrello dell'indice sulla fotocamera posteriore, coprendola del tutto, e tieni FERMO per ~20 secondi. La torcia, se disponibile, si accende da sola per un segnale più pulito."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Misurazione indicativa, non uso medico. '),
      "Per misure affidabili usa un cardiofrequenzimetro o un saturimetro. La stima compare solo quando il segnale è abbastanza periodico (vedi 'Qualità segnale')."
    ),
  );

  const startBtn = el('button', { class: 'btn', type: 'button' }, 'Attiva fotocamera');
  const stopBtn  = el('button', { class: 'btn secondary', type: 'button', disabled: true }, 'Stop');
  const torchBtn = el('button', { class: 'btn ghost hidden', type: 'button' }, '🔦 Torcia');
  const torchHint = el('p', { class: 'muted hidden', style: 'font-size:12px;margin-top:8px' },
    'Torcia non disponibile su questo dispositivo: serve buona luce ambientale e dito fermo.');
  const controls = el('div', { class: 'card' },
    el('div', { class: 'btn-row' }, startBtn, stopBtn),
    el('div', { style: 'margin-top:10px' }, torchBtn),
    torchHint,
    el('div', { class: 'kv', style: 'margin-top:12px' },
      el('dt', {}, 'Stato'),    el('dd', { id: 'hStatus' }, '—'),
      el('dt', {}, 'Dito'),     el('dd', { id: 'hLight' },  '—'),
    ),
  );

  // Indicatore "Qualità segnale" = confidenza dell'autocorrelazione (onesto).
  const qBar = el('div', { id: 'hQbar', style: 'height:100%;width:0%;border-radius:6px;background:var(--bad);transition:width .25s,background .25s' });
  const qWrap = el('div', { style: 'height:10px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden' }, qBar);
  const bpmCard = el('div', { class: 'card', style: 'text-align:center' },
    el('h3', {}, 'Frequenza cardiaca stimata'),
    el('div', { class: 'metric', style: 'justify-content:center' },
      el('span', { id: 'hBpm', style: 'font-size:64px;font-weight:700;line-height:1' }, '—'),
      el('span', { class: 'unit' }, 'bpm'),
    ),
    el('div', { style: 'margin-top:14px;text-align:left' },
      el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px;display:flex;justify-content:space-between' },
        el('span', {}, 'Qualità segnale'),
        el('span', { id: 'hQpct' }, '—'),
      ),
      qWrap,
      el('p', { id: 'hQhint', class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'Attiva la fotocamera e appoggia il dito.'),
    ),
  );

  const canvas = el('canvas', { height: 140, 'aria-label': 'Onda PPG' });
  const graphCard = el('div', { class: 'card' },
    el('h3', {}, "Forma d'onda PPG (filtrata)"),
    canvas,
    el('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, "Ogni oscillazione regolare è un battito. Se è piatta o caotica: il dito non copre bene la lente, si muove, o c'è poca luce."),
  );

  container.appendChild(intro);
  container.appendChild(controls);
  container.appendChild(bpmCard);
  container.appendChild(graphCard);

  // ---- helpers UI ----
  const setText = (sel, txt) => { const n = container.querySelector(sel); if (n) n.textContent = txt; };
  function setBadge(sel, label, cls) {
    const n = container.querySelector(sel); if (!n) return;
    n.innerHTML = ''; n.appendChild(el('span', { class: `badge ${cls}` }, label));
  }
  const setStatus = (s, cls = '') => setBadge('#hStatus', s, cls);

  // ---- Consumo dei campioni ----
  function onSample(s) {
    setBadge('#hLight', s.fingerOk ? 'rilevato' : 'posiziona il dito', s.fingerOk ? 'ok' : 'warn');
    drawTrace(canvas, capture.filtered(), { color: '#ff5b6e' });

    // Barra qualità = confidenza (0..1). Verde alta, rossa bassa.
    const conf = s.fingerOk ? (s.conf || 0) : 0;
    const pct = Math.round(conf * 100);
    const bar = container.querySelector('#hQbar');
    if (bar) {
      bar.style.width = `${Math.min(100, pct)}%`;
      bar.style.background = conf >= 0.6 ? 'var(--ok)' : conf >= CONF_SHOW ? 'var(--accent)' : 'var(--bad)';
    }
    setText('#hQpct', s.fingerOk ? `${pct}%` : '—');

    // Numero: solo con dito e confidenza sufficiente. Il bpm è già mediato/smussato
    // nel motore (aggiornato solo a confidenza decente).
    const ok = s.fingerOk && conf >= CONF_SHOW && s.bpm >= 40 && s.bpm <= 200;
    if (ok) { lastBpm = Math.round(s.bpm); setText('#hBpm', String(lastBpm)); }
    else { setText('#hBpm', '—'); }

    let hint;
    if (!s.fingerOk) hint = 'Appoggia il polpastrello e copri tutta la lente.';
    else if (conf < CONF_SHOW) hint = 'Segnale debole: tieni il dito FERMO e premi leggero, aspetta qualche secondo.';
    else if (conf < 0.6) hint = 'Segnale acquisito — resta fermo per stabilizzare la misura.';
    else hint = 'Segnale buono.';
    setText('#hQhint', hint);
  }

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

  function resetTorchUI() {
    torchBtn.classList.add('hidden'); torchBtn.classList.remove('ok'); torchHint.classList.add('hidden');
  }

  async function start() {
    setStatus('richiesta fotocamera…', 'info');
    lastBpm = 0; setText('#hBpm', '—'); setText('#hQpct', '—');
    capture = new PpgCapture(onSample, onTorch);
    try {
      await capture.start();
    } catch (err) {
      capture = null;
      setStatus('permesso negato o fotocamera non disponibile', 'bad');
      return;
    }
    startBtn.disabled = true; stopBtn.disabled = false;
    setStatus('attivo — tieni il dito fermo', 'ok');
  }

  function stop() {
    if (capture) { capture.stop(); capture = null; }
    startBtn.disabled = false; stopBtn.disabled = true;
    resetTorchUI();
    setStatus('fermo', '');
    if (lastBpm > 0) setMetric('hr', lastBpm, 'bpm');
  }

  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);
  torchBtn.addEventListener('click', () => { if (capture) capture.setTorch(!capture.torchOn); });

  return { unmount() { stop(); } };
}
