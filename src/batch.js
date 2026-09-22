/**
 * Viele Aufnahmen nacheinander nach Psalmio bringen – ein Archiv, nicht ein Sonntag.
 *
 * Drei Dinge unterscheiden das von einer Schleife um `uploadRecording`:
 *
 *  1. **Der Server bestimmt das Tempo.** Die Leitung ist nie der Engpass – Ton
 *     und Bild eines Gottesdienstes brauchen auf dem Server zusammen rund eine
 *     Viertelstunde, nacheinander. Vor jeder Datei wird deshalb gewartet, bis bei
 *     der Gemeinde nichts mehr ansteht (`/queue`). Sonst stapeln vierhundert
 *     Aufnahmen Tage an Arbeit auf dem Rechner, auf dem auch die Mediathek läuft.
 *  2. **Ein Abbruch kostet nichts.** Nach jedem Schritt steht der Stand in einer
 *     Datei; der nächste Lauf überspringt Erledigtes und setzt einen halben
 *     Upload mit seiner Kennung fort.
 *  3. **Eine Absage ist kein Fehler.** „Termin gibt es in Psalmio nicht" und
 *     „da liegt schon eine Aufnahme" werden notiert und übersprungen – bei
 *     vierhundert Dateien ist beides zu erwarten, und der Lauf soll daran nicht
 *     hängen bleiben.
 *
 * Wie überall: nichts wirft (außer beim Lesen einer kaputten Stand-Datei – die
 * soll niemand stillschweigend überschreiben).
 */

const api = require('./api');
const { uploadRecording } = require('./recording');

/** Absagen, bei denen ein erneuter Versuch nichts ändert: Für den Termin liegt schon etwas vor. */
const VORHANDEN = new Set(['RECORDING_ALREADY_EXISTS', 'EVENT_HAS_FILES']);

const schlafen = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * Liest ein Manifest: tabulatorgetrennt, erste Zeile Spaltennamen, gebraucht
 * werden `pfad` und `ct_id` (weitere Spalten stören nicht – die Zuordnungsdatei
 * aus einer Bestandsaufnahme lässt sich direkt verwenden). Zeilen ohne `ct_id`
 * werden ausgelassen.
 *
 * @returns {{rows: {filePath: string, eventId: string}[], skipped: number} | {error: string}}
 */
function parseManifest(text) {
  const zeilen = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((z) => z.trim());
  if (!zeilen.length) return { error: 'Das Manifest ist leer.' };
  const kopf = zeilen[0].split('\t').map((s) => s.trim().toLowerCase());
  const pfadSpalte = kopf.indexOf('pfad');
  const idSpalte = kopf.indexOf('ct_id');
  if (pfadSpalte < 0 || idSpalte < 0) return { error: 'Das Manifest braucht die Spalten „pfad" und „ct_id" (tabulatorgetrennt).' };

  const rows = [];
  let skipped = 0;
  const gesehen = new Set();
  const doppelt = new Set();
  for (const zeile of zeilen.slice(1)) {
    const felder = zeile.split('\t');
    const filePath = (felder[pfadSpalte] || '').trim();
    const eventId = (felder[idSpalte] || '').trim();
    if (!filePath || !eventId) { skipped += 1; continue; }
    // Alle Doppelten sammeln, nicht beim ersten aufhören: Wer ein Manifest aus
    // einer Bestandsaufnahme bereinigt, will sie in einem Durchgang sehen.
    if (gesehen.has(eventId)) { doppelt.add(eventId); continue; }
    gesehen.add(eventId);
    rows.push({ filePath, eventId });
  }
  if (doppelt.size) {
    const liste = [...doppelt].join(', ');
    return { error: `Je Termin genau eine Datei – mehrfach im Manifest: ${liste}. Bitte im Manifest zusammenfassen oder auswählen.` };
  }
  return { rows, skipped };
}

/**
 * „22:00-06:00" → Prüffunktion; ein Fenster über Mitternacht ist erlaubt.
 *
 * Die Uhrzeit ist die der angegebenen Zeitzone, sonst die des Prozesses. Das
 * ist keine Kleinigkeit: Server laufen gern auf UTC, und „22:00-06:00" hieße
 * dort im Sommer 0 bis 8 Uhr deutscher Zeit – der Upload liefe in den
 * Sonntagmorgen hinein. Die gewählte Zone steht in `zone`, damit der Aufrufer
 * sie hinschreiben kann.
 */
