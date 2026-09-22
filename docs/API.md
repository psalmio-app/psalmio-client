# Die Videotechnik-Schnittstelle von Psalmio

Das ist der Vertrag, an den sich diese Bibliothek hält – und jeder, der in einer
anderen Sprache einen eigenen Client baut. Er ändert sich nur abwärtskompatibel:
Felder und Endpunkte kommen dazu, bestehende behalten ihre Bedeutung.

**Basis:** `https://<gemeinde>.psalmio.de/api/v1/integrations/videotech`
**Anmeldung:** Header `X-API-Key: <key>` – ausgestellt in Psalmio unter
Einstellungen → API-Keys, Berechtigung „Videotechnik". Der Key gilt für genau
eine Gemeinde; welche, entscheidet die Adresse.

Zeitstempel sind Unix-Sekunden (UTC). Erfolgreiche Antworten tragen die
Nutzlast unter `data`.

## Fehler

```json
{ "detail": { "error_code": "EVENT_NOT_FOUND", "message": "…" } }
```

Am `error_code` hängt die Reaktion, nicht am Text. Ein 404 **ohne** `error_code`
(`{"detail": "Not Found"}`) heißt: Diesen Pfad gibt es in dieser Psalmio-Fassung
nicht – nicht: Der Termin fehlt.

| Status | Code | Bedeutung | Reaktion |
|---|---|---|---|
| 404 | `EVENT_NOT_FOUND` | Psalmio führt diesen Termin nicht (anderer Kalender, ausgeschlossen, gelöscht) | still überspringen |
| 503 | `CHURCHTOOLS_UNAVAILABLE`, `EVENT_IMPORT_FAILED` | Termin ließ sich gerade nicht aus ChurchTools holen | später wiederholen |
| 503 | `OBJECT_STORAGE_UNAVAILABLE` | Dateispeicher gerade nicht erreichbar | später wiederholen – nichts ist verloren |
| 409 | `RECORDING_ALREADY_EXISTS`, `EVENT_HAS_FILES`, `PROCESSING_IN_PROGRESS` | Für den Termin liegt schon etwas vor oder wird verarbeitet | nicht wiederholen; Vorhandenes wird nie überschrieben |
| 409 | `UPLOAD_INCOMPLETE` | Es fehlen Teile oder Bytes | mit `resume` fortsetzen |
| 404 | `UPLOAD_NOT_FOUND` | Nichts im Speicher gefunden | Upload wiederholen |
| 404 | `UPLOAD_NOT_RESUMABLE` | Upload-Kennung unbekannt oder abgelaufen | neu eröffnen |
| 422 | `UPLOAD_EMPTY` | Die hochgeladene Datei ist leer (wurde entfernt) | Upload wiederholen |
| 413 / 422 | `FILE_TOO_LARGE` | über 5 GB (einzelner PUT) bzw. 15 GB (in Teilen) | – |
| 422 | `INVALID_FILE_SIZE` | `file_size` ≤ 0 | – |
| 422 | `TIMESTAMP_IN_FUTURE` | mehr als 5 Minuten in der Zukunft | Uhr prüfen |
| 422 | `TIMESTAMP_TOO_OLD` | außerhalb des Termintags ± 12 h (Europe/Berlin) | – |
| 422 | `OFFSET_TOO_LARGE` | Aufnahmebeginn weicht mehr als 3 h vom Start ab | – |
| 401 / 403 | – | Key fehlt, ist ungültig oder hat die Berechtigung nicht | Einrichtung prüfen |

## Endpunkte

### `GET /status`
Verbindungstest. `data: { tenant }` – die Gemeinde, zu der der Key gehört.

### `GET /queue`
`data: { active, running, pending, idle }` – wie viel Ton- und Bildverarbeitung
bei dieser Gemeinde ansteht. Für Massen-Uploads: erst weiterladen, wenn `idle`.
Der Server verarbeitet nacheinander; wer schneller hochlädt, stapelt nur Arbeit.

### `GET /events/{event_id}`
`data: { event_id, title, event_date, location, event_start_timestamp, processed, audio_processing_complete }`

### `POST /events/{event_id}/start`
```json
{ "started_at": 1789890656, "source": "recording" }
```
Setzt den Start **nur, wenn noch keiner gesetzt ist**. Lief der Termin schon
(im Live-Editor gestartet oder von einem früheren Aufruf), bleibt er unberührt
und die Antwort trägt `already_started: true` – ein Erfolg, kein Konflikt.
`source`: `recording` | `live` | `manual`.

