// ============================================================================
// dashboard.js — schermata Home con introduzione, stato permessi e moduli.
// ============================================================================

import { el } from '../utils.js';
import { onPermissionChange, getPermissions } from '../permissions.js';

const MODULES = [
  { route: 'movement', icon: '↻', title: 'Movimento',       desc: 'Accelerazione, rotazione, orientamento del telefono.' },
  { route: 'fall',     icon: '!', title: 'Caduta',          desc: 'Rileva pattern di caduta da accelerometro.' },
  { route: 'steps',    icon: '≋', title: 'Passi e attività',desc: 'Conta passi e classifica camminata / corsa.' },
  { route: 'sound',    icon: '♪', title: 'Ambiente sonoro', desc: 'Livello dB, spettro, presenza sonora.' },
  { route: 'heart',    icon: '♥', title: 'Battito',         desc: 'PPG dal polpastrello sulla fotocamera.' },
  { route: 'breath',   icon: '∿', title: 'Respiro',         desc: 'Atti/min con telefono sul petto.' },
  { route: 'info',     icon: 'i', title: 'Come funziona',   desc: 'Spiegazione fisica + limiti e privacy.' },
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

export function mount(container) {
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

  container.appendChild(intro);
  container.appendChild(permsBox);
  container.appendChild(grid);
  container.appendChild(tips);

  return { unmount() { off(); } };
}
