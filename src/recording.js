/**
 * Eine Aufnahme nach Psalmio bringen – der ganze Weg in einem Aufruf.
 *
 * In Teilen, wenn Psalmio das kann (bis 15 GB): Ein gescheiterter Teil wird
 * einzeln wiederholt, und nach einem Abbruch geht es mit derselben
 * `uploadId` an derselben Stelle weiter. Kennt die Psalmio-Installation die
 * Teile noch nicht, weicht der Aufruf auf den einzelnen PUT aus (bis 5 GB).
 *
 * Fortsetzen gilt immer **einer bestimmten Datei**. Wer eine `uploadId`
 * mitgibt, gibt auch `resumeFile` mit – Pfad, Größe und Änderungszeit, wie sie
 * beim Eröffnen galten. Weicht die Datei davon ab, wird das Fortsetzen
 * verweigert (`RESUME_FILE_MISMATCH`), statt Teile zweier Dateien still zu
 * einer Aufnahme zu verweben. Dasselbe gilt, wenn der Plan des Servers nicht
 * zur Datei passt (`RESUME_PLAN_MISMATCH`).
 *
 * Die `uploadId` steht nicht erst am Ende fest: `onUploadStart` meldet sie,
 * sobald der Server sie ausgestellt hat. Wer sie dort wegschreibt, kann auch
 * nach einem harten Abbruch fortsetzen – das Ergebnis am Ende sieht in diesem
 * Fall ja niemand mehr.
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
 * @param {string} [options.uploadId]            einen abgebrochenen Upload fortsetzen
 * @param {{path?: string, size?: number, mtimeMs?: number}} [options.resumeFile]  Datei, für die die `uploadId` gilt
 * @param {(s: {uploadId: string, partSize: number, partCount: number, resumed: boolean, file: {path: string, size: number, mtimeMs?: number}}) => void} [options.onUploadStart]
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

  // Der Plan muss zur Datei passen: Sonst lädt der zweite Lauf Stücke einer
  // anderen Größe an dieselben Stellen – der Server fügt sie klaglos zusammen.
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

  options.onUploadStart?.({ uploadId, partSize, partCount, resumed: fortsetzen, file: fingerabdruck });
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
  const abdruck = { path: filePath, size: stat.size };
  // Ganze Millisekunden: Der Wert geht durch JSON und zurück
  if (Number.isFinite(stat.mtimeMs)) abdruck.mtimeMs = Math.round(stat.mtimeMs);
  return abdruck;
}

/**
 * Passt die Datei noch zu dem, was beim Eröffnen galt? Liefert den Grund der
 * Abweichung, sonst null.
 *
 * Fehlt im Gemerkten ein Feld (Stand aus einer älteren Fassung), wird es
 * übersprungen – über Größe und Pfad fällt der wichtigste Fall trotzdem auf.
 */
function fileFingerprintMismatch(gemerkt, jetzt) {
  if (!gemerkt) return null;
  if (gemerkt.path != null && gemerkt.path !== jetzt.path) return `Pfad: ${gemerkt.path} → ${jetzt.path}`;
  if (gemerkt.size != null && gemerkt.size !== jetzt.size) return `Größe: ${gemerkt.size} → ${jetzt.size} Byte`;
  if (gemerkt.mtimeMs != null && jetzt.mtimeMs != null && gemerkt.mtimeMs !== jetzt.mtimeMs) {
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
