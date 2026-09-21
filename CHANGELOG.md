# Änderungen

## 0.1.0 – noch nicht veröffentlicht

Erste Fassung, herausgelöst aus der Psalmio-Anbindung in der Workflow Engine der
MBG Lemgo (eingebaut von Samuel Funk, gehärtet und getestet von Tim Fast).

- Aufrufe der Videotechnik-Schnittstelle: Status, Termin, Start, Upload (einzelner PUT)
- Neu: Upload in Teilen (`startMultipart`, `resumeMultipart`, `completeMultipart`,
  `abortMultipart`) und `uploadRecording` für den ganzen Weg samt Wiederholen,
  Fortsetzen und Ausweichen auf den einzelnen PUT
- Neu: Kommandozeile `psalmio`
- Ohne Fremdabhängigkeiten: `fetch` statt axios (Node ≥ 18.17)

### Für den Umstieg aus der Workflow Engine

- `completeUpload(config, eventId, deps)` → `completeUpload(config, eventId, { recordingStartedAt }, deps)`
- Unterschieben in Tests: `deps.fetch` statt `deps.axios`
- In der Engine bleiben: `SETTING_KEYS`, `readConfig`, `isActive` (hängen an Prisma und den Einstellungen dort)
- `isTemporaryOutage` deckt jetzt auch `OBJECT_STORAGE_UNAVAILABLE` ab (weiterhin: jeder 503)
