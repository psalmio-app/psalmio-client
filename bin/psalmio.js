#!/usr/bin/env node
/**
 * psalmio – Aufnahmen und Startzeitpunkte von der Kommandozeile nach Psalmio.
 *
 * Für Gemeinden ohne eigene Automatisierung: ein Aufnahme-PC und eine geplante
 * Aufgabe genügen. Und für Massen-Uploads alter Gottesdienste: eine Schleife
 * über `psalmio upload`.
 *
 * Adresse und Key kommen aus der Umgebung (PSALMIO_URL, PSALMIO_API_KEY) oder
 * aus einer Datei (--key-file). Den Key als Argument gibt es mit Absicht nicht:
 * Argumente stehen für jeden Benutzer des Rechners lesbar in der Prozessliste.
 *
 * Rückgabewerte – damit ein Skript darauf reagieren kann:
 *   0  erledigt
 *   1  gescheitert
 *   2  Psalmio führt diesen Termin nicht (überspringen)
 *   3  vorübergehend nicht möglich (später wiederholen); bei `upload` steht die
 *      Kennung zum Fortsetzen in der Ausgabe
 *   64 falsch aufgerufen
 */

const fs = require('node:fs');
const client = require('../src');

const HILFE = `psalmio – Aufnahmen und Startzeitpunkte nach Psalmio bringen

  psalmio status
  psalmio event <termin-id>
  psalmio start <termin-id> [--at <unix-sekunden|ISO-zeit>]
  psalmio upload <datei> --event <termin-id> [--started-at <zeit>] [--resume <upload-id>]
  psalmio batch <manifest.tsv> [--window 22:00-06:00] [--state <datei>] [--dry-run]
                               [--root-from /mnt/nas --root-to /Volumes/Videoteam]

batch lädt ein ganzes Archiv: Manifest tabulatorgetrennt mit den Spalten „pfad" und
„ct_id", je Termin eine Datei. Vor jeder Datei wird gewartet, bis der Server mit der
vorigen fertig ist. Der Stand steht in <manifest>.stand.json – abbrechen (Strg+C) und
später neu starten kostet nichts.

Einrichtung (Umgebungsvariablen):
  PSALMIO_URL       https://gemeinde.psalmio.de
  PSALMIO_API_KEY   aus Psalmio: Einstellungen → API-Keys, Berechtigung „Videotechnik"
  oder --url <adresse> und --key-file <datei mit dem key>

  --json            Ergebnis als JSON statt als Text
`;

function argumente(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (name === 'json' || name === 'help' || name === 'dry-run') { flags[name] = true; continue; }
    flags[name] = argv[i + 1];
    i += 1;
  }
  return { positional, flags };
}

/** Unix-Sekunden aus „1790000000" oder „2026-09-20T10:00:00+02:00". */
function zeitpunkt(wert) {
  if (wert == null) return undefined;
  if (/^\d+$/.test(wert)) return Number(wert);
  const ms = Date.parse(wert);
  if (Number.isNaN(ms)) throw new Error(`Zeitangabe nicht lesbar: ${wert}`);
  return Math.floor(ms / 1000);
}

function konfiguration(flags) {
  let apiKey = process.env.PSALMIO_API_KEY || '';
  if (flags['key-file']) apiKey = fs.readFileSync(flags['key-file'], 'utf8').trim();
  return {
    baseUrl: client.normalizeBaseUrl(flags.url || process.env.PSALMIO_URL),
    apiKey,
    // nur gegen ein lokales Psalmio nötig, siehe src/api.js
    tenantId: process.env.PSALMIO_TENANT || undefined,
  };
}

function ende(result, flags, text) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(text(result));
  } else {
    console.error(`Fehler: ${result.error}${result.code ? ` [${result.code}]` : ''}`);
    if (result.uploadId) console.error(`Fortsetzen mit: --resume ${result.uploadId}`);
  }
  if (result.ok) return 0;
  if (client.isUnknownEvent(result)) return 2;
  if (client.isTemporaryOutage(result) || (result.stage === 'upload' && result.uploadId)) return 3;
  return 1;
}

async function main() {
  const { positional, flags } = argumente(process.argv.slice(2));
  const [befehl, erstes] = positional;
  if (flags.help || !befehl) { console.log(HILFE); return befehl ? 0 : 64; }
  const config = konfiguration(flags);

  if (befehl === 'status') {
    return ende(await client.checkConnection(config), flags, (r) => `Verbunden mit Psalmio – Gemeinde: ${r.data?.tenant ?? '?'}`);
  }
  if (befehl === 'event' && erstes) {
    return ende(await client.getEvent(config, erstes), flags, (r) => JSON.stringify(r.data, null, 2));
  }
  if (befehl === 'start' && erstes) {
    const at = zeitpunkt(flags.at) ?? Math.floor(Date.now() / 1000);
    return ende(await client.startEvent(config, erstes, at), flags, (r) =>
      r.data?.already_started ? 'Der Termin lief schon – nichts geändert.' : 'Termin gestartet.');
  }
  if (befehl === 'upload' && erstes && flags.event) {
    let letzte = -1;
    const result = await client.uploadRecording(config, flags.event, {
      filePath: erstes,
      recordingStartedAt: zeitpunkt(flags['started-at']),
      uploadId: flags.resume,
      onProgress: (p) => {
        if (flags.json || p.percent === letzte) return;
        letzte = p.percent;
        const teil = p.partCount ? ` (Teil ${p.part}/${p.partCount})` : '';
        process.stderr.write(`\r${String(p.percent).padStart(3)} %${teil}   `);
      },
    });
    if (!flags.json) process.stderr.write('\n');
    return ende(result, flags, (r) => `Aufnahme übernommen, Verarbeitung gestartet (Job ${r.data?.job_id ?? '?'}).`);
  }

  if (befehl === 'batch' && erstes) return stapel(config, erstes, flags);

  console.error(HILFE);
  return 64;
}

