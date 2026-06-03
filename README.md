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
| **Stress (HRV)**  | Fotocamera      | Dagli intervalli RR del PPG: RMSSD/SDNN → indice di stress 0–100 (gauge). |
| **Respiro**       | Accel (su petto)| Bandpass 0.1–0.5 Hz su accel.z, atti/min + qualità SNR.                |

Più: **Home con "anelli salute"** (gauge degli ultimi valori reali misurati, on-device, non live), dashboard con stato permessi, pagine "Come funziona" e "Limiti & privacy".

> **Lo Stress è un indice _indicativo_, non clinico.** È derivato dalla variabilità della frequenza cardiaca (HRV) con una scala euristica (RMSSD 10–80 ms), lo stesso principio degli smartwatch consumer — ma non è una misura medica dello stress. Coerentemente con la filosofia del progetto, **non** mostriamo pressione sanguigna, glicemia o "scansioni d'organo": non sono misurabili in modo affidabile dai sensori di uno smartphone.

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

**Tutte le API sono supportate da Safari iOS in PWA installata.** Non usiamo Web Bluetooth, Generic Sensor API o Wake Lock. La **torcia** della fotocamera è controllata via `MediaStreamTrack.applyConstraints({ advanced: [{ torch: true }] })`: supportata da **iOS 17+** (e Android Chrome) quando `getCapabilities()` espone `torch`; dove non lo espone, l'app ricade in automatico sulla luce ambientale.

---

## Algoritmi (in due righe ciascuno)

- **Filtro passa-banda**: cascata di un IIR passa-alto (RC) e un passa-basso (RC) del primo ordine. Lascia passare solo la banda di interesse: cardiaca, respiratoria o di cadenza del passo.
- **Peak detector adattivo**: il valore corrente è considerato un picco se è massimo locale e supera `media + k·std` su una finestra mobile; con tempo refrattario per evitare doppi conteggi.
- **Rate estimator**: mediana mobile sugli intervalli inter-picco → `60_000 / mediana` = eventi/minuto. Robusto a outlier (movimenti spuri).
- **Fall detection**: FSM idle → impact (|a|>2.5 g) → stillness (σ|a|<0.3 g per 1 s) → evento confermato. Cooldown 4 s per non duplicare.
- **Presence sonora**: calibrazione baseline di 3 s, poi `dB > baseline + 6 dB` mantenuto per 2 s → presenza.
- **Indice di stress (HRV)**: dagli intervalli RR del PPG, filtrati (300–1500 ms, salti < 25 %), su finestra mobile di 60 s → `RMSSD = √mean(ΔRR²)`. Mappa euristica `stress = clamp(100 − scale(RMSSD), 0, 100)` con `scale` lineare su RMSSD 10–80 ms. Mostrato solo con qualità sufficiente e ≥ 20 battiti validi; altrimenti "—".

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
- **Torcia della fotocamera**: controllabile da **iOS 17+** (e Android Chrome) tramite i *track constraints* (`applyConstraints({ advanced: [{ torch: true }] })`), purché `getCapabilities()` esponga `torch` sulla camera posteriore. I moduli Battito e Stress la accendono automaticamente all'avvio e mostrano un toggle. Su **iOS ≤16** o fotocamere senza flash non è disponibile: l'app lo segnala e il PPG funziona con buona luce ambientale. L'API `ImageCapture` resta assente su Safari, ma non serve a questo scopo.
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
    ├── ppg.js              # motore PPG condiviso (camera→filtro→picchi→RR), usato da heart + stress
    ├── gauge.js            # gauge/anello circolare riutilizzabile (canvas)
    ├── store.js            # ultime misure on-device (localStorage) per gli anelli salute
    └── modules/
        ├── dashboard.js
        ├── movement.js
        ├── fall.js
        ├── steps.js
        ├── sound.js
        ├── heart.js
        ├── stress.js
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

Niente upload, niente login, niente cookie, niente analytics. L'audio e il video acquisiti vengono elaborati in tempo reale e poi **scartati**: nessun frame, nessun campione audio lascia il dispositivo. Gli "anelli salute" salvano in `localStorage` solo l'**ultimo valore numerico** di ciascuna metrica (es. `72 bpm`), sempre on-device: nessun dato lascia il telefono.

## Non è un dispositivo medico

Le misure di battito, respiro, caduta e l'indice di stress sono **indicative**, ottenute con sensori non calibrati in un ambiente non controllato. In particolare lo **stress** è un indice euristico derivato dall'HRV, non una misura clinica. Per uso clinico servono dispositivi certificati. Non vengono mostrati pressione sanguigna, glicemia o diagnosi: non sono misurabili in modo affidabile da uno smartphone.

---

## Licenza

MIT.
