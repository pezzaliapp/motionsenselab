// ============================================================================
// gauge.js — anello/gauge circolare riutilizzabile, stile "smartwatch".
//
// Vanilla canvas, DPR-aware (come drawTrace in utils.js). Disegna un arco di
// 270° (apertura in basso) con traccia di fondo + arco di valore colorato, e
// un grande numero al centro. Usato dal modulo Stress e dagli anelli Salute.
//
//   drawGauge(canvas, value, {
//     min, max,          // dominio del valore (default 0..100)
//     color,             // colore arco; se assente usa colorForStress(value)
//     track,             // colore traccia di fondo
//     label,             // testo piccolo sopra il numero (es. "STRESS")
//     sub,               // testo piccolo sotto il numero (es. "Moderato")
//     unit,              // unità a fianco del numero (es. "/100")
//     value as string?   // se value non è finito → mostra "—"
//   })
//
// Le funzioni qui sono pure rispetto allo stato (ridisegnano tutto il canvas).
// Nessuna dipendenza esterna; i colori replicano i token di css/style.css
// perché il canvas non legge le variabili CSS.
// ============================================================================

import { clamp, lerp } from './utils.js';

// Token replicati da css/style.css (il canvas non ha accesso alle CSS vars).
const C = {
  ok:    [0x6e, 0xe8, 0x95], // --ok
  warn:  [0xff, 0xb5, 0x47], // --warn
  bad:   [0xff, 0x5b, 0x6e], // --bad
  accent:[0x5a, 0xd1, 0xff], // --accent
  track: '#243049',          // --line
  dim:   '#9aa6bd',          // --text-dim
  text:  '#e8edf5',          // --text
};

const TAU = Math.PI * 2;
const START = Math.PI * 0.75;   // 135° → parte in basso a sinistra
const SWEEP = Math.PI * 1.5;    // 270° di arco utile

function rgb([r, g, b]) { return `rgb(${r | 0}, ${g | 0}, ${b | 0})`; }

// Colore per un indice 0..100: verde (ok) → giallo (warn) → rosso (bad).
// Mappa "più alto = peggio", coerente con l'indice di stress.
export function colorForStress(v) {
  const t = clamp(v, 0, 100) / 100;
  let a, b, k;
  if (t < 0.5) { a = C.ok;  b = C.warn; k = t / 0.5; }
  else         { a = C.warn; b = C.bad; k = (t - 0.5) / 0.5; }
  return rgb([lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]);
}

export function drawGauge(canvas, value, opts = {}) {
  const {
    min = 0, max = 100,
    color, track = C.track,
    label = '', sub = '', unit = '',
  } = opts;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cx = cssW / 2;
  const cy = cssH / 2 + cssH * 0.04;          // leggermente più in basso: l'apertura è sotto
  const r = Math.min(cssW, cssH) / 2 - Math.max(10, cssW * 0.06);
  const lw = Math.max(8, r * 0.16);

  const hasValue = Number.isFinite(value);
  const frac = hasValue ? clamp((value - min) / (max - min), 0, 1) : 0;
  const arcColor = color || colorForStress(((value - min) / (max - min)) * 100);

  // Traccia di fondo (arco completo 270°).
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = track;
  ctx.beginPath();
  ctx.arc(cx, cy, r, START, START + SWEEP);
  ctx.stroke();

  // Arco di valore.
  if (hasValue && frac > 0) {
    ctx.strokeStyle = arcColor;
    ctx.beginPath();
    ctx.arc(cx, cy, r, START, START + SWEEP * frac);
    ctx.stroke();
  }

  // Etichetta superiore (piccola, in maiuscolo).
  if (label) {
    ctx.fillStyle = C.dim;
    ctx.font = `600 ${Math.max(10, r * 0.16)}px var(--mono), ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label.toUpperCase(), cx, cy - r * 0.34);
  }

  // Numero grande al centro (o "—" se non disponibile).
  const numTxt = hasValue ? String(Math.round(value)) : '—';
  ctx.fillStyle = hasValue ? C.text : C.dim;
  const numSize = r * 0.62;
  ctx.font = `700 ${numSize}px var(--mono), ui-monospace, monospace`;
  ctx.textAlign = unit ? 'right' : 'center';
  ctx.textBaseline = 'middle';
  const numX = unit ? cx + r * 0.04 : cx;
  ctx.fillText(numTxt, numX, cy + r * 0.05);

  // Unità a fianco del numero.
  if (unit && hasValue) {
    ctx.fillStyle = C.dim;
    ctx.font = `500 ${r * 0.2}px var(--mono), ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(unit, cx + r * 0.08, cy + r * 0.05);
  }

  // Sottotitolo (es. "Moderato").
  if (sub) {
    ctx.fillStyle = arcColor;
    ctx.font = `600 ${Math.max(11, r * 0.18)}px var(--mono), ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(sub, cx, cy + r * 0.46);
  }
}
