/**
 * Eine Datei – oder ein Stück davon – an eine vorsignierte Adresse schicken.
 *
 * Mit Absicht kein fetch: Hier läuft eine Datei von mehreren Gigabyte direkt
 * von der Platte (oft ein NAS) in den Objektspeicher, und die Anfrage braucht
 * eine exakte Content-Length.
 *
 * Löst GENAU EINMAL auf, auf jedem Weg, auf dem eine Anfrage enden kann – und
 * räumt immer Dateistrom und Verbindung weg. Die erste Fassung (in der Workflow
 * Engine der MBG Lemgo) konnte für immer hängen: Sie hörte nur auf das `end` der
 * Antwort, und eine Verbindung, die nach den Kopfzeilen abriss, schickte keins.
 * Ein Auftrag, der nie endet, blockiert alles, was auf ihn wartet.
 *
 * `fs`, `http` und `https` lassen sich unterschieben; die Tests benutzen einen
 * echten Server auf localhost – so etwas sieht eine Attrappe nie.
 */

const { isAllowedUploadTarget } = require('./address');

// Gemeinden laden über die Leitung eines Gemeindehauses hoch. Die Adresse gilt
// sechs Stunden – ein eingeschlafener Socket muss trotzdem auffallen.
const UPLOAD_IDLE_TIMEOUT_MS = 120000;

/**
 * @param {object} options
 * @param {string} options.uploadUrl   vorsignierte Adresse von Psalmio
 * @param {string} options.filePath
 * @param {number} options.fileSize    Bytes, die geschickt werden (bei einem Stück: dessen Länge)
 * @param {number} [options.start=0]   erstes Byte des Stücks in der Datei
 * @param {(p: {sentBytes: number, totalBytes: number, percent: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, sentBytes?: number, status?: number, aborted?: boolean, error?: string}>}
 */
function uploadFile({ uploadUrl, filePath, fileSize, start = 0, onProgress, signal, deps = {} }) {
  const fs = deps.fs || require('node:fs');
  const httpModule = deps.http || require('node:http');
  const httpsModule = deps.https || require('node:https');
  const idleTimeoutMs = deps.idleTimeoutMs || UPLOAD_IDLE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(uploadUrl);
    } catch {
      resolve({ ok: false, error: 'Psalmio lieferte keine gültige Upload-Adresse.' });
      return;
    }
    if (!isAllowedUploadTarget(target)) {
      resolve({ ok: false, error: 'Psalmio lieferte eine Upload-Adresse ohne https — nicht hochgeladen.' });
      return;
    }
    if (signal?.aborted) {
      resolve({ ok: false, aborted: true, error: 'Abgebrochen' });
      return;
    }

    let settled = false;
    let stream = null;
    let request = null;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try { stream?.destroy(); } catch {}
      try { request?.destroy(); } catch {}
      resolve(outcome);
    };
    function onAbort() {
      settle({ ok: false, aborted: true, error: 'Abgebrochen' });
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const transport = target.protocol === 'https:' ? httpsModule : httpModule;
    try {
      request = transport.request(target, {
        method: 'PUT',
        headers: { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' },
      });
    } catch (err) {
      settle({ ok: false, error: `Upload nicht möglich: ${err.message}` });
      return;
    }
    request.setTimeout(idleTimeoutMs, () => settle({ ok: false, error: 'Upload hängt — keine Daten übertragen' }));

    let sent = 0;
    let lastReport = 0;
    // Ist eine Antwort da, entscheidet SIE – nicht das Socket-Ereignis, das
    // zufällig als Nächstes kommt. S3 beantwortet einen PUT erst nach dem ganzen
    // Inhalt und schließt danach oft sofort; dieses Schließen darf aus einem
    // gespeicherten Upload kein „gescheitert" machen, und aus einem frühen 403
    // kein „write EPIPE".
    let status = null;
    const byStatus = () => {
      if (status >= 200 && status < 300) {
        return sent >= fileSize
          ? { ok: true, sentBytes: sent }
          : { ok: false, status, error: `Vor dem Ende angenommen (${sent} von ${fileSize} Bytes gesendet)` };
      }
      return { ok: false, status, error: `Upload abgelehnt (HTTP ${status})` };
    };

    try {
      stream = fs.createReadStream(filePath, { start, end: start + fileSize - 1 });
    } catch (err) {
      settle({ ok: false, error: `Datei nicht lesbar: ${err.message}` });
      return;
    }
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastReport > 2000 || sent >= fileSize) {
        lastReport = now;
        onProgress?.({ sentBytes: sent, totalBytes: fileSize, percent: Math.floor((sent / fileSize) * 100) });
      }
    });
    stream.on('error', (err) => settle({ ok: false, error: `Datei nicht lesbar: ${err.message}` }));

    request.on('response', (response) => {
      status = response.statusCode;
      response.on('error', () => {});
      response.on('aborted', () => settle(byStatus()));
      response.on('end', () => settle(byStatus()));
      response.on('close', () => settle(byStatus()));
      response.resume(); // leeren, damit die Verbindung schließen kann
      // Eine Ablehnung kann kommen, bevor die Datei durch ist – dann nicht weiterlesen.
      if (status < 200 || status >= 300) try { stream.destroy(); } catch {}
    });
    request.on('error', (err) => {
      if (status !== null) { settle(byStatus()); return; }
      // Ein Schreibfehler kann eine Ablehnung überholen, die schon im Puffer
      // liegt (der Server hat mit 403 geantwortet und geschlossen). Ihr einen
      // Augenblick geben.
      setTimeout(() => settle(status !== null ? byStatus() : { ok: false, error: `Upload fehlgeschlagen: ${err.message}` }), 100);
    });
    // Letzte Sicherung: Die Verbindung ist weg, und nichts oben hat gefeuert.
    request.on('close', () => {
      if (status !== null) { settle(byStatus()); return; }
      setTimeout(() => settle(status !== null ? byStatus() : { ok: false, error: 'Verbindung beendet, bevor der Speicher geantwortet hat' }), 100);
    });

    stream.pipe(request);
  });
}

module.exports = { uploadFile, UPLOAD_IDLE_TIMEOUT_MS };