`started_at` ist der Augenblick, in dem die Aufnahme begann – nicht der, in dem
der Aufruf abgeschickt wird. Alle Zeiten im Ablauf zählen ab dort.

Kennt Psalmio den Termin noch nicht, holt es ihn bei diesem Aufruf selbst aus
ChurchTools (ebenso bei `upload-url`, `complete` und `multipart/start`).

### Aufnahme hochladen – einzelner PUT (bis 5 GB)

1. `POST /events/{event_id}/recording/upload-url` mit `{ "file_size": 123, "file_name": "…" }`
   → `data: { upload_url, object_name, method: "PUT", expires_in: 21600, max_file_size }`
2. `PUT <upload_url>` – die Datei, mit exakter `Content-Length`, direkt in den Speicher
3. `POST /events/{event_id}/recording/complete` mit `{ "recording_started_at": 1789890600 }` (optional)
   → `data: { …Termin, job_id, file_size, offset_seconds, shifted_agenda_items }`

### Aufnahme hochladen – in Teilen (bis 15 GB)

Lohnt sich über 5 GB und immer, wenn die Leitung wackelt: Ein gescheiterter Teil
wird einzeln wiederholt, und nach einem Abbruch geht es an derselben Stelle weiter.

1. `POST /events/{event_id}/recording/multipart/start` mit `{ "file_size": 123, "file_name": "…" }`
   → `data: { upload_id, object_name, method: "PUT", part_size, part_count, urls: { "1": "…", "2": "…" }, expires_in: 21600, max_file_size }`
2. Je Teil `PUT urls[n]` mit den Bytes `(n-1)·part_size … n·part_size - 1`; nur der
   letzte Teil ist kleiner. Reihenfolge und Gleichzeitigkeit sind frei. Die ETags
   braucht der Client nicht – Psalmio liest sie selbst aus dem Speicher.
3. `POST /events/{event_id}/recording/multipart/complete` mit
   `{ "upload_id": "…", "file_size": 123, "recording_started_at": 1789890600 }`
   → Antwort wie beim einzelnen PUT.

   **`file_size` ist Pflicht und dient als Prüfsumme.** Fehlt ein Teil in der
   Mitte, sieht man es an den Nummern; fehlt der letzte, sind sie lückenlos –
   das fällt nur an der Summe auf. Zu wenig → `409 UPLOAD_INCOMPLETE` (nichts
   wird verworfen). Zu viel → `413 FILE_TOO_LARGE` (die Teile werden verworfen).

Nach einem Abbruch: `POST …/multipart/resume` mit `{ "upload_id", "file_size" }`
→ wie `start`, dazu `parts_done` (nur vollständige Teile) und frische Adressen
für alle Teile.

Aufgeben: `POST …/multipart/abort` mit `{ "upload_id" }`. **Nötig ist der Aufruf
nicht, sinnvoll schon:** Jeder Gemeinde-Bucket trägt eine Regel, die angefangene
Uploads nach einem Tag von selbst verwirft (`AbortIncompleteMultipartUpload`,
gesetzt beim Einrichten der Gemeinde). Ein Client, der abstürzt, hinterlässt
also keinen Müll, der bleibt. Wer aber **weiß**, dass er einen halben Upload
nicht mehr braucht – die Datei hat sich geändert, der Termin ist weg –, gibt ihn
besser gleich zurück, statt einen Tag lang Speicher zu belegen. Nach einem
Fehler, der sich wiederholen lässt, gilt das Gegenteil: Dort **nicht** abbrechen,
sonst ist das Fortsetzen verloren.

### `recording_started_at`

Begann die Aufnahme mindestens 2 Sekunden vor oder nach dem gesetzten Start,
verschiebt Psalmio alle Zeiten im Ablauf um die Differenz und setzt den Start
auf den Aufnahmebeginn – damit jeder Sprungpunkt in der Mediathek auf die
richtige Stelle der Datei zeigt. `offset_seconds` und `shifted_agenda_items` in
der Antwort sagen, was verschoben wurde.

### Was Psalmio mit der Datei macht

Entspricht sie schon der Stream-Spezifikation (H.264, höchstens 1920×1080 und
50 fps, Gesamtbitrate höchstens 6 Mbit/s), wird das Bild unverändert übernommen
und nur bei Bedarf der Ton auf AAC getauscht. Sonst wird neu gerechnet. Wer vor
dem Upload selbst passend komprimiert, spart Psalmio die Rechenzeit und sich die
Wartezeit bis zur Veröffentlichung.
