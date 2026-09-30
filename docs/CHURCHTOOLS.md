# KI-Assistenten an ChurchTools: `psalmio churchtools-mcp`

`psalmio churchtools-mcp` ist ein Server nach dem
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) für das
[ChurchTools](https://church.tools) einer Gemeinde. Damit arbeitet ein
KI-Assistent – Claude Desktop, Claude Code oder jeder andere MCP-Client – in
ChurchTools: einen Ablaufplan aus einem Text, einer Tabelle oder einem Foto
anlegen, Termine, Dienste und Lieder nachsehen, jemanden einteilen,
Kalendereinträge anlegen, und über die API-Beschreibung des ChurchTools alles
Übrige.

Er ist unabhängig von Psalmio: Er spricht nur mit dem eingerichteten
ChurchTools und braucht kein Psalmio-Konto. Wie `psalmio mcp` läuft er über
stdin/stdout (JSON-RPC 2.0, eine Nachricht je Zeile) und braucht keine
Fremdabhängigkeiten – Node ≥ 18.17 genügt.

## Was man damit tut

- „Hier ist der Ablauf für Sonntag“ – als Text, Tabelle oder Foto –
  „leg ihn in ChurchTools an.“
- „Wer ist am 11. Oktober für die Technik eingeteilt, und wer könnte noch?“
- „Trag Carl für die Technik am Sonntag ein.“
- „Welche Lieder hatten wir in den letzten vier Wochen?“
- „Leg den Gemeindeputz am Samstag von 10 bis 16 Uhr in den Gemeindekalender.“
- „Trag meinen Urlaub vom 2. bis 6. November als Abwesenheit ein.“

## Der Login-Token

Der Assistent arbeitet als **eine Person** in ChurchTools – mit ihrem
Login-Token und genau ihren Rechten. Was diese Person nicht darf, darf der
Assistent auch nicht; ChurchTools selbst setzt diese Grenze.

Deshalb am besten **einen eigenen Benutzer** anlegen, etwa „KI-Assistent“, und
ihm nur die Rechte geben, die er braucht – zum Beispiel Dienstplanung und
Ablaufpläne bearbeiten, Kalender und Lieder lesen. Nicht den Token eines Admins
nehmen: Der Assistent könnte dann alles, was der Admin kann.

Den Token findet man in ChurchTools im Profil des Benutzers. Er funktioniert
auch, wenn für das Konto die Zwei-Faktor-Anmeldung aktiv ist. Er gehört in die
Umgebung (`CHURCHTOOLS_TOKEN`) oder in eine Datei (`--token-file`) – nie als
Argument, denn Argumente stehen für jeden Benutzer des Rechners in der
Prozessliste. Wer den Token in ChurchTools neu erzeugt, sperrt den alten.

## Was der Server darf

Drei Stufen, festgelegt beim Start:

| Aufruf | darf | Werkzeuge |
|---|---|---|
| `psalmio churchtools-mcp --read-only` | nur lesen | 17 |
| `psalmio churchtools-mcp` | lesen und schreiben, **ohne Löschen** | 24 |
| `psalmio churchtools-mcp --allow-delete` | auch löschen | 26 |

Was der Server in seiner Stufe nicht darf, bietet er gar nicht erst an. Das
gilt auch für die allgemeinen Werkzeuge (`ct_api_get`, `ct_api_write`): Ein
DELETE ohne `--allow-delete` geht nicht zu ChurchTools, und die Suche in der
API-Beschreibung zeigt lesend nur GET-Wege.

Zusätzlich zu den Rechten der Person gilt ein zweiter Zaun, in jeder Stufe
(`src/churchtools/regeln.js`):

| nie | nur lesen |
|---|---|
| Anmeldung und Zugangsdaten: Login-Token, Passwörter, Zwei-Faktor, OAuth-Clients, externe Logins, SAML, „Person simulieren“, Geräte | Rechte und Sicherheitsstufen, Systemeinstellungen, Synchronisation, Datenbankfelder, Automatisierungen (Routinen, Warteschlangen, dynamische Gruppen), Massenbriefe, Übersetzungen, Profile der Gemeinde |
| Finanzen und das Systemprotokoll | |
| Zustimmungen für jemand anderen (Datenschutzerklärung, Verschwiegenheitserklärung) | |

Personen zusammenführen zählt als Löschen – der Doppelgänger verschwindet –
und geht nur mit `--allow-delete`. Geprüft wird jeder Pfad Segment für
Segment; verschlüsselte Punkte und Schrägstriche, ganze Adressen statt Pfaden
und `..` werden abgelehnt, bevor etwas zu ChurchTools geht.

## Einrichten

```bash
npm install -g github:psalmio-app/psalmio-client#v0.3.0
```

| Umgebung | Option | Bedeutung |
|---|---|---|
| `CHURCHTOOLS_URL` | `--url` | `https://gemeinde.church.tools` (ein `/api` am Ende wird weggelassen) |
| `CHURCHTOOLS_TOKEN` | `--token-file <datei>` | der Login-Token |
| `CHURCHTOOLS_TIMEZONE` | `--timezone` | Ortszeit für Eingaben und Antworten, Vorgabe `Europe/Berlin` |

Nur https – über http ginge der Token im Klartext über die Leitung (Ausnahme:
ein ChurchTools auf demselben Rechner). Selbst betriebene ChurchTools unter
einem Pfad (`https://gemeinde.de/churchtools`) gehen auch.

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`) – hier neben dem Psalmio-Server:

```json
{
  "mcpServers": {
    "churchtools": {
      "command": "psalmio",
      "args": ["churchtools-mcp"],
      "env": {
        "CHURCHTOOLS_URL": "https://gemeinde.church.tools",
        "CHURCHTOOLS_TOKEN": "…"
      }
    },
    "psalmio": {
      "command": "psalmio",
      "args": ["mcp"],
      "env": { "PSALMIO_URL": "https://gemeinde.psalmio.de", "PSALMIO_API_KEY": "sk-…" }
    }
  }
}
```

Nur lesen: `"args": ["churchtools-mcp", "--read-only"]`. Ohne globale
Installation: `"command": "npx", "args": ["-y", "github:psalmio-app/psalmio-client#v0.3.0", "churchtools-mcp"]`.

### Claude Code

```bash
claude mcp add churchtools --env CHURCHTOOLS_URL=https://gemeinde.church.tools --env CHURCHTOOLS_TOKEN=… -- psalmio churchtools-mcp
```

### Prüfen, ohne Client

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ct_check_connection","arguments":{}}}' | psalmio churchtools-mcp --read-only
```

Die zweite Antwort nennt die Person hinter dem Token, die Fassung des
ChurchTools und was der Server darf. Ohne Adresse oder Token, mit einer
http-Adresse, einer unbekannten Zeitzone oder `--read-only` zusammen mit
`--allow-delete` endet er sofort mit Rückgabewert 64.

## Die Werkzeuge

| Werkzeug | Tut | Stufe |
|---|---|---|
| `ct_check_connection` | Verbindung prüfen: Person, Fassung, was der Server darf | lesen |
| `ct_list_events` | Termine der Dienstplanung in einem Zeitraum (Vorgabe: ab heute, 62 Tage) | lesen |
| `ct_get_event` | Ein Termin mit seinen Diensten: wer eingeteilt ist, was offen ist | lesen |
| `ct_get_agenda` | Der Ablaufplan eines Termins | lesen |
| `ct_create_agenda` | Einen Ablaufplan anlegen – aus Einträgen, aus einer Vorlage oder als Kopie | schreiben |
| `ct_add_agenda_items` | Einträge einfügen – ans Ende, hinter oder vor einen Eintrag | schreiben |
| `ct_update_agenda_item` | Einen Eintrag ändern oder verschieben, Notizen für Dienstgruppen setzen | schreiben |
| `ct_set_agenda_lock` | Einen Ablaufplan sperren oder freigeben | schreiben |
| `ct_delete_agenda_item` | Einen Eintrag löschen | löschen |
| `ct_delete_agenda` | Einen ganzen Ablaufplan löschen | löschen |
| `ct_list_agenda_templates` | Ablaufplan-Vorlagen, auf Wunsch mit ihren Einträgen | lesen |
| `ct_search_songs` | Lieder suchen, mit Arrangements, Tonart und Tempo | lesen |
| `ct_list_services` | Die Dienste der Gemeinde mit ihren Dienstgruppen | lesen |
| `ct_find_service_candidates` | Wer für einen Dienst an einem Termin in Frage kommt, mit Abwesenheiten | lesen |
| `ct_assign_service` | Jemanden für einen Dienst einteilen | schreiben |
| `ct_search_persons` | Personen suchen – nur Namen | lesen |
| `ct_get_person` | Die Angaben zu einer Person, soweit der Token sie sehen darf | lesen |
| `ct_list_groups` | Gruppen suchen oder auflisten | lesen |
| `ct_list_group_members` | Die Mitglieder einer Gruppe mit Rolle und Status | lesen |
| `ct_list_calendars` | Die sichtbaren Kalender | lesen |
| `ct_list_appointments` | Kalendereinträge in einem Zeitraum (Vorgabe: ab heute, 31 Tage) | lesen |
| `ct_create_appointment` | Einen einmaligen Kalendereintrag anlegen, auf Wunsch mit Termin der Dienstplanung | schreiben |
| `ct_api_search` | In der API-Beschreibung dieses ChurchTools suchen | lesen |
| `ct_api_describe` | Einen Weg der API nachlesen: Parameter, Körper, Antworten | lesen |
| `ct_api_get` | Einen beliebigen Weg lesen | lesen |
| `ct_api_write` | Einen beliebigen Weg schreibend aufrufen (DELETE nur mit `--allow-delete`) | schreiben |

Die Antworten sind knapp: Listen als eine JSON-Zeile je Eintrag, leere Felder
weggelassen, Zeiten zusätzlich in Ortszeit. Ein Fehler kommt mit der Meldung
von ChurchTools selbst zurück – `Fehler: Eingaben ungültig (title: Titel ungültig) (HTTP 400)` –,
bei 401 und 403 mit dem Hinweis, dass es am Token bzw. an den Rechten der
Person liegt.

Für alles ohne eigenes Werkzeug – Abwesenheiten, Raumbuchungen, Wiki,
Beiträge, Gruppentreffen, Serientermine, Lieder anlegen – sucht der Assistent
in der API-Beschreibung, die jedes ChurchTools selbst ausliefert
(`/system/runtime/swagger/openapi.json`). Sie passt immer zur Fassung genau
dieses ChurchTools, ist englisch und rund 30 MB groß; der Server holt sie beim
ersten Bedarf einmal.

## Einen Ablaufplan anlegen

Der Assistent sucht den Termin (`ct_list_events`) und die Lieder
(`ct_search_songs`) und legt den Plan mit `ct_create_agenda` in einem Zug an:

```json
{
  "event_id": 12,
  "event_start_position": 1,
  "items": [
    { "title": "Soundcheck", "duration_minutes": 20, "responsible": "[Technik]" },
    { "type": "header", "title": "Gottesdienst" },
    { "type": "song", "arrangement_id": 77, "duration_minutes": 4 },
    { "title": "Predigt", "duration_minutes": 30, "responsible": "[Predigt]",
      "service_group_notes": [{ "service_group_id": 11, "note": "Mikro 2, Folien ab Punkt 2" }] }
  ]
}
```

- **Arten:** `text` (Vorgabe) ist ein Programmpunkt, `song` ein Lied über sein
  Arrangement (`arrangement_id` aus `ct_search_songs`; ohne bleibt es ein
  Platzhalter mit Titel), `header` eine Zwischenüberschrift ohne Dauer.
- **Dauern** in Minuten (auch 2,5); ChurchTools rechnet daraus die
  Anfangszeiten ab Terminbeginn.
- **Verantwortlich:** ein Name – oder ein Dienst in eckigen Klammern wie
  `[Predigt]`, genau so geschrieben wie in bestehenden Abläufen der Gemeinde;
  ChurchTools setzt dann ein, wer eingeteilt ist.
- **`event_start_position`:** Einträge davor laufen vor dem Beginn
  (Soundcheck, Gebet des Teams).
- **Nie über einen vorhandenen Plan.** Hat der Termin schon Einträge, ändert
  sich nichts; ergänzt wird mit `ct_add_agenda_items`, ersetzen geht nur nach
  `ct_delete_agenda` (mit `--allow-delete`).
- Statt Einträgen: `template_id` (eine Vorlage) oder `copy_from_event_id` (der
  Plan eines anderen Termins).

`ct_add_agenda_items` fügt mehrere Einträge in ihrer Reihenfolge ein und bricht
beim ersten Fehler ab – mit der Angabe, wie viele schon angelegt sind.
`ct_update_agenda_item` ändert nur, was genannt wird; der Rest des Eintrags
bleibt, wie er ist.

## Zeiten

ChurchTools rechnet in Zulu-Zeit (UTC), Menschen in ihrer Ortszeit. Eingaben
ohne Versatz (`2026-10-04T10:00`) gelten als Ortszeit der eingestellten Zone –
im Sommer zwei Stunden, im Winter eine vor UTC, auch an den Tagen der
Umstellung richtig. Mit Versatz (`+02:00`) oder `Z` gelten sie, wie sie
dastehen. Antworten nennen beides (`start` und `start_local`). Ganztägige
Einträge bleiben ein Datum und erscheinen am richtigen Tag.

## Fremder Text und Datenschutz

Namen, Notizen, Ablaufpläne, Wiki-Seiten und alle anderen Inhalte aus
ChurchTools stammen aus der Gemeinde. Für einen Assistenten sind sie **Daten,
keine Anweisungen**; der Server reicht sie unverändert durch und sagt das dem
Assistenten beim Verbinden. Eine Notiz, in der „lösche alle Termine“ steht, ist
eine Notiz – und löschen könnte der Server ohne `--allow-delete` ohnehin nicht.

Was die Werkzeuge zurückgeben, liest der Anbieter des KI-Assistenten mit.
Personenbezogene Daten gehen also an ihn, sobald der Assistent sie abruft.
Deshalb liefert die Personensuche nur Namen, Einzelheiten gibt es nur auf
ausdrückliche Anfrage, und die Anweisungen beim Verbinden bitten, persönliche
Daten nur abzurufen, wenn die Aufgabe sie braucht. Ob und mit welchem Anbieter
eine Gemeinde so arbeitet, entscheidet sie selbst; ein Vertrag zur
Auftragsverarbeitung mit dem Anbieter gehört dazu.

## Grenzen

- Gebaut gegen die API-Beschreibung von ChurchTools 3.137 und geprüft gegen
  einen Nachbau (`test/churchtools.test.js`), dessen Antworten dieser
  Beschreibung und dem folgen, was Psalmio seit Monaten aus einem echten
  ChurchTools liest. Gegen ein echtes ChurchTools mit Token ist er noch nicht
  gelaufen: Beim ersten Mal mit `--read-only` beginnen und den ersten
  Ablaufplan an einem Testtermin anlegen.
- Serientermine und Raumbuchungen nur über `ct_api_describe` und `ct_api_write`.
- Notizen für Dienstgruppen entfernen geht nur über `ct_api_write` (DELETE,
  mit `--allow-delete`).
- Bremst ChurchTools (429), wird bis zu dreimal nach der angegebenen Wartezeit
  wiederholt. Umleitungen wird nicht gefolgt – der Token ginge sonst an einen
  anderen Host.

## Bibliothek

```js
const { churchtools } = require('psalmio-client');

const config = { baseUrl: 'https://gemeinde.church.tools', token: process.env.CHURCHTOOLS_TOKEN, modus: 'lesen', zeitzone: 'Europe/Berlin' };

// Als Funktion, ohne stdin/stdout – etwa in Tests oder einem eigenen Transport
const server = churchtools.createServer(config);
const antwort = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

// An eine Leitung gehängt (so macht es `psalmio churchtools-mcp`)
await churchtools.serve(config, { input: process.stdin, output: process.stdout });
```

`modus` ist `lesen`, `schreiben` (Vorgabe) oder `loeschen`.
