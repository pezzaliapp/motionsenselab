# Motion Sense Lab

> *I sensori che hai già in tasca.*

PWA dimostrativa, educativa e **realmente funzionante**: usa i sensori reali dello smartphone (accelerometro, giroscopio, microfono, fotocamera) per rilevare **movimento, presenza, respiro, battito cardiaco e cadute**.

È il complemento pratico di *WiFi Sense Lab*: dove quella era simulazione, questa è **misurazione reale** on-device. Zero backend, zero tracciamento, zero dipendenze.

---

## Moduli

| Modulo            | Sensore         | Cosa fa                                                                |
| ----------------- | --------------- | ---------------------------------------------------------------------- |
| **Movimento**     | Accel + Gyro    | Valori live X/Y/Z, magnitudo, cubo CSS 3D che segue l'orientamento.    |
| **Caduta**        | Accel           | Pattern detector: picco > 2.5 g → immobilità < 0.3 g per 1 s.         |
| **Passi**         | Accel           | Bandpass 0.6–3 Hz + peak detector; classifica fermo / cammino / corsa. |
| **Audio**         | Microfono       | Livello dB relativo, spettrogramma scrolling, presence detection.      |
| **Battito**       | Fotocamera      | PPG sul canale rosso del polpastrello, bandpass 0.7–4 Hz, bpm.         |
| **Respiro**       | Accel (su petto)| Bandpass 0.1–0.5 Hz su accel.z, atti/min + qualità SNR.                |

Più: dashboard con stato permessi, pagine "Come funziona" e "Limiti & privacy".

---

## API Web usate (e perché)

| API                                | Uso nei moduli                                          |
| ---------------------------------- | ------------------------------------------------------- |
| `DeviceMotionEvent`                | accelerometro + giroscopio (movimento, caduta, passi, respiro) |
| `DeviceOrientationEvent`           | orientamento per il cubo 3D nel modulo movimento        |
| `navigator.mediaDevices.getUserMedia({ audio })` | acquisizione microfono                |
| `AudioContext` + `AnalyserNode`    | RMS in tempo reale e FFT per lo spettrogramma           |
| `navigator.mediaDevices.getUserMedia({ video })` | acquisizione fotocamera posteriore   |
| `HTMLCanvasElement` (2D)           | tutti i grafici live (traccia, spettro, scrolling)      |
| `navigator.vibrate`                | feedback aptico al rilevamento caduta (Android)         |
| `Service Worker` + `Cache API`     | funzionamento offline                                   |

**Tutte le API sono supportate da Safari iOS in PWA installata.** Non usiamo Web Bluetooth, Generic Sensor API, Wake Lock, torcia o altre API non disponibili su iOS.

---

## Algoritmi (in due righe ciascuno)

- **Filtro passa-banda**: cascata di un IIR passa-alto (RC) e un passa-basso (RC) del primo ordine. Lascia passare solo la banda di interesse: cardiaca, respiratoria o di cadenza del passo.
- **Peak detector adattivo**: il valore corrente è considerato un picco se è massimo locale e supera `media + k·std` su una finestra mobile; con tempo refrattario per evitare doppi conteggi.
- **Rate estimator**: mediana mobile sugli intervalli inter-picco → `60_000 / mediana` = eventi/minuto. Robusto a outlier (movimenti spuri).
- **Fall detection**: FSM idle → impact (|a|>2.5 g) → stillness (σ|a|<0.3 g per 1 s) → evento confermato. Cooldown 4 s per non duplicare.
- **Presence sonora**: calibrazione baseline di 3 s, poi `dB > baseline + 6 dB` mantenuto per 2 s → presenza.

Vedi `js/utils.js` per le implementazioni e i commenti.

---

## Installazione PWA su iPhone

1. Apri il sito in **Safari** (gli altri browser su iOS non possono installare PWA con tutti i permessi sensori).
2. Tocca il pulsante **Condividi** (quadrato con freccia in alto).
3. Scorri verso il basso e tocca **Aggiungi alla schermata Home**.
4. Conferma il nome e tocca **Aggiungi**.

L'app comparirà con la sua icona, fullscreen senza barra Safari, e funzionerà offline dopo il primo caricamento.

> Per attivare i sensori inerziali (DeviceMotion), Apple richiede un **tap dell'utente**. Ogni modulo ha quindi un pulsante "Attiva" — non c'è modo di aggirarlo, ed è giusto così.

---

## Limiti noti su iOS

- **DeviceMotion**: richiede `requestPermission()` invocato da un gesto utente. Il primo tap su "Attiva" mostra il prompt di sistema.
- **Torcia della fotocamera**: non accessibile da PWA su iOS. Il PPG funziona con luce ambientale; se possibile posizionati vicino a una sorgente luminosa.
- **Wake Lock**: API limitata; le sessioni lunghe potrebbero subire screen-dim. Tieni il telefono "in uso" durante misurazioni lunghe (PPG, respiro).
- **AudioContext**: parte in `suspended`; richiede un gesto utente per `resume()`. Gestito automaticamente dal modulo audio.
- **HTTPS obbligatorio**: i permessi sensori funzionano solo su origin sicuri (localhost o HTTPS, inclusi i siti GitHub Pages).

---

## Sviluppo locale

```bash
# Qualunque server statico va bene. Esempio con Python 3:
python3 -m http.server 8000

# Poi apri http://localhost:8000 nel browser.
```

Per testare su iPhone reale durante lo sviluppo:

- usa `npx serve --ssl-cert ... --ssl-key ...` oppure
- pubblica su GitHub Pages (HTTPS automatico) e apri da Safari mobile.

I permessi sensori NON funzionano da `file://` o da `http://` non-localhost.

---

## Struttura del repo

```
.
├── index.html              # shell HTML
├── manifest.json           # PWA manifest
├── sw.js                   # service worker cache-first
├── css/style.css           # tema dark, mobile-first
├── icons/                  # 192, 512, maskable
└── js/
    ├── app.js              # bootstrap, hash router, SW registration
    ├── utils.js            # ring buffer, filtri IIR, peak detector, DOM helpers
    ├── permissions.js      # wrapper getUserMedia + DeviceMotion.requestPermission
    └── modules/
        ├── dashboard.js
        ├── movement.js
        ├── fall.js
        ├── steps.js
        ├── sound.js
        ├── heart.js
        ├── breath.js
        └── info.js
```

---

## Estendere l'app

Ogni modulo è un ES module che esporta `mount(container) → { unmount() }`. Per aggiungerne uno:

1. Crea `js/modules/nuovo.js` con la stessa firma.
2. Aggiungi la rotta in `js/app.js` (`ROUTES.nuovo = () => import('./modules/nuovo.js')`).
3. Aggiungi la voce nella tabbar in `index.html` e la card nella dashboard (`js/modules/dashboard.js`).
4. Aggiungi il file al `PRECACHE` di `sw.js`.

---

## Privacy

Niente upload, niente login, niente cookie, niente analytics. L'audio e il video acquisiti vengono elaborati in tempo reale e poi **scartati**: nessun frame, nessun campione audio, nessuna misura lascia il dispositivo.

## Non è un dispositivo medico

Le misure di battito, respiro e caduta sono **indicative**, ottenute con sensori non calibrati in un ambiente non controllato. Per uso clinico servono dispositivi certificati.

---

## Licenza

MIT.