function parseWindow(text, zone) {
  if (!text) return null;
  const treffer = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!treffer) return { error: `Zeitfenster nicht lesbar: ${text} (erwartet: 22:00-06:00)` };
  const von = Number(treffer[1]) * 60 + Number(treffer[2]);
  const bis = Number(treffer[3]) * 60 + Number(treffer[4]);

  let minuten;
  let benutzteZone;
  if (zone) {
    let formatierer;
    try {
      // h23: Mitternacht ist 00, nicht 24 – sonst läge sie außerhalb jedes Fensters
      formatierer = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    } catch {
      return { error: `Zeitzone nicht bekannt: ${zone} (erwartet: Europe/Berlin)` };
    }
    benutzteZone = zone;
    minuten = (datum) => {
      const teile = Object.fromEntries(formatierer.formatToParts(datum).map((t) => [t.type, t.value]));
      return Number(teile.hour) * 60 + Number(teile.minute);
    };
  } else {
    benutzteZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    minuten = (datum) => datum.getHours() * 60 + datum.getMinutes();
  }

  return {
    zone: benutzteZone,
    offen: (datum) => {
      const jetzt = minuten(datum);
      return von <= bis ? jetzt >= von && jetzt < bis : jetzt >= von || jetzt < bis;
    },
  };
}

/**
 * @param {{baseUrl: string, apiKey: string}} config
 * @param {{filePath: string, eventId: string}[]} rows
 * @param {object} options
 * @param {object} [options.state]        Stand aus einem früheren Lauf (wird fortgeschrieben)
 * @param {(state: object) => void} [options.saveState]
 * @param {{offen: (d: Date) => boolean}} [options.window]   nur in diesem Zeitfenster hochladen
 * @param {(ereignis: object) => void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, aborted: boolean, counts: object, state: object}>}
 */
