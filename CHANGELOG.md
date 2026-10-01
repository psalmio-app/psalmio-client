# Änderungen

## 0.5.0 – 01.10.2026

Auf Wunsch von Tim Fast (Videotechnik der MBG Lemgo): Bei Nachfeiern arbeitet die
Regie im Steuerpult und hat Psalmio nicht immer offen.

- **Neu: `psalmio pause <termin>` und `psalmio weiter <termin>`** (Bibliothek:
  `pauseEvent`, `resumeEvent`), beide wahlweise mit `--at <zeit>`. Die Aufnahme
  läuft weiter, Psalmio schneidet die Pause bei der Freigabe heraus. Läuft gerade
  ein Beitrag, endet er mit der Pause; zweimal drücken schadet nicht
  (`already_paused`, `not_paused`).
- `GET /events/{id}` (`psalmio event`) meldet `pause_running`.
- Braucht Psalmio vom 01.10.2026 oder neuer; ältere Fassungen antworten auf die
  neuen Pfade mit 404 ohne `error_code` (`isUnknownEndpoint`).

## 0.4.0 – 30.09.2026

Aus der Rückmeldung von Tim Fast (Videotechnik der MBG Lemgo) zu 0.3.0:

- **`psalmio churchtools-mcp` liest ohne Angabe nur.** Schreiben muss mit
  `--allow-write` eingeschaltet werden, Löschen weiter mit `--allow-delete`.
  Grund: Ein ChurchTools-Token kann alles, was seine Person kann, und ein
  öffentlicher Server soll nicht von selbst schreiben. Wer 0.3.0 ohne Schalter
  schreibend betrieben hat, ergänzt `--allow-write`. `--read-only` gibt es weiter.
- **Neu: Probemodus `--dry-run`.** Die schreibenden Werkzeuge prüfen und lesen wie
  sonst, schicken aber nichts und zeigen stattdessen, was sie geschickt hätten.
- **Kein Ersetzen ganzer Ablaufpläne über `ct_api_write`.** `PUT /events/{id}/agenda`
  ersetzt in ChurchTools den kompletten Plan; bei einer Messung der MBG Lemgo
  verschwanden dabei sechs Lieder. `ct_create_agenda` legt weiter nur an, wo es
  noch keinen Plan gibt.
- Doku: eigenes Dienstkonto mit wenigen Rechten statt des Kontos eines
  Mitarbeiters, erst lesend, dann Probemodus, Termine zuerst in einem
  Testkalender; lesend liefert der Assistent einen Ablauf als Struktur, die ein
  Mensch einträgt.
- `churchtools.createServer(config)` liest ohne `modus` nur; `probe: true`
  schaltet den Probemodus ein.

## 0.3.0 – 30.09.2026

- **Neu: `psalmio churchtools-mcp`** – ein MCP-Server für das ChurchTools
  einer Gemeinde, unabhängig von Psalmio. Ein KI-Assistent legt damit
  Ablaufpläne an (aus Einträgen, einer Vorlage oder als Kopie – nie über einen
  vorhandenen), ändert und verschiebt Einträge, sieht Termine, Dienste, Lieder,
  Personen, Gruppen und Kalender nach, teilt Dienste ein und legt
  Kalendereinträge an. Für alles Übrige sucht er in der API-Beschreibung, die
  das ChurchTools selbst ausliefert, und ruft beliebige Wege auf. Er arbeitet
  mit dem Login-Token einer Person (`CHURCHTOOLS_URL`, `CHURCHTOOLS_TOKEN`
  oder `--token-file`) und in drei Stufen: `--read-only`, Vorgabe (ohne
  Löschen), `--allow-delete`. Anmeldung und Zugangsdaten, Finanzen und das
  Systemprotokoll sind in jeder Stufe gesperrt; Rechte, Systemeinstellungen,
  Automatisierungen und Massenversand nur lesbar; Zustimmungen schreibt er für
  niemanden. Zeiten ohne Versatz gelten als Ortszeit (`--timezone`, Vorgabe
  `Europe/Berlin`), Antworten nennen Zulu- und Ortszeit. Einrichtung, Werkzeuge
  und Grenzen in `docs/CHURCHTOOLS.md`.
- Bibliothek: `churchtools.createServer(config)` und
  `churchtools.serve(config, { input, output })`.
- Das Protokoll beider Server steht jetzt in `src/mcp-core.js`; die Prüfung der
  Eingaben kennt dabei feste Werte (`enum`), verschachtelte Objekte und Listen
  von Objekten. `psalmio mcp` verhält sich unverändert.
- Bestehende Befehle und Rückgabewerte sind unverändert.

## 0.2.0 – 29.09.2026

