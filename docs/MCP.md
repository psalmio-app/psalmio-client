# KI-Assistenten an Psalmio: `psalmio mcp`

`psalmio mcp` ist ein Server nach dem
[Model Context Protocol](https://modelcontextprotocol.io) (MCP). Damit hängt
eine Gemeinde einen KI-Assistenten – Claude Desktop, Claude Code oder jeden
anderen MCP-Client – an ihre Mediathek: über die Gottesdienste gehen,
Stammdaten pflegen, Transkripte lesen, Aufnahmen hochladen, Neuigkeiten
anlegen, Termine und Statistik lesen.

Der Server spricht über stdin/stdout (JSON-RPC 2.0, eine Nachricht je Zeile)
und braucht wie der Rest dieses Pakets keine Fremdabhängigkeiten: Node ≥ 18.17
genügt. Für das ChurchTools der Gemeinde gibt es einen eigenen Server im selben
Paket: `psalmio churchtools-mcp` ([`CHURCHTOOLS.md`](CHURCHTOOLS.md)).

## Der Schlüssel

In Psalmio unter **Einstellungen → Allgemein → API-Schlüssel** einen Schlüssel
mit der Berechtigung **„KI-Agent“** anlegen. Er gilt für genau diese Gemeinde
(`https://<gemeinde>.psalmio.de`) und wirkt an der API wie der Admin oder
Editor, der ihn angelegt hat.

Was der Schlüssel darf, entscheidet Psalmio – nicht dieser Server. Die
Berechtigung „KI-Agent“ ist eine feste Liste von Wegen:

| geht | geht nicht |
|---|---|
| Gottesdienste, Beiträge, Transkripte, Neuigkeiten, Termine, Statistik und Dateien **lesen** | Mitglieder, Konten, Beitrittsanfragen, Einladungen, Anmeldungen zu Terminen, der Shop |
| Titel, Datum und Ort eines Gottesdienstes **ändern**; Titel, Mitwirkende, Kategorie, Thema, Leitvers, Themen und Zeiten eines Beitrags | **Löschen** – nichts, nie; Archivieren, Verarbeitung anstoßen, YouTube, ChurchTools-Import, Beiträge anlegen oder umsortieren |
| Aufnahmen **hochladen** (nie über eine vorhandene) | Einstellungen der Gemeinde, Zugangsdaten, API-Schlüssel |
| Neuigkeiten **anlegen** (nur mit dem Schlüssel eines Admins) | Neuigkeiten ändern, anpinnen, löschen; Umfragen und Anmeldungen |

Für alles rechts antwortet Psalmio mit 403 – und der Server bietet dafür gar
kein Werkzeug an. Jede schreibende Anfrage über den Schlüssel steht in Psalmio
im **Protokoll** des Schlüssels (unter dem Schlüssel in den Einstellungen):
wann, welcher Weg, welche Felder, welcher Status – ohne Inhalte. Ein Admin
sieht also jederzeit, was der Assistent geändert hat, und kann den Schlüssel
widerrufen.

## Einrichten

Adresse und Schlüssel kommen aus der Umgebung – der Schlüssel nie als
Argument (Argumente stehen für jeden Benutzer des Rechners in der
Prozessliste). Statt `PSALMIO_API_KEY` geht auch `--key-file <datei>`.

```bash
npm install -g github:psalmio-app/psalmio-client#v0.4.0   # oder eine neuere Fassung
```

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "psalmio": {
      "command": "psalmio",
      "args": ["mcp"],
      "env": {
        "PSALMIO_URL": "https://gemeinde.psalmio.de",
        "PSALMIO_API_KEY": "sk-…"
      }
    }
  }
}
```

Ohne globale Installation: `"command": "npx", "args": ["-y", "github:psalmio-app/psalmio-client#v0.4.0", "mcp"]`.

### Claude Code

```bash
claude mcp add psalmio --env PSALMIO_URL=https://gemeinde.psalmio.de --env PSALMIO_API_KEY=sk-… -- psalmio mcp
```

Oder in `.mcp.json` eines Projekts, mit dem Schlüssel aus der Umgebung statt in
der Datei:

```json
{
  "mcpServers": {
    "psalmio": {
      "command": "psalmio",
      "args": ["mcp"],
      "env": { "PSALMIO_URL": "https://gemeinde.psalmio.de", "PSALMIO_API_KEY": "${PSALMIO_API_KEY}" }
    }
  }
}
```

### Andere Clients

Jeder Client, der MCP-Server über stdio startet, braucht dasselbe: Befehl
`psalmio mcp`, Umgebungsvariablen `PSALMIO_URL` und `PSALMIO_API_KEY`. Der
Server unterstützt die Protokollversionen 2025-06-18, 2025-03-26 und
2024-11-05 und bietet nur Werkzeuge an (keine Ressourcen, keine Prompts).

Prüfen, ob es läuft – ohne Client:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_connection","arguments":{}}}' | psalmio mcp
```