const TEXTE = { done: 'übernommen', exists: 'lag schon vor – übersprungen', unknown: 'Termin gibt es in Psalmio nicht – übersprungen', failed: 'GESCHEITERT' };

async function stapel(config, manifestPfad, flags) {
  const manifest = client.parseManifest(fs.readFileSync(manifestPfad, 'utf8'));
  if (manifest.error) { console.error(`Fehler: ${manifest.error}`); return 64; }
  const fenster = client.parseWindow(flags.window);
  if (fenster?.error) { console.error(`Fehler: ${fenster.error}`); return 64; }

  // Die Pfade im Manifest stammen oft von einem anderen Rechner (Container, NAS-Freigabe)
  const rows = manifest.rows.map((row) => ({
    ...row,
    filePath: flags['root-from'] && row.filePath.startsWith(flags['root-from'])
      ? (flags['root-to'] || '') + row.filePath.slice(flags['root-from'].length)
      : row.filePath,
  }));

  const standPfad = flags.state || `${manifestPfad}.stand.json`;
  const state = fs.existsSync(standPfad) ? JSON.parse(fs.readFileSync(standPfad, 'utf8')) : {};
  const erledigt = rows.filter((r) => ['done', 'exists', 'unknown'].includes(state[r.eventId]?.status)).length;
  const fehlend = rows.filter((r) => !fs.existsSync(r.filePath));
  const bytes = rows.reduce((summe, r) => summe + (fs.existsSync(r.filePath) ? fs.statSync(r.filePath).size : 0), 0);
  console.error(`${rows.length} Termine im Manifest (${manifest.skipped} Zeilen ohne ct_id ausgelassen), ${erledigt} schon erledigt, ${(bytes / 1e9).toFixed(1)} GB auf der Platte gefunden.`);
  for (const row of fehlend.slice(0, 20)) console.error(`  Datei fehlt: ${row.filePath} (Termin ${row.eventId})`);
  if (fehlend.length > 20) console.error(`  … und ${fehlend.length - 20} weitere`);
  if (flags['dry-run']) return fehlend.length ? 1 : 0;

  const abbruch = new AbortController();
  process.once('SIGINT', () => { console.error('\nAbbruch – der Stand wird gesichert, ein neuer Start setzt fort.'); abbruch.abort(); });

  let letzte = -1;
  const lauf = await client.runBatch(config, rows, {
    state,
    window: fenster,
    signal: abbruch.signal,
    saveState: (stand) => fs.writeFileSync(standPfad, JSON.stringify(stand, null, 2)),
    onEvent: (e) => {
      const zeit = new Date().toLocaleTimeString('de-DE');
      if (e.type === 'start') { letzte = -1; console.error(`[${zeit}] ${e.index}/${e.total}  Termin ${e.eventId}${e.resumed ? ' (wird fortgesetzt)' : ''}: ${e.filePath}`); }
      else if (e.type === 'progress' && e.percent !== letzte && e.percent % 10 === 0) { letzte = e.percent; process.stderr.write(`\r         ${e.percent} %   `); }
      else if (e.type === 'finished') console.error(`\r[${zeit}]          ${TEXTE[e.status] || e.status}${e.status === 'failed' ? `: ${e.error}` : ''}`);
      else if (e.type === 'retry') console.error(`\r[${zeit}]          Versuch ${e.attempt} gescheitert (${e.error}) – wird wiederholt`);
      else if (e.type === 'server-busy') console.error(`[${zeit}] Der Server verarbeitet noch – warte …`);
      else if (e.type === 'window-closed') console.error(`[${zeit}] Außerhalb des Zeitfensters ${flags.window} – warte …`);
      else if (e.type === 'no-queue') console.error(`[${zeit}] Achtung: Diese Psalmio-Fassung meldet ihre Auslastung nicht – es wird ohne Bremse hochgeladen.`);
    },
  });

  const c = lauf.counts;
  const bericht = `übernommen ${c.done}, lag schon vor ${c.exists}, Termin unbekannt ${c.unknown}, gescheitert ${c.failed}, offen ${c.open}`;
  if (flags.json) console.log(JSON.stringify(lauf, null, 2)); else console.log(`Fertig: ${bericht}. Stand: ${standPfad}`);
  if (c.failed) return 1;
  return c.open ? 3 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exitCode = 1;
});