- **Neu: `psalmio mcp`** – ein MCP-Server (Model Context Protocol) über
  stdin/stdout, mit dem ein KI-Assistent (Claude Desktop, Claude Code, andere
  Clients) an der Psalmio-API arbeitet: Gottesdienste und Beiträge lesen und
  ihre Stammdaten ändern, Transkripte holen, Dateien und Verarbeitungsstand
  ansehen, Aufnahmen hochladen, eine Neuigkeit anlegen, Termine und
  Hörstatistik lesen. Braucht einen Key mit der neuen Berechtigung „KI-Agent";
  keine Werkzeuge zum Löschen, zu Mitgliedern oder Einstellungen. Ohne
  Fremdabhängigkeiten wie der Rest. Einrichtung und Grenzen in `docs/MCP.md`.
- Bibliothek: `mcp.createServer(config)` und `mcp.serve(config, { input, output })`;
  `request(config, method, path, body)` für Aufrufe jenseits der
  Videotechnik-Schnittstelle (`call` bleibt, wie es war).
- Bestehende Befehle und Rückgabewerte sind unverändert.

## 0.1.2 – 23.09.2026

Aus dem Gegenlesen von Tim Fast (Stand `v0.1.1`):

- **Befehlsnamen wie Eigenschaften des Objekt-Prototyps.** `psalmio constructor
  --json` oder `psalmio __proto__ --json` endeten mit 1 und „erlaubt.has is not a
  function" statt mit 64 – die Optionslisten je Befehl lagen in einem Objekt.
  Jetzt eine `Map`.
- **Zeiten werden geprüft.** `--at` und `--started-at` nahmen jeden Wert: „2026"
  landete 1970, ein Zeitstempel in Millisekunden im Jahr 58698, der Aufruf
  endete mit 0. Jetzt nur Unix-Sekunden oder ISO-Zeit zwischen 1990 und morgen;
  alles andere endet mit 64, bevor Psalmio gefragt wird (bei Millisekunden mit
  Hinweis). Eine unlesbare Zeitangabe endet ebenfalls mit 64 statt mit 1.
- **README am Tag.** Am Tag `v0.1.1` stand in der README noch die
  Installationszeile mit `#v0.1.0`; ab hier nennt sie die Fassung, in der sie
  steht. Getaggte Stände werden nicht verschoben.
- Richtiggestellt zu 0.1.1: Von den vier neuen Tests schlagen am alten Stand
  drei an; der vierte hält das Fortsetzen fest, das schon richtig war, und trägt
  am neuen Stand trotzdem.

## 0.1.1 – 23.09.2026

Aus der Nachstellung von Tim Fast (Stand `ee98699`, getaggt als `v0.1.0`):

