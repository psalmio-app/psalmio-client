/**
 * Eine Aufnahme nach Psalmio bringen – der ganze Weg in einem Aufruf.
 *
 * In Teilen, wenn Psalmio das kann (bis 15 GB): Ein gescheiterter Teil wird
 * einzeln wiederholt, und nach einem Abbruch geht es mit derselben
 * `uploadId` an derselben Stelle weiter. Kennt die Psalmio-Installation die
 * Teile noch nicht, weicht der Aufruf auf den einzelnen PUT aus (bis 5 GB).
 *
 * Fortsetzen gilt immer **einer bestimmten Datei**. Wer eine `uploadId`
 * mitgibt, muss auch `resumeFile` mitgeben – Pfad, Größe und Änderungszeit, wie
 * `onUploadStart` sie beim Eröffnen gemeldet hat. Fehlt davon etwas, wird das
 * Fortsetzen verweigert (`RESUME_FILE_MISSING`); weicht die Datei ab, ebenso
 * (`RESUME_FILE_MISMATCH`). Beides, statt Teile zweier Dateien still zu einer
 * Aufnahme zu verweben: Psalmio rechnet den Plan beim Fortsetzen aus der
 * gesendeten Größe neu und bemerkt eine andere Datei gleicher Größe nicht –
 * der Fingerabdruck ist der einzige Schutz dagegen.
 *
 * Die `uploadId` steht nicht erst am Ende fest: `onUploadStart` meldet sie,
 * sobald der Server sie ausgestellt hat, und es geht erst weiter, wenn der
 * Rückruf fertig ist (er darf eine Promise liefern). Wer die Kennung dort
 * wegschreibt, kann auch nach einem harten Abbruch fortsetzen – das Ergebnis am
 * Ende sieht in diesem Fall ja niemand mehr. Scheitert der Rückruf, endet der
 * Upload (`UPLOAD_START_HOOK_FAILED`), bevor ein Byte fließt.
 *
 * Wie überall: nichts wirft. Das Ergebnis nennt die Stufe, auf der es endete
 * (`stage`), und – sobald es eine gibt – die `uploadId`, mit der sich der
 * Upload später fortsetzen lässt.
 */

const api = require('./api');
const { uploadFile } = require('./put');

const SINGLE_PUT_LIMIT = 5 * 1024 ** 3;
const DEFAULT_PART_ATTEMPTS = 4;

const pause = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/**
 * @param {{baseUrl: string, apiKey: string}} config
 * @param {string} eventId  Termin-ID (bei ChurchTools-Gemeinden die ChurchTools-ID)
 * @param {object} options
 * @param {string} options.filePath
 * @param {number} [options.recordingStartedAt]  Unix-Sekunden: wann die Aufnahme wirklich begann
 * @param {string} [options.uploadId]            einen abgebrochenen Upload fortsetzen – nur zusammen mit `resumeFile`
 * @param {{path: string, size: number, mtimeMs: number}} [options.resumeFile]  Datei, für die die `uploadId` gilt (wie von `onUploadStart` gemeldet)
 * @param {(s: {uploadId: string, partSize: number, partCount: number, resumed: boolean, file: {path: string, size: number, mtimeMs: number}}) => void | Promise<void>} [options.onUploadStart]
 * @param {number} [options.partAttempts=4]      Versuche je Teil
 * @param {(p: {sentBytes: number, totalBytes: number, percent: number, part?: number, partCount?: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, stage: string, data?: object, uploadId?: string, aborted?: boolean, status?: number, code?: string, error?: string, fromApi?: boolean}>}
 */