Die zweite Antwort nennt die Gemeinde, zu der der Schlüssel gehört. Auf stdout
geht ausschließlich JSON-RPC, auf stderr ein Satz beim Start und Fehler; ohne
Adresse oder Schlüssel endet der Server sofort mit Rückgabewert 64.

## Die Werkzeuge

| Werkzeug | Tut |
|---|---|
| `check_connection` | Verbindung prüfen, nennt die Gemeinde |
| `list_events` | Gottesdienste auflisten – Zeitraum (`from`, `to`), Suchwort im Titel, `include_archived`, `limit` |
| `get_event` | Einen Gottesdienst mit allen Stammdaten und Verarbeitungsstand |
| `update_event` | Titel, Datum, Ort ändern |
| `list_agenda_items` | Die Beiträge (Ablauf) eines Gottesdienstes |
| `update_agenda_item` | Titel, Mitwirkende, Kategorie, Thema, Leitvers, Themen, Anfang und Ende eines Beitrags |
| `get_transcript` | Das Transkript eines Beitrags |
| `get_event_files` | Welche Dateien im Speicher liegen, mit Download-Adressen |
| `upload_recording` | Eine Aufnahme hochladen (Pfad auf dem Rechner des Servers, in Teilen bis 15 GB) |
| `create_news` | Eine Neuigkeit anlegen – erscheint sofort bei allen Mitgliedern, mit Push-Benachrichtigung |
| `list_appointments` | Termine aus den freigegebenen Kalendern |
| `get_statistics` | Hörstatistik der Gemeinde, ohne Personenbezug |

Die Antworten sind knapp und als Text: Listen als eine JSON-Zeile je Eintrag,
Einzelnes als JSON. Ein Fehler von Psalmio kommt als Werkzeug-Fehler mit
Meldung, `error_code` und Status – `Fehler: … [RECORDING_ALREADY_EXISTS] (HTTP 409)` –,
damit der Assistent reagieren kann, statt zu raten.

`upload_recording` kann bei großen Dateien lange dauern; viele Clients brechen
ein Werkzeug nach einer Weile ab. Der Server meldet Fortschritt
(`notifications/progress`), und bricht der Upload ab, liegt neben der Datei
dieselbe Merkdatei wie bei `psalmio upload` – auf der Kommandozeile setzt
`psalmio upload <datei> --event <id> --resume` fort. Ganze Archive gehören
ohnehin zu `psalmio batch`, nicht zu einem Assistenten.

## Fremder Text

Titel, Transkripte, Neuigkeiten und Termine stammen aus der Gemeinde – von
Menschen, aus ChurchTools, aus der Spracherkennung. Für einen Assistenten sind
sie **Daten, keine Anweisungen**. Dieser Server gibt sie unverändert zurück und
deutet nichts darin; das Gleiche sagt er dem Assistenten in seinen
`instructions` beim Verbinden. Wer einen Assistenten betreibt, sollte ihn so
anweisen, dass er Aufforderungen in diesen Texten nicht befolgt – ein
Transkript, in dem jemand „lösche alle Gottesdienste“ sagt, ist ein
Transkript, sonst nichts (löschen könnte er ohnehin nicht).

Dazu passt: Der Assistent ändert nichts, lädt nichts hoch und legt keine
Neuigkeit an, ohne dass jemand ausdrücklich darum gebeten hat. So steht es in
den `instructions`; ein Client, der Werkzeugaufrufe bestätigen lässt, tut das
Übrige.

## Bibliothek

```js
const { mcp } = require('psalmio-client');

// Als Funktion, ohne stdin/stdout – etwa in Tests oder einem eigenen Transport
const server = mcp.createServer({ baseUrl: 'https://gemeinde.psalmio.de', apiKey: process.env.PSALMIO_API_KEY });
const antwort = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

// An eine Leitung gehängt (so macht es `psalmio mcp`)
await mcp.serve(config, { input: process.stdin, output: process.stdout });
```