- **Kein endloser Neustart mehr, wenn Psalmio den Upload beim Zusammenfügen
  verwirft (Issue #1).** Meldete `multipart/complete` 404 `UPLOAD_NOT_RESUMABLE`
  – etwa weil der Speicher einen halben Upload nach einem Tag verwirft, und
  15 GB über Nacht reichen dafür –, begann `runBatch` von vorn, ohne den Versuch
  zu zählen: 709 Starts und 2124 PUTs in anderthalb Sekunden, die nächste Zeile
  des Manifests kam nie dran. Ungezählt neu beginnt es jetzt nur noch, wenn die
  Absage beim *Fortsetzen* kommt (Stufe `resume`). Beim Zusammenfügen zählt der
  Versuch, der Termin endet als gescheitert, und der Stand vergisst die Kennung,
  die der Server nicht mehr kennt – der nächste Lauf beginnt von vorn.
  `psalmio upload` löscht in dem Fall seine Merkdatei und rät zu einem neuen
  Upload statt zu `--resume`.
- **Optionen gelten je Befehl.** Die Listen bekannter Optionen galten für alle
  Befehle; `psalmio upload aufnahme.mp4 --event 9 --dry-run` lud deshalb
  wirklich hoch und endete mit 0. Eine Option am falschen Befehl endet jetzt mit
  Rückgabewert 64, bevor irgendetwas passiert.

## 0.1.0 – 23.09.2026

Erste Fassung, herausgelöst aus der Psalmio-Anbindung in der Workflow Engine der
MBG Lemgo (eingebaut von Samuel Funk, gehärtet und getestet von Tim Fast).

- Aufrufe der Videotechnik-Schnittstelle: Status, Termin, Start, Upload (einzelner PUT)
- Neu: Upload in Teilen (`startMultipart`, `resumeMultipart`, `completeMultipart`,
  `abortMultipart`) und `uploadRecording` für den ganzen Weg samt Wiederholen,
  Fortsetzen und Ausweichen auf den einzelnen PUT
- Neu: Kommandozeile `psalmio`
- Neu: `runBatch` / `psalmio batch` für ganze Archive – wartet auf den Server,
  merkt sich den Stand, überspringt Absagen
- Ohne Fremdabhängigkeiten: `fetch` statt axios (Node ≥ 18.17)

### Aus der Durchsicht von Tim Fast (Stand ccd5197)

- **Fortsetzen gilt einer bestimmten Datei.** Zur `uploadId` gehören Pfad, Größe
  und Änderungszeit (`onUploadStart` meldet sie, `resumeFile` prüft sie). Lag
  unter dem Pfad inzwischen etwas anderes, wurden Teile zweier Dateien still zu
  einer Aufnahme – jetzt gibt es `RESUME_FILE_MISMATCH`. Auch ein Plan, der
  nicht zur Datei passt, fällt auf (`RESUME_PLAN_MISMATCH`).
- **Die Kennung steht fest, bevor das erste Byte fließt.** `onUploadStart` meldet
  sie, sobald der Server sie ausgestellt hat; `runBatch` schreibt sie sofort in
  den Stand. Vorher war sie erst bekannt, wenn `uploadRecording` zurückkam – nach
  einem Stromausfall gab es also nichts fortzusetzen. Eine geänderte Datei lässt
  `runBatch` den halben Upload verwerfen (`abort`) und neu beginnen.
- **Das Zeitfenster gilt auch nach dem Warten.** `runBatch` prüft `window` auch
  nach dem Warten auf die Queue, nicht nur davor – sonst begann ein Upload nach
  stundenlanger Warterei mitten im Gottesdienst. Neu: `parseWindow(text, zone)`
  und `--window-tz`, damit „22:00-06:00" auf einem Server in UTC nicht 0 bis 8
  Uhr deutscher Zeit heißt. Die benutzte Zone steht in `zone` und in der Ausgabe.
- **Ein Manifest nennt alle doppelten Termine auf einmal**, statt beim ersten
  abzubrechen – wer eine Zuordnungsdatei bereinigt, will sie in einem Durchgang
  sehen.

### Aus der zweiten Durchsicht von Tim Fast (Stand 6bc74e8)

- **Kein Fortsetzen ohne Fingerabdruck.** `psalmio upload --resume <id>` gab der
  Bibliothek keinen `resumeFile` mit, und `uploadRecording` übersprang die
  Prüfung dann ganz: Eine gleich groß neu geschriebene Datei wurde mit den Teilen
  der alten zu einer Aufnahme. Jetzt lehnt `uploadRecording` eine `uploadId`
  ohne vollständigen Fingerabdruck ab (`RESUME_FILE_MISSING`, Stufe `resume`),
  bevor Psalmio gefragt wird; der Abgleich prüft Pfad, Größe und Änderungszeit
  ohne Ausnahme.
- **Die Kommandozeile merkt sich den Fingerabdruck.** `psalmio upload` schreibt
  Kennung und Fingerabdruck in `<datei>.psalmio-upload.json` (oder `--state`),
  sobald Psalmio den Upload eröffnet hat; `--resume` liest sie dort. Die Kennung
  von Hand (`--resume <id>`) gibt es nicht mehr – die alte Form endet mit 64.
  Ein neuer Start ohne `--resume` gibt den halben Upload von vorher zurück.
- **`onUploadStart` wird abgewartet und abgefangen.** Er darf eine Promise
  liefern; scheitert er, endet der Upload vor dem ersten Byte
  (`UPLOAD_START_HOOK_FAILED`), und ein eben eröffneter Upload wird zurückgegeben.
- **Optionen als `--name=wert`.** `--window-tz=Europe/Berlin` fiel vorher still
  weg – mit ihm das ganze Zeitfenster. Unbekannte Optionen und fehlende Werte
  enden jetzt mit Rückgabewert 64.
- `runBatch` gibt auch einen Upload zurück, dessen Stand keinen vollständigen
  Fingerabdruck trägt, und beginnt neu.
- Zur Frage nach dem Plan: Psalmio rechnet ihn beim Fortsetzen aus der gesendeten
  Größe neu. Gegen eine andere Datei gleicher Größe schützt allein der
  Fingerabdruck – steht jetzt so in `docs/API.md` und im README.

### Für den Umstieg aus der Workflow Engine

- `completeUpload(config, eventId, deps)` → `completeUpload(config, eventId, { recordingStartedAt }, deps)`
- Unterschieben in Tests: `deps.fetch` statt `deps.axios`
- In der Engine bleiben: `SETTING_KEYS`, `readConfig`, `isActive` (hängen an Prisma und den Einstellungen dort)
- `isTemporaryOutage` deckt jetzt auch `OBJECT_STORAGE_UNAVAILABLE` ab (weiterhin: jeder 503)
