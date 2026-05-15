# Motion Sense Lab — Prompt di progetto

Crea una PWA chiamata **Motion Sense Lab**.

## Obiettivo
Realizzare una app dimostrativa, educativa e **realmente funzionante** che usi i sensori reali dello smartphone (accelerometro, giroscopio, microfono, fotocamera) per rilevare movimento, presenza, respiro, battito cardiaco e cadute. È il complemento pratico di "WiFi Sense Lab": dove quella era simulazione, questa è misurazione reale.

Sottotitolo: **"I sensori che hai già in tasca."**

## IMPORTANTE — Vincoli etici e tecnici
- Tutti i dati restano **sul dispositivo**. Nessun upload, nessun server, nessun login, nessun tracciamento.
- L'app **non è un dispositivo medico**. Le misure di battito e respiro sono indicative, non diagnostiche.
- Permessi sensori chiesti **on-demand**, mai all'avvio. L'utente attiva ogni modulo quando lo vuole usare.
- Spiegare sempre, prima di chiedere il permesso, **cosa farà l'app e perché** serve quel sensore.
- Funzionante offline dopo il primo caricamento.
- Installabile come PWA (manifest + service worker).

## Stack tecnico
HTML, CSS e JavaScript puro (no framework, no build step) oppure React + Vite se preferibile.
Deve essere pubblicabile su GitHub Pages senza configurazione extra.
**Tutte le API usate devono essere supportate da Safari iOS in PWA.**

## Moduli da implementare

### 1. Dashboard introduttiva
- Spiegazione semplice: smartphone moderni hanno sensori potenti, e con un po' di matematica si può rilevare molto più di quanto si pensi.
- Card con i 5 moduli disponibili.
- Indicatore di stato dei permessi (concessi / negati / non ancora chiesti).

### 2. Modulo "Movimento" (accelerometro + giroscopio)
- API: `DeviceMotionEvent` (con `requestPermission()` su iOS 13+).
- Mostrare in tempo reale: accelerazione X/Y/Z, rotazione X/Y/Z.
- Grafico live degli ultimi 10 secondi (canvas).
- Indicatore "fermo / piccolo movimento / movimento ampio" calcolato da magnitudo dell'accelerazione meno gravità.
- Visualizzazione 3D semplice (CSS transform) di un blocco che si orienta col telefono.

### 3. Modulo "Caduta" (accelerometro)
- Algoritmo: rileva un picco di accelerazione totale > soglia (es. > 2.5g) seguito da una fase di quasi-immobilità (< 0.3g) per almeno 1 secondo, classico pattern di caduta.
- Pulsante "Inizia monitoraggio" / "Stop".
- Quando rilevata: alert visivo, vibrazione (se supportata), timestamp.
- Mostrare lista cronologica eventi rilevati nella sessione.
- Avviso chiaro: "Questo non sostituisce un dispositivo medico di rilevamento cadute."

### 4. Modulo "Passi e attività" (accelerometro)
- Conta passi semplice basato su picchi di accelerazione verticale filtrati.
- Riconoscimento attività grossolano: fermo / cammino / corsa, basato su frequenza e ampiezza dei picchi.
- Contatore passi della sessione + indicatore attività corrente.

### 5. Modulo "Ambiente sonoro" (microfono)
- API: `getUserMedia({ audio: true })` + Web Audio API + AnalyserNode.
- Misura livello sonoro in dB (relativo, non calibrato — dichiararlo).
- Spettrogramma live (canvas, scrolling).
- Indicatore: silenzio / ambiente normale / rumoroso.
- Rilevamento "presenza" sonora: variazione significativa dal baseline per almeno N secondi → "qualcuno o qualcosa si muove nell'ambiente".

### 6. Modulo "Battito cardiaco" (fotocamera — PPG)
- API: `getUserMedia({ video: { facingMode: 'environment' } })`.
- Istruzioni chiare: "Appoggia delicatamente il polpastrello dell'indice sulla fotocamera posteriore. Tieni fermo per 20 secondi."
- Analizza il canale rosso del video, calcola la media per frame, applica filtro passa-banda (0.7–4 Hz = 42–240 bpm).
- Identifica i picchi → calcola bpm.
- Mostra forma d'onda PPG live + valore bpm aggiornato.
- Avviso: "Misurazione indicativa, non uso medico. Usa cardiofrequenzimetro per misure affidabili."
- Nota nel codice: torcia non accessibile da PWA su iOS, funziona con luce ambientale.

### 7. Modulo "Respiro" (accelerometro, posizionamento sul petto)
- Istruzioni: "Sdraiati supino e appoggia il telefono sul petto, schermo verso l'alto. Resta fermo 30 secondi."
- Filtro passa-banda sull'accelerazione Z (0.1–0.5 Hz = 6–30 respiri/min).
- Identifica i cicli respiratori → calcola atti/min.
- Mostra forma d'onda respiratoria + valore.
- Indicatore qualità misura (basato su SNR).
- Avviso: "Misurazione indicativa."

### 8. Sezione "Come funziona"
- Pagina che spiega in modo semplice:
  - cosa è l'accelerometro e cosa misura;
  - cosa è il PPG e perché il polpastrello sulla fotocamera fa vedere il battito;
  - perché il microfono può rilevare presenza nell'ambiente;
  - perché il telefono sul petto rileva il respiro;
  - link a paper di ricerca pubblici sui temi (PPG mobile, respiro tramite IMU).

### 9. Sezione "Limiti e privacy"
- Tutti i dati sul dispositivo.
- Niente uso medico.
- Misurazioni indicative e influenzate dall'ambiente.
- Sensori del telefono non calibrati come strumenti professionali.
- Funziona meglio in certe condizioni (immobilità per PPG/respiro, ambiente non rumoroso per audio, etc.).
- Compatibilità iOS richiede tap utente per attivare DeviceMotion (limite imposto da Apple).

## Interfaccia
- Stile **moderno, scuro, tecnico ma chiaro** — coerente con WiFi Sense Lab.
- Mobile-first (questo è il punto: gira su iPhone).
- Navigazione a card / tab in basso.
- Ogni modulo è una schermata dedicata con: spiegazione breve, pulsante "Attiva", visualizzazione live, "Stop".
- Animazioni fluide, grafici canvas a 60fps dove possibile.
- Accessibilità: contrasti adeguati, testi leggibili, pulsanti grandi.

## Output richiesto
- codice completo;
- manifest.json con icone (almeno 192x192 e 512x512);
- service worker per offline;
- README.md con:
  - descrizione progetto;
  - quali API sono usate e perché;
  - istruzioni installazione PWA su iPhone (Safari → Condividi → Aggiungi a Home);
  - limiti noti su iOS;
  - note di sviluppo per chi vuole estenderla.

## Tono
Scientifico, trasparente, educativo. Onesto sui limiti.

## Vincoli implementativi importanti
- **Tutto deve funzionare in Safari iOS in PWA**. Niente Web Bluetooth, niente Wake Lock dove non supportato, niente API sperimentali.
- Il PRIMO permesso DeviceMotion va richiesto **da un gesto utente** (tap su bottone), altrimenti iOS rifiuta.
- Service worker con strategia cache-first per gli asset, network-first per nulla (l'app è 100% statica).
- HTTPS obbligatorio per i permessi sensori — funziona su `localhost` in dev e su `*.github.io` in prod.
- Codice commentato in italiano dove serve spiegazione.

**Nome:** Motion Sense Lab
**Sottotitolo:** "I sensori che hai già in tasca."
