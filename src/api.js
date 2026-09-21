/**
 * Die Aufrufe gegen Psalmio (https://<gemeinde>.psalmio.de).
 *
 * Eine Regel gilt für alles hier: NICHTS wirft. Ein Aufruf über das Netz kann
 * schlicht nicht ankommen, und wer diese Bibliothek einbindet, steuert damit
 * womöglich gerade live einen Gottesdienst – ein gescheiterter Psalmio-Aufruf
 * darf dort nichts abbrechen. Jede Funktion sagt ehrlich, ob es geklappt hat
 * (`ok`); was das bedeutet, entscheidet der Aufrufer.
 *
 * Der API-Key wird in Psalmio je Gemeinde ausgestellt (Einstellungen →
 * API-Keys, Berechtigung „Videotechnik").
 */

const { validateBaseUrl } = require('./address');

const API_PREFIX = '/api/v1/integrations/videotech';
const TIMEOUT_MS = 15000;

/** Ist die Verbindung überhaupt eingerichtet? Eine Hälfte allein nützt nichts. */
function isConfigured(config) {
  return Boolean(config?.baseUrl && config?.apiKey);
}

/**
 * Ein Aufruf gegen Psalmio.
 *
 * @param {{baseUrl: string, apiKey: string, tenantId?: string}} config
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} [deps]
 * @returns {Promise<{ok: boolean, status?: number, data?: object, error?: string, code?: string, fromApi?: boolean}>}
 */
async function call(config, method, path, body, deps = {}) {
  if (!isConfigured(config)) {
    return { ok: false, error: 'Psalmio ist nicht eingerichtet (Adresse oder API-Key fehlt).' };
  }
  // Schützt auch Adressen, die gespeichert wurden, bevor es die Prüfung gab.
  const invalid = validateBaseUrl(config.baseUrl);
  if (invalid) return { ok: false, error: invalid };

  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(`${config.baseUrl}${API_PREFIX}${path}`, {
      method: method.toUpperCase(),
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
        // Nur für die Entwicklung gegen ein lokales Psalmio: Dort gibt es keine
        // Subdomain, an der sich die Gemeinde ablesen ließe. In Produktion
        // entscheidet allein die Adresse; der Header wird dort nicht gebraucht.
        ...(config.tenantId ? { 'X-Tenant-ID': config.tenantId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Eine API leitet nicht um. Einer Umleitung zu folgen trüge den
      // X-API-Key zum neuen Host – ein 3xx ist deshalb eine Antwort, die wir
      // melden, kein Sprung, den wir machen.
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs || TIMEOUT_MS),
    });

    let answer = null;
    try {
      answer = await response.json();
    } catch {
      // HTML-Fehlerseite einer falschen Adresse oder eines Proxys – kein JSON
    }

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, data: answer?.data ?? answer };
    }
    const detail = answer?.detail;
    return {
      ok: false,
      status: response.status,
      code: detail && typeof detail === 'object' ? detail.error_code : undefined,
      error: typeof detail === 'string' ? detail : detail?.message || `HTTP ${response.status}`,
      // Eine strukturierte Antwort der Psalmio-API selbst – im Unterschied zur
      // Fehlerseite einer falschen Adresse.
      fromApi: Boolean(answer && typeof answer === 'object' && 'detail' in answer),
    };
  } catch (err) {
    // Netz, Zeitlimit, Psalmio nicht erreichbar. Die Adresse enthält kein
    // Geheimnis (der Key ist ein Header), err.message darf also weitergegeben werden.
    return { ok: false, error: `Psalmio nicht erreichbar: ${err.message}` };
  }
}

// ── Antworten deuten ─────────────────────────────────────────────────

/**
 * „Psalmio führt diesen Termin nicht" – ein 404, den Psalmio selbst für den
 * Termin gegeben hat, erkannt an seinem Fehlercode. Nicht die 404-Seite einer
 * falschen Adresse, nicht das allgemeine `{"detail": "Not Found"}` für einen
 * Pfad, den es nicht gibt (geänderte API): Die müssen sichtbar bleiben, sonst
 * sähe eine kaputte Einrichtung für immer aus wie ein stilles Überspringen.
 */
function isUnknownEvent(result) {
  return Boolean(result && !result.ok && result.status === 404 && result.fromApi && result.code === 'EVENT_NOT_FOUND');
}

/**
 * Einen weiteren Versuch wert. Psalmio antwortet mit 503, solange etwas, von
 * dem es abhängt, nicht erreichbar ist: ChurchTools (`CHURCHTOOLS_UNAVAILABLE`)
 * oder der Dateispeicher (`OBJECT_STORAGE_UNAVAILABLE`). Verloren ist dabei
 * nichts – „später noch einmal", nicht „gescheitert".
 */
