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
psalmio upload aufnahme.mp4 --event 7944 --resume   # nach einem Abbruch: derselbe Befehl, mit --resume
```

Sobald Psalmio den Upload eröffnet hat, stehen Kennung und Fingerabdruck der
Datei (Pfad, Größe, Änderungszeit) in `aufnahme.mp4.psalmio-upload.json` – auch
ein abgeschossener Prozess oder ein Stromausfall lässt sich also fortsetzen.
`--resume` liest beides von dort und setzt nur fort, wenn unter dem Pfad noch
dieselbe Datei liegt; sonst endet es mit `RESUME_FILE_MISMATCH`, und ein Aufruf
ohne `--resume` beginnt von vorn (den halben Upload gibt er dabei zurück). Liegt
die Aufnahme auf einem Laufwerk ohne Schreibrecht: `--state <datei>`.

Optionen gehen als `--name wert` oder `--name=wert` und gelten nur für den Befehl,
bei dem sie stehen. Zeiten (`--at`, `--started-at`) als Unix-Sekunden oder ISO-Zeit,
zwischen 1990 und morgen. Unbekannte Optionen, eine Option am falschen Befehl,
fehlende Werte und unplausible Zeiten enden mit Rückgabewert 64, statt still
übergangen zu werden.

### Ein ganzes Archiv: `psalmio batch`

```bash
psalmio batch zuordnung.tsv --dry-run                 # erst nachsehen: Dateien da? wie viel?
psalmio batch zuordnung.tsv --window 22:00-06:00      # dann laufen lassen
psalmio batch zuordnung.tsv --window 22:00-06:00 --window-tz Europe/Berlin   # auf einem Server in UTC
```

Das Manifest ist tabulatorgetrennt mit den Spalten `pfad` und `ct_id` (weitere
stören nicht), je Termin genau eine Datei. Liegen die Dateien auf diesem Rechner
woanders als im Manifest: `--root-from /mnt/nas --root-to /Volumes/Videoteam`.

- **Der Server bestimmt das Tempo.** Vor jeder Datei wartet der Lauf, bis Psalmio
  mit der vorigen fertig ist (`GET /queue`). Ton und Bild eines Gottesdienstes
  brauchen dort rund eine Viertelstunde; ohne Bremse stapelten vierhundert
  Aufnahmen Tage an Arbeit auf dem Rechner, auf dem auch die Mediathek läuft.
- **Abbrechen kostet nichts.** Der Stand steht in `<manifest>.stand.json`; ein
  neuer Start überspringt Erledigtes und setzt einen halben Upload fort. Die
  Kennung steht dort, sobald der Server sie ausgestellt hat – auch ein
  Stromausfall mitten im Upload lässt sich also fortsetzen. Zu jeder Kennung
  gehört der Fingerabdruck der Datei (Pfad, Größe, Änderungszeit); liegt dort
  inzwischen eine andere, wird der halbe Upload verworfen und neu begonnen,
  statt Teile zweier Dateien zu einer Aufnahme zu verweben.
- **Das Zeitfenster gilt auch nach dem Warten.** `--window` wird nicht nur vor
  dem Warten auf den Server geprüft, sondern auch danach – sonst begänne ein
  Upload nach stundenlanger Warterei womöglich mitten im Gottesdienst. Die
  Uhrzeit ist die des Rechners, sofern `--window-tz` nichts anderes sagt; auf
  einem Server in UTC hieße „22:00-06:00" im Sommer 0 bis 8 Uhr deutscher Zeit.
- **Absagen halten nicht auf.** „Termin gibt es in Psalmio nicht" und „da liegt
  schon eine Aufnahme" werden notiert und übersprungen.
- **Veröffentlicht wird nichts.** Die Aufnahmen liegen danach mit ihrem Ablauf
  aus ChurchTools im Editor und warten dort auf jemanden, der sie prüft.

Der ganze Weg – von der Bestandsaufnahme über das Manifest bis zum Lauf – steht in
[`docs/ARCHIV.md`](docs/ARCHIV.md). Das Hochladen ist dabei der leichte Teil.

`--json` gibt das Ergebnis maschinenlesbar aus. Der Rückgabewert sagt einem
Skript, wie es weitergeht:

| Wert | Bedeutung | Reaktion |
|---|---|---|
| 0 | erledigt | – |
| 1 | gescheitert | nachsehen |
| 2 | Psalmio führt diesen Termin nicht | überspringen |
| 3 | vorübergehend nicht möglich | später wiederholen; bei `upload` derselbe Befehl mit `--resume` |
| 64 | falsch aufgerufen (auch: unbekannte Option, fehlender Wert) | – |

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

### Fortsetzen gilt immer einer bestimmten Datei

Die `uploadId` steht fest, sobald der Server sie ausgestellt hat – nicht erst,
wenn der Aufruf zurückkommt. `onUploadStart` meldet sie mitsamt dem
Fingerabdruck der Datei; wer beides sofort wegschreibt, kann auch nach einem
Stromausfall fortsetzen. Der Rückruf darf eine Promise liefern – das erste Byte
fließt erst, wenn sie erfüllt ist. Scheitert er, endet der Upload vorher
(`UPLOAD_START_HOOK_FAILED`), und ein eben eröffneter Upload wird gleich
zurückgegeben: Wer die Kennung nicht festhalten konnte, kann ihn ohnehin nicht
fortsetzen.

```js
await psalmio.uploadRecording(config, '7944', {
  filePath: '/aufnahmen/gottesdienst.mp4',
  onUploadStart: ({ uploadId, file }) => merken({ uploadId, file }),  // file: { path, size, mtimeMs }
});

