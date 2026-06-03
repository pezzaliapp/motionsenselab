// ============================================================================
// store.js — memoria leggera delle ULTIME misure per la vista "anelli salute".
//
// I sensori non possono girare tutti insieme (la fotocamera per il PPG, il
// microfono per l'audio, l'IMU per respiro/passi). Quindi la dashboard
// aggregata non mostra valori live simultanei, ma l'ultimo valore misurato da
// ciascun modulo, con il suo timestamp. Persistiamo in localStorage così
// sopravvive ai reload (resta comunque tutto on-device: niente upload).
//
// Ogni voce: { value:number, unit:string, ts:number(ms epoch) }.
// ============================================================================

const KEY = 'msl-metrics';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
  catch { return {}; }
}

export function setMetric(name, value, unit = '') {
  if (!Number.isFinite(value)) return;
  const all = readAll();
  all[name] = { value, unit, ts: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota/private mode */ }
}

export function getMetric(name) { return readAll()[name] || null; }
export function getAllMetrics() { return readAll(); }

// "2 min fa", "ieri", … — etichetta relativa breve per gli anelli.
export function ageLabel(ts) {
  if (!ts) return 'mai';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'ora';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h fa`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'ieri' : `${d} g fa`;
}
