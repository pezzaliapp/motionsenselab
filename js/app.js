// ============================================================================
// app.js — bootstrap, hash router, registrazione Service Worker.
//
// Ogni modulo esporta una funzione mount(container) che restituisce un
// oggetto { unmount() }. Il router chiama unmount() prima di cambiare schermata
// in modo da liberare event listener, fermare RAF, chiudere stream, ecc.
// ============================================================================

import { $, $$ } from './utils.js';

// ---- Import dei moduli (lazy via dynamic import per ridurre il TTI iniziale)
const ROUTES = {
  home:     () => import('./modules/dashboard.js'),
  movement: () => import('./modules/movement.js'),
  fall:     () => import('./modules/fall.js'),
  steps:    () => import('./modules/steps.js'),
  sound:    () => import('./modules/sound.js'),
  heart:    () => import('./modules/heart.js'),
  stress:   () => import('./modules/stress.js'),
  breath:   () => import('./modules/breath.js'),
  info:     () => import('./modules/info.js'),
};

let currentUnmount = null;

async function navigate(route) {
  const target = ROUTES[route] ? route : 'home';
  const view = $('#view');
  if (currentUnmount) {
    try { currentUnmount(); } catch (e) { console.warn('unmount error', e); }
    currentUnmount = null;
  }
  // Pulizia DOM e scroll-top quando si cambia tab.
  view.innerHTML = '';
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  try {
    const mod = await ROUTES[target]();
    const mounted = mod.mount(view);
    currentUnmount = mounted && mounted.unmount ? mounted.unmount : null;
  } catch (err) {
    console.error('Errore caricamento modulo', target, err);
    view.innerHTML = `<div class="card"><h2>Errore</h2><p>Impossibile caricare il modulo "${target}".</p><pre style="white-space:pre-wrap;color:#ff5b6e">${(err && err.message) || err}</pre></div>`;
  }
  // Aggiorna stato attivo nella tabbar.
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.route === target));
}

function routeFromHash() {
  const h = (location.hash || '#home').replace(/^#/, '');
  return h.split('/')[0] || 'home';
}

window.addEventListener('hashchange', () => navigate(routeFromHash()));

// ---------- Service worker registration (offline-first) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Path relativo per funzionare sia su localhost sia su GitHub Pages
    // (es. https://user.github.io/motionsenselab/).
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('Service worker non registrato:', err);
    });
  });
}

// ---------- Install prompt (solo su browser che lo supportano, non iOS) ----------
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const btn = $('#installBtn');
  if (btn) btn.classList.remove('hidden');
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('#installBtn');
  if (!btn || !deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.finally(() => {
    deferredInstall = null;
    btn.classList.add('hidden');
  });
});

// ---------- Iniziale ----------
navigate(routeFromHash());
