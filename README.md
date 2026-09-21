# psalmio-client

> **In English:** A dependency-free Node library and command-line tool that lets a
> church's video setup hand recordings and start times to
> [Psalmio](https://psalmio.de), a media library for church services. Uploads are
> chunked, resumable and never overwrite existing recordings. Docs and messages
> are in German because that is where Psalmio's congregations are; error codes
> and exit codes are language-neutral. The interface contract is in
> [`docs/API.md`](docs/API.md).

Aufnahmen und Startzeitpunkte nach [Psalmio](https://psalmio.de) bringen – als
Node-Bibliothek und als Kommandozeilen-Werkzeug. Ohne Fremdabhängigkeiten.

Psalmio ist die Mediathek, in der Gemeinden ihre Gottesdienste veröffentlichen.
Wer die Aufnahme nicht von Hand im Editor hochladen will, hängt seine
Videotechnik an diese Schnittstelle: Sie meldet, wann die Aufnahme begann, und
schickt danach die fertige Datei. Den Rest – Ton, Video, Ablauf, Mediathek –
macht Psalmio.

```
Aufnahme beginnt  →  psalmio start <termin>
Aufnahme fertig   →  psalmio upload aufnahme.mp4 --event <termin>
```

## Einrichten

In Psalmio unter **Einstellungen → API-Keys** einen Key mit der Berechtigung
**„Videotechnik"** anlegen. Er gilt für genau diese Gemeinde.

```bash
export PSALMIO_URL=https://gemeinde.psalmio.de
export PSALMIO_API_KEY=…          # oder: --key-file /pfad/zur/datei
psalmio status
```

Die Termin-ID ist bei Gemeinden mit ChurchTools die ID des Termins dort. Kennt
Psalmio ihn noch nicht, holt es ihn beim ersten Aufruf selbst aus ChurchTools.

## Kommandozeile

```bash
psalmio status
psalmio event 7944
psalmio start 7944 --at 2026-09-20T10:00:00+02:00
psalmio upload aufnahme.mp4 --event 7944 --started-at 2026-09-20T09:58:30+02:00
psalmio upload aufnahme.mp4 --event 7944 --resume <upload-id>   # nach einem Abbruch
```

`--json` gibt das Ergebnis maschinenlesbar aus. Der Rückgabewert sagt einem
Skript, wie es weitergeht:

| Wert | Bedeutung | Reaktion |
|---|---|---|
| 0 | erledigt | – |
| 1 | gescheitert | nachsehen |
| 2 | Psalmio führt diesen Termin nicht | überspringen |
| 3 | vorübergehend nicht möglich | später wiederholen; bei `upload` mit der ausgegebenen `--resume`-Kennung |
| 64 | falsch aufgerufen | – |

Den Key als Argument gibt es mit Absicht nicht: Argumente stehen für jeden
Benutzer des Rechners lesbar in der Prozessliste.

## Bibliothek

```js
const psalmio = require('psalmio-client');

const config = { baseUrl: 'https://gemeinde.psalmio.de', apiKey: process.env.PSALMIO_API_KEY };

await psalmio.startEvent(config, '7944', Math.floor(Date.now() / 1000));

const result = await psalmio.uploadRecording(config, '7944', {
  filePath: '/aufnahmen/gottesdienst.mp4',
  recordingStartedAt: 1789890656,
  onProgress: ({ percent, part, partCount }) => console.log(`${percent} % (Teil ${part}/${partCount})`),
});

if (result.ok) console.log('Job', result.data.job_id);
else if (psalmio.isUnknownEvent(result)) console.log('Termin gibt es in Psalmio nicht – überspringen');
else if (psalmio.isTemporaryOutage(result)) console.log('später noch einmal');
else console.error(result.stage, result.error, result.uploadId /* zum Fortsetzen */);
```

**Nichts wirft.** Jede Funktion gibt `{ ok, … }` zurück und sagt ehrlich, ob es
geklappt hat. Wer diese Bibliothek einbindet, steuert damit womöglich gerade
live einen Gottesdienst – ein Aufruf, der nicht ankommt, darf dort nichts
abbrechen.

`uploadRecording` lädt in Teilen (bis 15 GB): Ein gescheiterter Teil wird
einzeln wiederholt, eine abgelaufene Adresse erneuert, und nach einem Abbruch
geht es mit `uploadId` an derselben Stelle weiter. Kennt eine Psalmio-Fassung
die Teile noch nicht, weicht der Aufruf auf den einzelnen PUT aus (bis 5 GB).

Die einzelnen Schritte gibt es auch einzeln: `checkConnection`, `getEvent`,
`startEvent`, `requestUpload`, `uploadFile`, `completeUpload`, `startMultipart`,
`resumeMultipart`, `completeMultipart`, `abortMultipart` – und für
Einstellungsseiten `normalizeBaseUrl`, `validateBaseUrl`, `resolveTestConfig`.

## Was der Code verspricht

Jede dieser Zusagen ist ein Test in `test/`:

- **Der API-Key geht nur an die Gemeinde.** Nur https (http allein für
  localhost), kein Pfad, kein `benutzer:passwort@`. Umleitungen wird nicht
  gefolgt – der Key käme sonst beim neuen Host an. Ein gespeicherter Key wird
  nie an eine neu eingetippte Adresse geschickt.
- **Ein Upload endet in jedem Fall** – auch wenn die Verbindung nach den
  Kopfzeilen abreißt, der Server schweigt oder mitten im Hochladen abgebrochen
  wird. Getestet gegen echte Server auf localhost, nicht gegen Attrappen.
- **Gespeichert ist gespeichert.** Nimmt der Speicher die Datei an und kappt
  danach die Verbindung, bleibt es ein Erfolg – sonst lüde ein „Wiederholen"
  Gigabytes erneut hoch.
- **Antworten werden nicht verwechselt.** „Psalmio führt diesen Termin nicht"
  (`EVENT_NOT_FOUND`) ist etwas anderes als die 404-Seite einer falschen Adresse,
  und beides etwas anderes als „gerade nicht erreichbar" (503).
- **Vorhandenes wird nie überschrieben** – das stellt Psalmio selbst sicher
  (409), der Client reicht es unverändert durch.

## Versionen

Die Schnittstelle beschreibt [`docs/API.md`](docs/API.md); sie ändert sich nur
abwärtskompatibel. Diese Bibliothek folgt [SemVer](https://semver.org/lang/de/).

**Bitte eine feste Version einbinden** und neue bewusst übernehmen – nicht
automatisch die neueste. Wer damit live Gottesdienste steuert, will nicht, dass
sich zwischen zwei Sonntagen etwas von selbst ändert.

```bash
npm install github:psalmio-app/psalmio-client#v0.1.0
```

## Entwicklung

```bash
npm test      # node --test, keine Abhängigkeiten
```

Gegen ein lokales Psalmio (`http://localhost:8000`) zusätzlich
`PSALMIO_TENANT=<gemeinde>` setzen – dort gibt es keine Subdomain, an der sich
die Gemeinde ablesen ließe. In Produktion wird das nie gebraucht.

## Herkunft

Der Kern – die Regeln, wohin der Key gehen darf, und der Upload, der in jedem
Fall endet – stammt aus der Workflow Engine der MBG Lemgo von Tim Fast und ist
dort im Live-Betrieb entstanden. Lizenz: [MIT](LICENSE).