function isTemporaryOutage(result) {
  return Boolean(result && !result.ok && result.status === 503);
}

/**
 * Diese Psalmio-Installation kennt den Endpunkt (noch) nicht: FastAPIs
 * allgemeines `{"detail": "Not Found"}`. So erkennt `uploadRecording`, dass es
 * auf den einzelnen PUT ausweichen muss.
 */
function isUnknownEndpoint(result) {
  return Boolean(result && !result.ok && result.status === 404 && result.fromApi && !result.code);
}

// ── Endpunkte ────────────────────────────────────────────────────────

const eventPath = (eventId, rest = '') => `/events/${encodeURIComponent(eventId)}${rest}`;

/** Verbindungstest – sagt auch, zu welcher Gemeinde der Key gehört. */
function checkConnection(config, deps) {
  return call(config, 'get', '/status', undefined, deps);
}

/**
 * Steht bei dieser Gemeinde gerade Ton- oder Bildverarbeitung an?
 * `data: { active, running, pending, idle }` – Massen-Uploads laden erst weiter, wenn `idle`.
 */
function getQueue(config, deps) {
  return call(config, 'get', '/queue', undefined, deps);
}

function getEvent(config, eventId, deps) {
  return call(config, 'get', eventPath(eventId), undefined, deps);
}

/**
 * Den Termin in Psalmio starten.
 *
 * `startedAt` ist ein Unix-Zeitstempel in Sekunden – der Augenblick, in dem die
 * Aufnahme begann, nicht der, in dem dieser Aufruf abgeschickt wird: Jede
 * Marke, die danach im Live-Editor gesetzt wird, zählt von dort. Eine Minute
 * daneben heißt jede Marke eine Minute daneben. Lief der Termin schon, sagt
 * Psalmio das über `already_started`; das ist ein Erfolg, kein Konflikt.
 */
function startEvent(config, eventId, startedAt, deps) {
  return call(config, 'post', eventPath(eventId, '/start'), { started_at: startedAt, source: 'recording' }, deps);
}

/** Einzelner PUT (bis 5 GB): Upload-Adresse anfordern. */
function requestUpload(config, eventId, { fileSize, fileName }, deps) {
  return call(config, 'post', eventPath(eventId, '/recording/upload-url'), { file_size: fileSize, file_name: fileName }, deps);
}

/** Einzelner PUT: Upload abschließen, Verarbeitung starten. */
function completeUpload(config, eventId, { recordingStartedAt } = {}, deps) {
  const body = recordingStartedAt == null ? {} : { recording_started_at: recordingStartedAt };
  return call(config, 'post', eventPath(eventId, '/recording/complete'), body, deps);
}

/** In Teilen (bis 15 GB): eröffnen. Antwort: `upload_id`, `part_size`, `part_count`, `urls`. */
function startMultipart(config, eventId, { fileSize, fileName }, deps) {
  return call(config, 'post', eventPath(eventId, '/recording/multipart/start'), { file_size: fileSize, file_name: fileName }, deps);
}

/** In Teilen: nach einem Abbruch. Antwort wie `startMultipart`, dazu `parts_done` und frische Adressen. */
function resumeMultipart(config, eventId, { uploadId, fileSize }, deps) {
  return call(config, 'post', eventPath(eventId, '/recording/multipart/resume'), { upload_id: uploadId, file_size: fileSize }, deps);
}

/**
 * In Teilen: zusammenfügen und Verarbeitung starten.
 *
 * `fileSize` ist Pflicht und dient als Prüfsumme: Fehlt der letzte Teil, sind
 * die Teilnummern trotzdem lückenlos – nur an der Summe fällt es auf.
 */
function completeMultipart(config, eventId, { uploadId, fileSize, recordingStartedAt }, deps) {
  const body = { upload_id: uploadId, file_size: fileSize };
  if (recordingStartedAt != null) body.recording_started_at = recordingStartedAt;
  return call(config, 'post', eventPath(eventId, '/recording/multipart/complete'), body, deps);
}

/** In Teilen: die hochgeladenen Teile verwerfen. */
function abortMultipart(config, eventId, { uploadId }, deps) {
  return call(config, 'post', eventPath(eventId, '/recording/multipart/abort'), { upload_id: uploadId }, deps);
}

module.exports = {
  API_PREFIX,
  isConfigured,
  isUnknownEvent,
  isTemporaryOutage,
  isUnknownEndpoint,
  checkConnection,
  getQueue,
  getEvent,
  startEvent,
  requestUpload,
  completeUpload,
  startMultipart,
  resumeMultipart,
  completeMultipart,
  abortMultipart,
};