async function uploadRecording(config, eventId, options, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const path = require('node:path');
  const { filePath, recordingStartedAt, onProgress, signal } = options;
  const attempts = Math.max(1, options.partAttempts || DEFAULT_PART_ATTEMPTS);
  const retryDelayMs = deps.retryDelayMs ?? 3000;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { ok: false, stage: 'file', error: `Datei nicht lesbar: ${err.message}` };
  }
  const fileSize = stat.size;
  if (!fileSize) return { ok: false, stage: 'file', error: 'Die Datei ist leer.' };
  const fileName = path.basename(filePath);
  const fingerabdruck = fileFingerprint(filePath, stat);

  // ── eröffnen oder fortsetzen ──
  let plan;
  const fortsetzen = Boolean(options.uploadId);
  if (fortsetzen) {
    // Erst die Datei, dann der Server: Passt schon der Fingerabdruck nicht,
    // braucht niemand eine Adresse für Teile, die nicht zusammengehören.
    // Ohne Fingerabdruck gibt es nichts zu vergleichen – dann auch kein
    // Fortsetzen. Still weiterzumachen hieße, jeder Datei unter irgendeinem
    // Pfad die Teile einer anderen unterzuschieben.
    if (!fingerabdruckVollstaendig(options.resumeFile)) {
      return {
        ok: false,
        stage: 'resume',
        code: 'RESUME_FILE_MISSING',
        uploadId: options.uploadId,
        error: 'Zum Fortsetzen gehört der Fingerabdruck der Datei (resumeFile: Pfad, Größe, Änderungszeit, wie onUploadStart ihn gemeldet hat) – ohne ihn lässt sich nicht prüfen, ob noch dieselbe Datei vorliegt.',
      };
    }
    const abweichung = fileFingerprintMismatch(options.resumeFile, fingerabdruck);
    if (abweichung) {
      return {
        ok: false,
        stage: 'resume',
        code: 'RESUME_FILE_MISMATCH',
        uploadId: options.uploadId,
        error: `Die Datei hat sich seit dem Abbruch geändert (${abweichung}) – Fortsetzen würde Teile zweier Dateien zu einer Aufnahme verweben.`,
      };
    }
    plan = await api.resumeMultipart(config, eventId, { uploadId: options.uploadId, fileSize }, deps);
    if (!plan.ok) return { ...plan, stage: 'resume', uploadId: options.uploadId };
  } else {
    plan = await api.startMultipart(config, eventId, { fileSize, fileName }, deps);
    if (api.isUnknownEndpoint(plan)) {
      return singlePut(config, eventId, { filePath, fileSize, fileName, recordingStartedAt, onProgress, signal }, deps);
    }
    if (!plan.ok) return { ...plan, stage: 'start' };
  }

  let { upload_id: uploadId, part_size: partSize, part_count: partCount, urls } = plan.data;

  // Der Plan muss zur Datei passen: Sonst landen Stücke falscher Größe an
  // denselben Stellen – der Server fügt sie klaglos zusammen. Das fängt einen
  // Server ab, der sich verrechnet. Eine andere Datei gleicher Größe fängt es
  // nicht: Beim Fortsetzen rechnet Psalmio den Plan aus der gesendeten Größe
  // neu. Dafür ist der Fingerabdruck da.
  const erwartet = partSize > 0 ? Math.ceil(fileSize / partSize) : 0;
  if (!partSize || partCount !== erwartet) {
    return {
      ok: false,
      stage: fortsetzen ? 'resume' : 'start',
      code: fortsetzen ? 'RESUME_PLAN_MISMATCH' : 'START_PLAN_MISMATCH',
      uploadId,
      error: `Der Plan des Servers passt nicht zur Datei: ${partCount} Teile à ${partSize} Byte für ${fileSize} Byte (erwartet: ${erwartet}).`,
    };
  }

  if (options.onUploadStart) {
    try {
      await options.onUploadStart({ uploadId, partSize, partCount, resumed: fortsetzen, file: fingerabdruck });
    } catch (err) {
      // Wer die Kennung nicht festhalten konnte, kann später nicht fortsetzen.
      // Ein eben eröffneter Upload wäre dann nur noch Ballast – gleich zurückgeben.
      // Ein fortgesetzter bleibt: Seine Kennung steht ja schon irgendwo.
      if (!fortsetzen) await api.abortMultipart(config, eventId, { uploadId }, deps);
      return {
        ok: false,
        stage: fortsetzen ? 'resume' : 'start',
        code: 'UPLOAD_START_HOOK_FAILED',
        uploadId: fortsetzen ? uploadId : undefined,
        error: `onUploadStart ist gescheitert: ${err?.message ?? err}`,
      };
    }
  }
  const done = new Set(plan.data.parts_done || []);
  let sentBefore = [...done].reduce((sum, n) => sum + partLength(n, partSize, partCount, fileSize), 0);

  // ── Teil für Teil ──
  for (let part = 1; part <= partCount; part += 1) {
    if (done.has(part)) continue;
    const length = partLength(part, partSize, partCount, fileSize);
    let result;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) return { ok: false, stage: 'upload', aborted: true, error: 'Abgebrochen', uploadId };
      result = await uploadFile({
        uploadUrl: urls[String(part)],
        filePath,
        fileSize: length,
        start: (part - 1) * partSize,
        signal,
        onProgress: (p) => onProgress?.({
          sentBytes: sentBefore + p.sentBytes,
          totalBytes: fileSize,
          percent: Math.floor(((sentBefore + p.sentBytes) / fileSize) * 100),
          part,
          partCount,
        }),
        deps,
      });
      if (result.ok || result.aborted) break;
      if (attempt === attempts) break;

      // 403: Die Adresse ist abgelaufen (sechs Stunden) – frische holen.
      if (result.status === 403) {
        const fresh = await api.resumeMultipart(config, eventId, { uploadId, fileSize }, deps);
        if (fresh.ok) urls = fresh.data.urls;
      }
      await pause(retryDelayMs * attempt, signal);
    }
    if (!result.ok) return { ...result, stage: 'upload', part, uploadId };
    sentBefore += length;
  }

  // ── zusammenfügen ──
  const finished = await api.completeMultipart(config, eventId, { uploadId, fileSize, recordingStartedAt }, deps);
  return finished.ok
    ? { ok: true, stage: 'done', data: finished.data, uploadId }
    : { ...finished, stage: 'complete', uploadId };
}