// später, nach einem Abbruch:
const result = await psalmio.uploadRecording(config, '7944', {
  filePath: '/aufnahmen/gottesdienst.mp4',
  uploadId: gemerkt.uploadId,
  resumeFile: gemerkt.file,
});
if (result.code === 'RESUME_FILE_MISMATCH') /* andere Datei – von vorn */;
```

**Ohne `resumeFile` kein Fortsetzen.** Eine `uploadId` ohne vollständigen
Fingerabdruck (Pfad, Größe und Änderungszeit) wird abgelehnt
(`RESUME_FILE_MISSING`), bevor Psalmio gefragt wird. Sonst gäbe es nichts zu
vergleichen: Liegt unter dem Pfad inzwischen eine andere Datei, würden Teile
aus beiden zu **einer** Aufnahme zusammengefügt – und niemand merkte es. Der
Fingerabdruck ist dabei der einzige Schutz. Psalmio rechnet den Plan beim
Fortsetzen aus der gesendeten Größe neu, eine andere Datei gleicher Größe fällt
dem Server also nicht auf. Die Prüfung des Plans (`RESUME_PLAN_MISMATCH`)
fängt nur einen Server ab, der sich verrechnet. `runBatch` führt den
Fingerabdruck in seinem Stand mit und macht das von selbst.

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
- **Aus zwei Dateien wird nie eine Aufnahme.** Fortgesetzt wird nur mit dem
  Fingerabdruck der Datei, in der Bibliothek wie auf der Kommandozeile – auch
  wenn die neue Datei genauso groß ist und nur die Änderungszeit sie verrät.
  Getestet mit einem Prozess, der mitten im Upload abgeschossen wird.

## Versionen

Die Schnittstelle beschreibt [`docs/API.md`](docs/API.md); sie ändert sich nur
abwärtskompatibel. Diese Bibliothek folgt [SemVer](https://semver.org/lang/de/).

**Bitte eine feste Version einbinden** und neue bewusst übernehmen – nicht
automatisch die neueste. Wer damit live Gottesdienste steuert, will nicht, dass
sich zwischen zwei Sonntagen etwas von selbst ändert.

```bash
npm install github:psalmio-app/psalmio-client#v0.1.2
```

## Entwicklung

```bash
npm test      # node --test, keine Abhängigkeiten
```

Gegen ein lokales Psalmio (`http://localhost:8000`) zusätzlich
`PSALMIO_TENANT=<gemeinde>` setzen – dort gibt es keine Subdomain, an der sich
die Gemeinde ablesen ließe. In Produktion wird das nie gebraucht.

## Herkunft

Entstanden ist der Code als Psalmio-Anbindung in der Workflow Engine der MBG
Lemgo: Samuel Funk hat sie dort eingebaut (Aufrufe, Upload, die Regel „nichts
wirft"), Tim Fast hat sie im Live-Betrieb gehärtet – die Regeln, wohin der
API-Key gehen darf, der Upload, der in jedem Fall endet, die Unterscheidung der
Antworten – und die Tests dazu geschrieben. Upload in Teilen, `uploadRecording`
und die Kommandozeile sind hier dazugekommen. Lizenz: [MIT](LICENSE).
