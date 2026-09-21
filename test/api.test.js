/**
 * Die Aufrufe gegen Psalmio – gegen einen echten Server auf localhost.
 *
 * Was hier vor allem feststeht: wie Psalmios Antworten gedeutet werden. Daran
 * hängt, ob ein Termin still übersprungen, später wiederholt oder als Fehler
 * gemeldet wird.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const client = require('../src');
const { withServer, readBody } = require('./helpers');

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('„Termin unbekannt" nur bei Psalmios eigenem Code EVENT_NOT_FOUND', () => {
  assert.equal(client.isUnknownEvent({ ok: false, status: 404, code: 'EVENT_NOT_FOUND', fromApi: true }), true);
  assert.equal(client.isUnknownEvent({ ok: false, status: 404, error: 'HTTP 404', fromApi: false }), false, 'HTML-Seite einer falschen Adresse');
  assert.equal(client.isUnknownEvent({ ok: false, status: 404, error: 'Not Found', fromApi: true }), false, 'unbekannter Pfad, z. B. geänderte API');
  assert.equal(client.isUnknownEvent({ ok: true, status: 200 }), false);
});

test('„Nochmal versuchen" bei 503 – ChurchTools oder Speicher gerade nicht erreichbar', () => {
  assert.equal(client.isTemporaryOutage({ ok: false, status: 503, code: 'CHURCHTOOLS_UNAVAILABLE' }), true);
  assert.equal(client.isTemporaryOutage({ ok: false, status: 503, code: 'OBJECT_STORAGE_UNAVAILABLE' }), true);
  assert.equal(client.isTemporaryOutage({ ok: false, status: 500 }), false);
  assert.equal(client.isTemporaryOutage({ ok: false, error: 'Psalmio nicht erreichbar: …' }), false, 'ohne Antwort weiß man nichts');
});

test('Antworten werden auseinandergehalten: EVENT_NOT_FOUND, allgemeines „Not Found", 503, HTML-Seite', async () => {
  await withServer((req, res) => {
    const pfad = req.url.replace(client.API_PREFIX, '');
    if (pfad === '/events/1') return json(res, 404, { detail: { error_code: 'EVENT_NOT_FOUND', message: 'Event not found' } });
    if (pfad === '/events/2') return json(res, 404, { detail: 'Not Found' });
    if (pfad === '/events/3/start') return json(res, 503, { detail: { error_code: 'CHURCHTOOLS_UNAVAILABLE', message: 'ChurchTools nicht erreichbar' } });
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>nginx</html>');
  }, async (_url, origin) => {
    const config = { baseUrl: origin, apiKey: 'sk-test' };

    const unknown = await client.getEvent(config, '1');
    assert.equal(unknown.code, 'EVENT_NOT_FOUND');
    assert.equal(client.isUnknownEvent(unknown), true);

    const generic = await client.getEvent(config, '2');
    assert.equal(client.isUnknownEvent(generic), false, 'ein fehlender Pfad ist kein unbekannter Termin');
    assert.equal(client.isUnknownEndpoint(generic), true);

    const busy = await client.startEvent(config, '3', 1789);
    assert.equal(client.isTemporaryOutage(busy), true);

    const html = await client.getEvent(config, '4');
    assert.equal(html.ok, false);
    assert.equal(html.fromApi, false);
    assert.equal(client.isUnknownEvent(html), false);
    assert.equal(client.isUnknownEndpoint(html), false, 'eine falsche Adresse ist keine alte Psalmio-Fassung');
  });
});

test('Erfolg: die Nutzlast kommt ausgepackt zurück, der Key geht als Header mit', async () => {
  let gesehen = null;
  await withServer(async (req, res) => {
    gesehen = { key: req.headers['x-api-key'], body: JSON.parse((await readBody(req)).toString() || 'null'), url: req.url };
    json(res, 200, { success: true, data: { event_id: '77', already_started: false } });
  }, async (_url, origin) => {
    const result = await client.startEvent({ baseUrl: origin, apiKey: 'sk-test' }, '77', 1790000000);
    assert.deepEqual(result, { ok: true, status: 200, data: { event_id: '77', already_started: false } });
    assert.equal(gesehen.key, 'sk-test');
    assert.deepEqual(gesehen.body, { started_at: 1790000000, source: 'recording' });
    assert.equal(gesehen.url, `${client.API_PREFIX}/events/77/start`);
  });
});

test('Umleitungen wird NICHT gefolgt – der API-Key käme sonst beim neuen Host an', async () => {
  let fremderHostGefragt = false;
  const fremd = http.createServer((req, res) => { fremderHostGefragt = true; res.end('{}'); });
  await new Promise((r) => fremd.listen(0, '127.0.0.1', r));
  try {
    await withServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${fremd.address().port}/abgegriffen` });
      res.end();
    }, async (_url, origin) => {
      const result = await client.checkConnection({ baseUrl: origin, apiKey: 'sk-geheim' });
      assert.equal(result.ok, false);
      assert.equal(fremderHostGefragt, false);
    });
  } finally {
    await new Promise((r) => fremd.close(r));
  }
});

test('eine http-Adresse (außer localhost) wird gar nicht erst angefragt', async () => {
  let gefragt = false;
  const result = await client.checkConnection(
    { baseUrl: 'http://gemeinde.psalmio.de', apiKey: 'sk-test' },
    { fetch: async () => { gefragt = true; return new Response('{}'); } },
  );
  assert.equal(gefragt, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /https/);
});

test('ohne Adresse oder Key: klare Auskunft statt Netzfehler', async () => {
  assert.match((await client.checkConnection({ baseUrl: '', apiKey: 'x' })).error, /nicht eingerichtet/);
  assert.match((await client.checkConnection({ baseUrl: 'https://a.psalmio.de', apiKey: '' })).error, /nicht eingerichtet/);
});

test('Psalmio nicht erreichbar: wirft nicht, sagt es', async () => {
  const result = await client.checkConnection({ baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test' }, { timeoutMs: 1500 });
  assert.equal(result.ok, false);
  assert.match(result.error, /nicht erreichbar/);
});

test('Abschluss in Teilen schickt die Dateigröße als Prüfsumme mit', async () => {
  let body = null;
  await withServer(async (req, res) => {
    body = JSON.parse((await readBody(req)).toString());
    json(res, 200, { data: { job_id: 5 } });
  }, async (_url, origin) => {
    await client.completeMultipart({ baseUrl: origin, apiKey: 'k' }, '9', { uploadId: 'u1', fileSize: 1234, recordingStartedAt: 1790000000 });
    assert.deepEqual(body, { upload_id: 'u1', file_size: 1234, recording_started_at: 1790000000 });
  });
});
