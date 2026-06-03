// ============================================================================
// dashboard.js — schermata Home con introduzione, stato permessi e moduli.
// ============================================================================

import { el } from '../utils.js';
import { onPermissionChange, getPermissions } from '../permissions.js';
import { drawGauge } from '../gauge.js';
import { getMetric, ageLabel } from '../store.js';

const MODULES = [
  { route: 'movement', icon: '↻', title: 'Movimento',       desc: 'Accelerazione, rotazione, orientamento del telefono.' },
  { route: 'fall',     icon: '!', title: 'Caduta',          desc: 'Rileva pattern di caduta da accelerometro.' },
  { route: 'steps',    icon: '≋', title: 'Passi e attività',desc: 'Conta passi e classifica camminata / corsa.' },
  { route: 'sound',    icon: '♪', title: 'Ambiente sonoro', desc: 'Livello dB, spettro, presenza sonora.' },
  { route: 'heart',    icon: '♥', title: 'Battito',         desc: 'PPG dal polpastrello sulla fotocamera.' },
  { route: 'stress',   icon: '◐', title: 'Stress (HRV)',    desc: 'Indice indicativo dalla variabilità cardiaca.' },
  { route: 'breath',   icon: '∿', title: 'Respiro',         desc: 'Atti/min con telefono sul petto.' },
  { route: 'info',     icon: 'i', title: 'Come funziona',   desc: 'Spiegazione fisica + limiti e privacy.' },
];

// Anelli salute: SOLO metriche reali. Ognuno mostra l'ULTIMO valore misurato
// (vedi store.js) — non è live e non è clinico. `color: null` → colorForStress.
const RINGS = [
  { key: 'hr',     route: 'heart',  label: 'Battito', unit: 'bpm',  min: 40, max: 180,  color: '#ff5b6e' },
  { key: 'breath', route: 'breath', label: 'Respiro', unit: '/min', min: 5,  max: 30,   color: '#8af0c8' },
  { key: 'stress', route: 'stress', label: 'Stress',  unit: '/100', min: 0,  max: 100,  color: null },
  { key: 'steps',  route: 'steps',  label: 'Passi',   unit: '',     min: 0,  max: 5000, color: '#5ad1ff' },
];

function permissionRow(label, key, state) {
  const v = state[key] || 'unknown';
  const cls = v === 'granted' ? 'ok' : v === 'denied' ? 'bad' : 'unk';
  const text = v === 'granted' ? 'concesso' : v === 'denied' ? 'negato' : 'non chiesto';
  return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--line)' },
    el('span', {}, label),
    el('span', { class: 'muted', style: 'font-family:var(--mono);font-size:13px' },
      el('span', { class: `status-dot ${cls}` }),
      text
    )
  );
}

// Costruisce la card "anelli salute" e disegna i gauge con gli ultimi valori.
function buildRings() {
  const grid = el('div', { class: 'rings' });
  const canvases = [];
  for (const r of RINGS) {
    const canvas = el('canvas', { class: 'gauge', role: 'img' });
    const age = el('div', { class: 'ring-age' });
    const cell = el('a', {
      class: 'card ring', href: `#${r.route}`,
      style: 'color:inherit;text-decoration:none',
    }, canvas, age);
    grid.appendChild(cell);
    canvases.push({ r, canvas, age });
  }

  const card = el('div', { class: 'card' },
    el('h3', {}, 'Anelli salute'),
    el('p', { class: 'muted', style: 'font-size:12.5px;margin-top:-4px' },
      'Ultimi valori misurati su questo dispositivo. Non sono live (i sensori non girano insieme) né clinici: tocca un anello per misurare.'),
    grid,
  );

  function render() {
    for (const { r, canvas, age } of canvases) {
      const m = getMetric(r.key);
      const value = m ? m.value : NaN;
      canvas.setAttribute('aria-label',
        `${r.label}: ${m ? m.value + (r.unit ? ' ' + r.unit : '') : 'non misurato'}`);
      drawGauge(canvas, value, {
        min: r.min, max: r.max, color: r.color || undefined,
        label: r.label, unit: r.unit,
      });
      age.textContent = m ? ageLabel(m.ts) : 'mai';
    }
  }
  // I canvas hanno dimensione solo dopo il layout: disegna al frame successivo.
  requestAnimationFrame(render);
  return { card, render };
}

export function mount(container) {
  const rings = buildRings();

  const intro = el('div', { class: 'card' },
    el('h2', {}, 'I sensori che hai già in tasca'),
    el('p', {}, "Motion Sense Lab è una PWA dimostrativa: usa accelerometro, giroscopio, microfono e fotocamera del telefono per rilevare movimento, presenza, respiro, battito e cadute. È il complemento pratico di WiFi Sense Lab — qui la fisica è reale, non simulata."),
    el('p', {}, "Tutti i dati restano sul tuo dispositivo. Niente upload, niente login, niente tracciamento. Ogni modulo chiede il permesso solo quando lo attivi."),
    el('div', { class: 'warning' },
      el('strong', {}, 'Non è un dispositivo medico. '),
      'Le misure di battito e respiro sono indicative, ottenute con sensori non calibrati. Non usarle per diagnosi.'
    ),
  );

  const permsBox = el('div', { class: 'card' },
    el('h3', {}, 'Stato permessi sensori'),
    el('p', {}, 'Aggiornato all\'ultimo tentativo nel modulo corrispondente.'),
    el('div', { id: 'permRows' }),
  );

  function renderPerms() {
    const state = getPermissions();
    const rows = permsBox.querySelector('#permRows');
    rows.innerHTML = '';
    rows.appendChild(permissionRow('Accelerometro / Giroscopio (DeviceMotion)', 'motion', state));
    rows.appendChild(permissionRow('Microfono (getUserMedia audio)', 'mic', state));
    rows.appendChild(permissionRow('Fotocamera (getUserMedia video)', 'camera', state));
  }
  renderPerms();
  const off = onPermissionChange(renderPerms);

  const grid = el('div', { class: 'grid section' });
  for (const m of MODULES) {
    const card = el('a', { class: 'card', href: `#${m.route}`, role: 'link', style: 'display:block;color:inherit;text-decoration:none' },
      el('span', { class: 'ico' }, m.icon),
      el('h3', {}, m.title),
      el('p', {}, m.desc),
    );
    grid.appendChild(card);
  }

  const tips = el('div', { class: 'card' },
    el('h3', {}, 'Suggerimenti'),
    el('p', {}, "Su iPhone, installa l'app dalla condivisione di Safari (Aggiungi alla schermata Home) per avere fullscreen, icona dedicata e funzionamento offline. I permessi sensori funzionano solo via HTTPS o su localhost."),
  );

  container.appendChild(rings.card);
  container.appendChild(intro);
  container.appendChild(permsBox);
  container.appendChild(grid);
  container.appendChild(tips);

  // Ridisegna gli anelli se la finestra cambia dimensione (canvas DPR-aware).
  const onResize = () => rings.render();
  window.addEventListener('resize', onResize);

  return { unmount() { off(); window.removeEventListener('resize', onResize); } };
}
