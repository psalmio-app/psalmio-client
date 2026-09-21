/**
 * Ein Upload, der in jedem Fall endet.
 *
 * Läuft gegen einen ECHTEN http-Server auf localhost – keine nachgebaute
 * Anfrage. Die erste Fassung hing für immer, wenn die Verbindung nach den
 * Antwort-Kopfzeilen abriss; so etwas sieht eine Attrappe nie.
 *
 * Übernommen aus der Workflow Engine der MBG Lemgo (Tim Fast).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src');
const { tempFile, withServer } = require('./helpers');

test('Upload: der Server nimmt alles an → ok, genau so viele Bytes wie die Datei', async () => {
  const file = tempFile(300_000);
  await withServer((req, res) => {
    // Wie S3: ohne exakte Content-Length gibt es keinen Upload.
    if (req.headers['content-length'] !== '300000') { res.writeHead(411); res.end(); req.resume(); return; }
    let got = 0;
    req.on('data', (c) => { got += c.length; });
    req.on('end', () => { res.writeHead(200); res.end(String(got)); });
  }, async (url) => {
    const result = await client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 300_000 });
    assert.deepEqual(result, { ok: true, sentBytes: 300_000 });
  });
});

test('Upload: sofortige Ablehnung (403) → Fehler mit Status, kein Hängen', async () => {
  const file = tempFile(2_000_000);
  await withServer((req, res) => { res.writeHead(403); res.end('SignatureDoesNotMatch'); req.resume(); }, async (url) => {
    const result = await client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 2_000_000 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test('Upload: die Verbindung reißt nach den Kopfzeilen ab → endet trotzdem', async () => {
  const file = tempFile(100_000);
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // Kopfzeilen für eine Antwort mit Inhalt senden … und dann die Leitung kappen.
      res.writeHead(500, { 'Content-Length': '1000' });
      res.write('teil');
      setTimeout(() => req.socket.destroy(), 20);
    });
  }, async (url) => {
    const result = await Promise.race([
      client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 100_000 }),
      new Promise((r) => setTimeout(() => r('HÄNGT'), 3000)),
    ]);
    assert.notEqual(result, 'HÄNGT', 'die erste Fassung wäre hier für immer stehen geblieben');
    assert.equal(result.ok, false);
  });
});

test('Upload: Abbrechen mitten im Hochladen wirkt', async () => {
  const file = tempFile(5_000_000);
  const controller = new AbortController();
  await withServer((req) => {
    req.once('data', () => controller.abort()); // die ersten Bytes sind da → abbrechen
    req.resume();
  }, async (url) => {
    const result = await Promise.race([
      client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 5_000_000, signal: controller.signal }),
      new Promise((r) => setTimeout(() => r('HÄNGT'), 3000)),
    ]);
    assert.deepEqual(result, { ok: false, aborted: true, error: 'Abgebrochen' });
  });
});

test('Upload: der Server schweigt → Leerlauf-Grenze greift', async () => {
  const file = tempFile(10_000);
  await withServer(() => { /* nimmt an, antwortet nie */ }, async (url) => {
    const result = await client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 10_000, deps: { idleTimeoutMs: 150 } });
    assert.equal(result.ok, false);
    assert.match(result.error, /hängt/);
  });
});

test('Upload: Adresse ohne https (außer localhost) wird nicht angesteuert', async () => {
  const result = await client.uploadFile({ uploadUrl: 'http://speicher.example.org/x', filePath: '/nicht/da', fileSize: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /https/);
});

test('Upload: Datei fehlt → Fehler statt Hängen', async () => {
  await withServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(); }); }, async (url) => {
    const result = await client.uploadFile({ uploadUrl: url, filePath: '/gibt/es/nicht.mp4', fileSize: 10 });
    assert.equal(result.ok, false);
  });
});

test('Upload: angenommen (200) und danach Verbindung gekappt → bleibt ein Erfolg', async () => {
  const file = tempFile(50_000);
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('ok');
      setTimeout(() => req.socket.destroy(), 20);
    });
  }, async (url) => {
    const result = await client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 50_000 });
    assert.equal(result.ok, true, 'gespeichert ist gespeichert — sonst lädt „Wiederholen“ Gigabytes erneut hoch');
  });
});

test('Upload: frühe Ablehnung, Server kappt hart → endet sauber als Fehler, hängt nicht', async () => {
  // Bei einem harten Abbruch (RST) verwirft das Betriebssystem eine schon
  // gesendete Antwort manchmal — das kann kein Client retten. Wichtig ist nur:
  // der Auftrag endet, und zwar als Fehler, nicht als Erfolg.
  const file = tempFile(8_000_000);
  await withServer((req, res) => {
    res.writeHead(403, { Connection: 'close' });
    res.end('AccessDenied');
    setTimeout(() => req.socket.destroy(), 5);
  }, async (url) => {
    const result = await Promise.race([
      client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 8_000_000 }),
      new Promise((r) => setTimeout(() => r('HÄNGT'), 3000)),
    ]);
    assert.notEqual(result, 'HÄNGT');
    assert.equal(result.ok, false);
  });
});

test('Upload: „angenommen“, bevor die Datei durch war → kein Erfolg', async () => {
  const file = tempFile(3_000_000);
  await withServer((req, res) => {
    req.once('data', () => { res.writeHead(200); res.end(); }); // nach dem ersten Stück
    req.resume();
  }, async (url) => {
    const result = await client.uploadFile({ uploadUrl: url, filePath: file, fileSize: 3_000_000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /[Vv]or dem Ende/);
  });
});
