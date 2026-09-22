# Änderungen

## 0.1.0 – noch nicht veröffentlicht

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

### Für den Umstieg aus der Workflow Engine

- `completeUpload(config, eventId, deps)` → `completeUpload(config, eventId, { recordingStartedAt }, deps)`
- Unterschieben in Tests: `deps.fetch` statt `deps.axios`
- In der Engine bleiben: `SETTING_KEYS`, `readConfig`, `isActive` (hängen an Prisma und den Einstellungen dort)
- `isTemporaryOutage` deckt jetzt auch `OBJECT_STORAGE_UNAVAILABLE` ab (weiterhin: jeder 503)