async function runBatch(config, rows, options = {}, deps = {}) {
  const state = options.state || {};
  const melden = options.onEvent || (() => {});
  const speichern = () => options.saveState?.(state);
  const signal = options.signal;
  const pollMs = deps.pollMs ?? 60_000;
  const outageMs = deps.outageMs ?? 5 * 60_000;
  const maxVersuche = options.maxAttempts || 5;
  const jetzt = deps.now || (() => new Date());
  let bremseBekannt = true;

  const warteAufFenster = async () => {
    let gemeldet = false;
    while (options.window && !options.window.offen(jetzt()) && !signal?.aborted) {
      if (!gemeldet) { melden({ type: 'window-closed' }); gemeldet = true; }
      await schlafen(pollMs, signal);
    }
  };

  const warteAufServer = async () => {
    let gemeldet = false;
    while (bremseBekannt && !signal?.aborted) {
      const queue = await api.getQueue(config, deps);
      if (api.isUnknownEndpoint(queue)) {
        // Ältere Psalmio-Fassung: keine Auskunft. Weiterladen, aber sagen, dass die Bremse fehlt.
        bremseBekannt = false;
        melden({ type: 'no-queue' });
        return;
      }
      if (queue.ok && queue.data?.idle) return;
      if (!gemeldet) { melden({ type: 'server-busy', active: queue.data?.active }); gemeldet = true; }
      await schlafen(queue.ok ? pollMs : outageMs, signal);
    }
  };

  /**
   * Warten, bis beides zugleich gilt: Fenster offen und Server frei.
   *
   * Das Warten auf den Server dauert bei großen Dateien eine Viertelstunde,
   * bei einer Störung auch Stunden. Wurde danach nicht noch einmal aufs
   * Fenster geschaut, begann der nächste Upload womöglich am Sonntagmorgen
   * mitten im Gottesdienst – genau das, was das Fenster verhindern soll.
   */
  const warteAufGelegenheit = async () => {
    while (!signal?.aborted) {
      await warteAufFenster();
      await warteAufServer();
      if (signal?.aborted || !options.window || options.window.offen(jetzt())) return;
    }
  };

  for (const [index, row] of rows.entries()) {
    if (signal?.aborted) break;
    const eintrag = state[row.eventId] || (state[row.eventId] = { status: 'open', attempts: 0 });
    if (['done', 'exists', 'unknown'].includes(eintrag.status)) continue;
    eintrag.filePath = row.filePath;

    while (!signal?.aborted) {
      await warteAufGelegenheit();
      if (signal?.aborted) break;

      // Fortgesetzt wird nur, wenn auch festgehalten ist, für welche Datei die
      // Kennung gilt. Ein Stand ohne diesen Fingerabdruck stammt aus einer
      // älteren Fassung – dann lieber von vorn als Teile zweier Dateien mischen.
      const fortsetzbar = Boolean(eintrag.uploadId && eintrag.uploadFile);
      melden({ type: 'start', index: index + 1, total: rows.length, ...row, resumed: fortsetzbar });
      eintrag.attempts += 1;
      const result = await uploadRecording(config, row.eventId, {
        filePath: row.filePath,
        uploadId: fortsetzbar ? eintrag.uploadId : undefined,
        resumeFile: eintrag.uploadFile,
        signal,
        // Die Kennung steht fest, sobald der Server sie ausgestellt hat – nicht
        // erst am Ende. Nach Stromausfall oder kill gibt es sonst nichts
        // fortzusetzen, und die halbe Datei liegt unerreichbar im Speicher.
        onUploadStart: ({ uploadId, file }) => {
          eintrag.uploadId = uploadId;
          eintrag.uploadFile = file;
          speichern();
        },
        onProgress: (p) => melden({ type: 'progress', ...row, ...p }),
      }, deps);

      if (result.ok) {
        Object.assign(eintrag, { status: 'done', uploadId: undefined, uploadFile: undefined, error: undefined, jobId: result.data?.job_id, fileSize: result.data?.file_size });
      } else if (result.aborted) {
        if (result.uploadId) eintrag.uploadId = result.uploadId;
        speichern();
        break;
      } else if (api.isUnknownEvent(result)) {
        Object.assign(eintrag, { status: 'unknown', error: result.error });
      } else if (VORHANDEN.has(result.code)) {
        Object.assign(eintrag, { status: 'exists', error: result.error });
      } else if (result.code === 'UPLOAD_NOT_RESUMABLE' || result.code === 'RESUME_FILE_MISMATCH') {
        // Die gemerkte Kennung taugt nicht mehr – von vorn, ohne den Versuch zu zählen.
        // Bei einer geänderten Datei liegen die alten Teile noch beim Server: Die
        // gehören zu etwas, das es so nicht mehr gibt, also gleich verwerfen.
        if (result.code === 'RESUME_FILE_MISMATCH') {
          melden({ type: 'file-changed', ...row, error: result.error });
          await api.abortMultipart(config, row.eventId, { uploadId: eintrag.uploadId }, deps);
        }
        eintrag.uploadId = undefined;
        eintrag.uploadFile = undefined;
        eintrag.attempts -= 1;
        speichern();
        continue;
      } else {
        if (result.uploadId) eintrag.uploadId = result.uploadId;
        eintrag.error = `${result.stage}: ${result.error}${result.code ? ` [${result.code}]` : ''}`;
        // Eine fehlende oder leere Datei wird durch Warten nicht besser
        const wiederholbar = result.stage !== 'file' && (
          api.isTemporaryOutage(result) || result.code === 'PROCESSING_IN_PROGRESS' || result.stage === 'upload' || !result.status);
        if (wiederholbar && eintrag.attempts < maxVersuche) {
          melden({ type: 'retry', ...row, error: eintrag.error, attempt: eintrag.attempts });
          speichern();
          await schlafen(api.isTemporaryOutage(result) ? outageMs : pollMs, signal);
          continue;
        }
        eintrag.status = 'failed';
      }

      speichern();
      melden({ type: 'finished', ...row, status: eintrag.status, error: eintrag.error, jobId: eintrag.jobId });
      break;
    }
  }

  const counts = { done: 0, exists: 0, unknown: 0, failed: 0, open: 0 };
  for (const row of rows) counts[state[row.eventId]?.status || 'open'] += 1;
  return { ok: counts.failed === 0 && counts.open === 0, aborted: Boolean(signal?.aborted), counts, state };
}

module.exports = { parseManifest, parseWindow, runBatch };