/** Woran eine Datei wiederzuerkennen ist: Pfad, Größe, Änderungszeit. */
function fileFingerprint(filePath, stat) {
  // Ganze Millisekunden: Der Wert geht durch JSON und zurück
  return { path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

/** Alle drei Angaben da? Sonst lässt sich nichts vergleichen. */
function fingerabdruckVollstaendig(abdruck) {
  return Boolean(abdruck) && typeof abdruck.path === 'string' && abdruck.path !== ''
    && Number.isFinite(abdruck.size) && Number.isFinite(abdruck.mtimeMs);
}

/**
 * Passt die Datei noch zu dem, was beim Eröffnen galt? Liefert den Grund der
 * Abweichung, sonst null. Verglichen wird alles; ein unvollständiger
 * Fingerabdruck gilt als Abweichung (in `uploadRecording` kommt er gar nicht bis
 * hierher, dort heißt er `RESUME_FILE_MISSING`).
 */
function fileFingerprintMismatch(gemerkt, jetzt) {
  if (!fingerabdruckVollstaendig(gemerkt)) return 'Fingerabdruck unvollständig';
  if (gemerkt.path !== jetzt.path) return `Pfad: ${gemerkt.path} → ${jetzt.path}`;
  if (gemerkt.size !== jetzt.size) return `Größe: ${gemerkt.size} → ${jetzt.size} Byte`;
  if (!Number.isFinite(jetzt.mtimeMs)) return 'Änderungszeit nicht lesbar';
  if (gemerkt.mtimeMs !== jetzt.mtimeMs) {
    return `geändert am ${new Date(gemerkt.mtimeMs).toISOString()} → ${new Date(jetzt.mtimeMs).toISOString()}`;
  }
  return null;
}

function partLength(part, partSize, partCount, fileSize) {
  return part < partCount ? partSize : fileSize - (partCount - 1) * partSize;
}

async function singlePut(config, eventId, { filePath, fileSize, fileName, recordingStartedAt, onProgress, signal }, deps) {
  if (fileSize > SINGLE_PUT_LIMIT) {
    return {
      ok: false,
      stage: 'start',
      error: 'Diese Psalmio-Installation nimmt noch keine Uploads in Teilen an, und die Datei ist größer als 5 GB.',
    };
  }
  const requested = await api.requestUpload(config, eventId, { fileSize, fileName }, deps);
  if (!requested.ok) return { ...requested, stage: 'start' };

  const uploaded = await uploadFile({ uploadUrl: requested.data.upload_url, filePath, fileSize, onProgress, signal, deps });
  if (!uploaded.ok) return { ...uploaded, stage: 'upload' };

  const finished = await api.completeUpload(config, eventId, { recordingStartedAt }, deps);
  return finished.ok ? { ok: true, stage: 'done', data: finished.data } : { ...finished, stage: 'complete' };
}

module.exports = { uploadRecording, fileFingerprint, fileFingerprintMismatch };
