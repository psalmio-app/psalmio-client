/**
 * Eine Aufnahme nach Psalmio bringen – der ganze Weg in einem Aufruf.
 *
 * In Teilen, wenn Psalmio das kann (bis 15 GB): Ein gescheiterter Teil wird
 * einzeln wiederholt, und nach einem Abbruch geht es mit derselben
 * `uploadId` an derselben Stelle weiter. Kennt die Psalmio-Installation die
 * Teile noch nicht, weicht der Aufruf auf den einzelnen PUT aus (bis 5 GB).
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

  let fileSize;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    return { ok: false, stage: 'file', error: `Datei nicht lesbar: ${err.message}` };
  }
  if (!fileSize) return { ok: false, stage: 'file', error: 'Die Datei ist leer.' };
  const fileName = path.basename(filePath);

  // ── eröffnen oder fortsetzen ──
  let plan;
  if (options.uploadId) {
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

module.exports = { uploadRecording };
