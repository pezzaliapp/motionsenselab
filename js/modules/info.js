// ============================================================================
// info.js — pagina "Come funziona" + "Limiti e privacy".
// Solo contenuto testuale: nessun sensore, nessuna pipeline. Volutamente
// scritto in modo semplice e onesto sui limiti.
// ============================================================================

import { el } from '../utils.js';

export function mount(container) {
  const howto = el('div', { class: 'card' },
    el('h2', {}, 'Come funziona'),
    el('h3', {}, "L'accelerometro"),
    el('p', {}, "L'accelerometro è un MEMS (micro electro-mechanical system) che misura le forze che agiscono sul telefono lungo tre assi. Da fermo, l'unica forza è la gravità: l'asse rivolto verso il basso legge ~9.81 m/s². Quando il telefono si muove, si aggiungono accelerazioni lineari; quando ruota, il giroscopio (un altro MEMS) misura la velocità angolare. Con un po' di matematica — sottrai la gravità, filtra le componenti utili — si possono distinguere passi, cadute, gesti, e perfino il movimento toracico durante la respirazione."),
    el('h3', {}, "Il PPG (battito dal polpastrello)"),
    el('p', {}, "La fotopletismografia (PPG) misura come la luce viene assorbita o riflessa dai tessuti. Quando appoggi il polpastrello sulla lente della fotocamera, la luce ambientale lo attraversa: ad ogni battito il volume di sangue capillare aumenta brevemente e assorbe più luce, soprattutto sulle componenti rossa e verde. Mediando il canale rosso frame per frame, si ottiene una piccola oscillazione che, filtrata nella banda 0.7–4 Hz, rivela il ritmo cardiaco. È lo stesso principio degli smartwatch e dei pulsossimetri da dito."),
    el('h3', {}, 'Il microfono e la "presenza"'),
    el('p', {}, "Un microfono digitale campiona pressione acustica. Calcolando il valore RMS otteniamo un livello sonoro (in dB relativi); con la FFT (AnalyserNode) otteniamo lo spettro. Per rilevare \"presenza\" non identifichiamo cosa stia succedendo: calcoliamo un baseline silenzioso, poi segnaliamo quando il livello supera quel baseline di una soglia per un tempo minimo. Una porta che sbatte, una voce, un passo — tutto è una variazione sostenuta."),
    el('h3', {}, 'Il telefono sul petto: respiro'),
    el('p', {}, "Quando inspiri, il torace si espande di qualche millimetro. Se il telefono è appoggiato sul petto, l'accelerometro registra una piccolissima oscillazione lungo l'asse Z, a una frequenza tipica di 0.1–0.5 Hz (6–30 atti/min). È così debole da essere normalmente sovrastata dal rumore, ma un buon filtro passa-banda la isola — a patto di restare fermi."),
    el('h3', {}, "Filtri matematici, in due righe"),
    el('p', {}, "Un filtro passa-banda lascia passare solo le oscillazioni in una certa finestra di frequenza. Qui usiamo IIR del primo ordine in cascata: un passa-alto rimuove la \"deriva\" lenta (gravità, illuminazione di fondo), un passa-basso rimuove il rumore veloce. La banda residua è quella di interesse: 0.7–4 Hz per il cuore, 0.6–3 Hz per i passi, 0.1–0.5 Hz per il respiro."),
    el('h3', {}, 'Per approfondire'),
    el('ul', {},
      el('li', {}, el('a', { href: 'https://en.wikipedia.org/wiki/Photoplethysmogram', target: '_blank', rel: 'noopener' }, 'Photoplethysmogram — Wikipedia')),
      el('li', {}, el('a', { href: 'https://en.wikipedia.org/wiki/Accelerometer', target: '_blank', rel: 'noopener' }, 'Accelerometer — Wikipedia')),
      el('li', {}, el('a', { href: 'https://developer.mozilla.org/docs/Web/API/DeviceMotionEvent', target: '_blank', rel: 'noopener' }, 'DeviceMotionEvent — MDN')),
      el('li', {}, el('a', { href: 'https://developer.mozilla.org/docs/Web/API/Web_Audio_API', target: '_blank', rel: 'noopener' }, 'Web Audio API — MDN')),
      el('li', {}, el('a', { href: 'https://pubmed.ncbi.nlm.nih.gov/22255949/', target: '_blank', rel: 'noopener' }, 'Poh et al., "Non-contact, automated cardiac pulse measurements using video imaging" (2010)')),
      el('li', {}, el('a', { href: 'https://pubmed.ncbi.nlm.nih.gov/27101598/', target: '_blank', rel: 'noopener' }, 'Bates et al., respirazione tramite IMU (rassegna)')),
    ),
  );

  const limits = el('div', { class: 'card' },
    el('h2', {}, 'Limiti e privacy'),
    el('h3', {}, 'Privacy'),
    el('p', {}, "Tutti i dati restano sul tuo dispositivo. L'app non invia nulla a server esterni, non fa login, non usa analytics e non scrive cookie. L'audio e il video acquisiti vengono elaborati in tempo reale e poi scartati — niente è salvato."),
    el('h3', {}, 'Non è uno strumento medico'),
    el('p', {}, "Le misure di battito, respiro e caduta sono indicative. Sensori non calibrati, ambiente non controllato, posizionamento variabile: tutti fattori che possono falsare significativamente la lettura. Per uso clinico servono dispositivi certificati."),
    el('h3', {}, 'Misurazioni indicative e dipendenti dal contesto'),
    el('ul', {},
      el('li', {}, 'Per il PPG servono buona luce ambientale e dito fermo: la torcia non è accessibile da PWA su iOS.'),
      el('li', {}, "Per il respiro serve immobilità totale: anche piccoli movimenti distruggono il segnale."),
      el('li', {}, "Per il livello sonoro la scala è RELATIVA, non calibrata: utile come confronto, non come fonometro."),
      el('li', {}, 'Il rilevamento cadute è basato su soglie: può generare falsi positivi/negativi.'),
    ),
    el('h3', {}, 'Compatibilità iOS'),
    el('p', {}, "Apple richiede che DeviceMotion / DeviceOrientation siano attivati tramite un tap dell'utente (gesture). Per questo ogni modulo che usa l'accelerometro ha un pulsante \"Attiva\" — non possiamo aggirare questo limite, ed è giusto così: chi usa l'app deve sapere quando i sensori sono in lettura."),
    el('h3', {}, 'PWA e HTTPS'),
    el('p', {}, "I permessi sensori funzionano solo su origin sicuri: localhost in sviluppo, HTTPS (incluso *.github.io) in produzione. Installa l'app dalla schermata di condivisione di Safari per avere un'icona dedicata, fullscreen, e funzionamento offline dopo il primo caricamento."),
  );

  const dev = el('div', { class: 'card' },
    el('h3', {}, 'Note di sviluppo'),
    el('p', {}, "Codice vanilla HTML/CSS/JS, ES modules, zero dipendenze, zero build step. Pubblicabile su GitHub Pages come repository statico. Service worker cache-first per gli asset: dopo la prima visita l'app è completamente offline."),
    el('p', {}, "Per estenderla: ogni modulo è un file ES module sotto js/modules/ che esporta una funzione mount(container) → { unmount() }. Aggiungere un modulo significa aggiungere una rotta in app.js e una card nella dashboard."),
  );

  container.appendChild(howto);
  container.appendChild(limits);
  container.appendChild(dev);

  return { unmount() { /* nessuna risorsa attiva */ } };
}
