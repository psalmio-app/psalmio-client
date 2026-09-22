/**
 * Der Stapel-Lauf – gegen ein nachgebautes Psalmio auf localhost.
 *
 * Geprüft wird, was bei vierhundert Dateien zählt: Der Server bestimmt das
 * Tempo, ein Abbruch kostet nichts, und eine Absage hält den Lauf nicht auf.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const client = require('../src');
const { tempFile, readBody } = require('./helpers');

async function mitPsalmio(verhalten, run) {
  const z = { anfragen: [], hochgeladen: [], verworfen: [], queueAbfragen: 0 };
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.method === 'PUT') { await readBody(req); res.writeHead(200); res.end(); return; }

    const pfad = req.url.replace(client.API_PREFIX, '');
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    z.anfragen.push(pfad);
    const id = (/\/events\/([^/]+)/.exec(pfad) || [])[1];

    if (pfad === '/queue') {
      z.queueAbfragen += 1;
      if (verhalten.ohneQueue) return json(404, { detail: 'Not Found' });
      const beschaeftigt = (verhalten.beschaeftigtBis || 0) >= z.queueAbfragen;
      return json(200, { data: { active: beschaeftigt ? 1 : 0, idle: !beschaeftigt } });
    }
    if (pfad.endsWith('/multipart/start')) {
      const absage = verhalten.absagen?.[id];
      if (absage) return json(absage.status, { detail: absage.detail });
      return json(200, { data: { upload_id: `u-${id}`, part_size: 1_000_000, part_count: 1, urls: { 1: `${origin}/b/${id}?partNumber=1` } } });
    }
    if (pfad.endsWith('/multipart/resume')) {
      return json(200, { data: { upload_id: body.upload_id, part_size: 1_000_000, part_count: 1, parts_done: [], urls: { 1: `${origin}/b/${id}?partNumber=1` } } });
    }
    if (pfad.endsWith('/multipart/abort')) { z.verworfen.push(body.upload_id); return json(200, { data: { aborted: true } }); }
    if (pfad.endsWith('/multipart/complete')) { z.hochgeladen.push(id); return json(200, { data: { job_id: Number(id), file_size: body.file_size } }); }
    return json(404, { detail: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await run({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k' }, z);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const SCHNELL = { pollMs: 5, outageMs: 5, retryDelayMs: 5 };
const zeilen = (...ids) => ids.map((eventId) => ({ eventId, filePath: tempFile(5000) }));

test('Manifest: nimmt die Zuordnungsdatei einer Bestandsaufnahme direkt (weitere Spalten stören nicht)', () => {
  const text = 'pfad\tct_id\tmethode\tsicherheit\n/mnt/nas/a.mp4\t4357\tdatum\thoch\n/mnt/nas/test.mp4\t\tausgeschlossen\t\n/mnt/nas/b.mp4\t4360\tid\thoch\n';
  assert.deepEqual(client.parseManifest(text), {
    rows: [{ filePath: '/mnt/nas/a.mp4', eventId: '4357' }, { filePath: '/mnt/nas/b.mp4', eventId: '4360' }],
    skipped: 1,
  });
});

test('Manifest: derselbe Termin zweimal ist ein Fehler – und alle Doppelten stehen im Text', () => {
  const ergebnis = client.parseManifest('pfad\tct_id\n/a/teil1.mp4\t9549\n/a/teil2.mp4\t9549\n/b/1.mp4\t9550\n/b/2.mp4\t9550\n');
  assert.match(ergebnis.error, /9549/);
  assert.match(ergebnis.error, /9550/);
});

test('Manifest: ohne die Spalten pfad und ct_id geht nichts', () => {
  assert.match(client.parseManifest('datei;id\nx;1\n').error, /pfad/);
});

test('Zeitfenster: auch über Mitternacht', () => {
  const nachts = client.parseWindow('22:00-06:00');
  const um = (h, m = 0) => new Date(2026, 8, 22, h, m);
  assert.deepEqual([nachts.offen(um(23)), nachts.offen(um(3)), nachts.offen(um(6)), nachts.offen(um(12))], [true, true, false, false]);
  assert.ok(client.parseWindow('abends').error);
  assert.equal(client.parseWindow(''), null);
});

test('der Server bestimmt das Tempo: erst hochladen, wenn nichts mehr ansteht', async () => {
  await mitPsalmio({ beschaeftigtBis: 3 }, async (config, z) => {
    const ereignisse = [];
    const lauf = await client.runBatch(config, zeilen('1'), { onEvent: (e) => ereignisse.push(e.type) }, SCHNELL);

    assert.equal(lauf.ok, true);
    const ersterUpload = z.anfragen.findIndex((p) => p.endsWith('/multipart/start'));
    assert.equal(z.anfragen.slice(0, ersterUpload).filter((p) => p === '/queue').length, 4, 'dreimal beschäftigt, beim vierten Mal frei');
    assert.ok(ereignisse.includes('server-busy'));
  });
});

test('vor JEDER Datei wird neu nachgesehen – die vorige wird ja gerade verarbeitet', async () => {
  await mitPsalmio({}, async (config, z) => {
    await client.runBatch(config, zeilen('1', '2', '3'), {}, SCHNELL);
    assert.equal(z.queueAbfragen, 3);
    assert.deepEqual(z.hochgeladen, ['1', '2', '3']);
  });
});

test('Absagen halten den Lauf nicht auf: unbekannter Termin und vorhandene Aufnahme werden notiert', async () => {
  const absagen = {
    2: { status: 404, detail: { error_code: 'EVENT_NOT_FOUND', message: 'nicht vorhanden' } },
    3: { status: 409, detail: { error_code: 'RECORDING_ALREADY_EXISTS', message: 'liegt schon vor' } },
  };
  await mitPsalmio({ absagen }, async (config, z) => {
    const lauf = await client.runBatch(config, zeilen('1', '2', '3', '4'), {}, SCHNELL);

    assert.deepEqual(z.hochgeladen, ['1', '4']);
    assert.deepEqual(lauf.counts, { done: 2, exists: 1, unknown: 1, failed: 0, open: 0 });
    assert.equal(lauf.ok, true, 'Absagen sind kein Scheitern');
  });
});

test('ein zweiter Lauf überspringt Erledigtes – nichts geht doppelt über die Leitung', async () => {
  await mitPsalmio({}, async (config, z) => {
    const rows = zeilen('1', '2');
    const erster = await client.runBatch(config, rows, {}, SCHNELL);
    z.hochgeladen.length = 0;

    const zweiter = await client.runBatch(config, [...rows, ...zeilen('3')], { state: erster.state }, SCHNELL);

    assert.deepEqual(z.hochgeladen, ['3']);
    assert.equal(zweiter.counts.done, 3);
  });
});

test('der Stand wird gesichert, sobald die Kennung feststeht – und nach jeder Datei', async () => {
  await mitPsalmio({}, async (config) => {
    const staende = [];
    const reihen = zeilen('1', '2');
    await client.runBatch(config, reihen, {
      saveState: (state) => staende.push(JSON.parse(JSON.stringify(state))),
    }, SCHNELL);

    // Der erste gesicherte Stand kennt die Kennung – die Datei ist da noch unterwegs.
    // Genau darauf kommt es nach einem Stromausfall an: Ohne diesen Eintrag gäbe
    // es nichts fortzusetzen, und die halbe Datei läge unerreichbar im Speicher.
    assert.equal(staende[0]['1'].status, 'open');
    assert.equal(staende[0]['1'].uploadId, 'u-1');
    assert.equal(staende[0]['1'].uploadFile.path, reihen[0].filePath);
    assert.ok(staende[0]['1'].uploadFile.size > 0);
    assert.ok(staende[0]['1'].uploadFile.mtimeMs > 0);

    // Und nach jeder Datei steht, dass sie durch ist
    const fertig = staende.map((stand) => Object.values(stand).filter((e) => e.status === 'done').length);
    assert.deepEqual(fertig.at(-1), 2);
    assert.ok(fertig.includes(1));
  });
});

test('geänderte Datei: der halbe Upload wird verworfen, statt zwei Dateien zu einer Aufnahme zu verweben', async () => {
  await mitPsalmio({}, async (config, z) => {
    const [row] = zeilen('1');
    // Stand aus einem früheren Lauf – aber unter dem Pfad liegt inzwischen etwas anderes
    const state = { 1: { status: 'open', attempts: 0, uploadId: 'u-alt', uploadFile: { path: row.filePath, size: 999_999, mtimeMs: 1 } } };
    const ereignisse = [];
    const lauf = await client.runBatch(config, [row], { state, onEvent: (e) => ereignisse.push(e.type) }, SCHNELL);

    assert.ok(ereignisse.includes('file-changed'));
    assert.equal(z.anfragen.filter((pfad) => pfad.endsWith('/multipart/resume')).length, 0);
    assert.deepEqual(z.verworfen, ['u-alt']);      // die alten Teile sind weg
    assert.equal(lauf.state['1'].status, 'done');  // und die neue Datei ist durch
    assert.equal(lauf.state['1'].attempts, 1);     // der verworfene Versuch zählt nicht
  });
});

test('ein Stand ohne vollständigen Fingerabdruck wird nicht fortgesetzt – lieber von vorn als vermischt', async () => {
  for (const uploadFile of [undefined, { path: 'irgendwo.mp4', size: 5000 }]) {
    await mitPsalmio({}, async (config, z) => {
      const [row] = zeilen('1');
      const state = { 1: { status: 'open', attempts: 0, uploadId: 'u-alt', uploadFile } };
      const lauf = await client.runBatch(config, [row], { state }, SCHNELL);
      assert.equal(z.anfragen.filter((pfad) => pfad.endsWith('/multipart/resume')).length, 0);
      assert.equal(z.anfragen.filter((pfad) => pfad.endsWith('/multipart/start')).length, 1);
      // Was unter der alten Kennung liegt, lässt sich keiner Datei mehr sicher zuordnen
      assert.deepEqual(z.verworfen, ['u-alt']);
      assert.equal(lauf.state['1'].status, 'done');
      assert.equal(lauf.state['1'].attempts, 1);
    });
  }
});

test('vorübergehende Störung (503): warten und wiederholen statt aufgeben', async () => {
  let versuche = 0;
  await mitPsalmio({ absagen: new Proxy({}, { get: (_, id) => (id === '1' && ++versuche <= 2
    ? { status: 503, detail: { error_code: 'OBJECT_STORAGE_UNAVAILABLE', message: 'Speicher weg' } } : undefined) }) }, async (config, z) => {
    const lauf = await client.runBatch(config, zeilen('1'), {}, SCHNELL);
    assert.equal(lauf.ok, true);
    assert.equal(lauf.state['1'].attempts, 3);
    assert.deepEqual(z.hochgeladen, ['1']);
  });
});

test('was dauerhaft scheitert, wird als gescheitert notiert – und der Lauf geht weiter', async () => {
  const absagen = { 1: { status: 422, detail: { error_code: 'FILE_TOO_LARGE', message: 'zu groß' } } };
  await mitPsalmio({ absagen }, async (config, z) => {
    const lauf = await client.runBatch(config, zeilen('1', '2'), {}, SCHNELL);
    assert.equal(lauf.ok, false);
    assert.equal(lauf.state['1'].status, 'failed');
    assert.match(lauf.state['1'].error, /FILE_TOO_LARGE/);
    assert.equal(lauf.state['1'].attempts, 1, 'eine Absage wegen der Datei wird durch Wiederholen nicht besser');
    assert.deepEqual(z.hochgeladen, ['2']);
  });
});

test('fehlende Datei: sofort gescheitert, ohne den Server zu fragen oder zu warten', async () => {
  await mitPsalmio({}, async (config, z) => {
    const lauf = await client.runBatch(config, [{ eventId: '1', filePath: '/gibt/es/nicht.mp4' }], {}, SCHNELL);
    assert.equal(lauf.state['1'].status, 'failed');
    assert.equal(lauf.state['1'].attempts, 1);
    assert.equal(z.anfragen.filter((p) => p.includes('multipart')).length, 0);
  });
});

test('Zeitfenster: die Uhrzeit ist die der angegebenen Zeitzone, nicht die des Servers', () => {
  // Der Server der Videotechnik läuft auf UTC. „22:00-06:00" hieße dort im
  // Sommer 0 bis 8 Uhr deutscher Zeit – mitten in den Sonntagmorgen hinein.
  const berlin = client.parseWindow('22:00-06:00', 'Europe/Berlin');
  assert.equal(berlin.zone, 'Europe/Berlin');
  assert.equal(berlin.offen(new Date('2026-09-22T20:30:00Z')), true);   // 22:30 in Berlin
  assert.equal(berlin.offen(new Date('2026-09-22T06:30:00Z')), false);  // 08:30 in Berlin
  assert.equal(client.parseWindow('22:00-06:00', 'UTC').offen(new Date('2026-09-22T20:30:00Z')), false);
  assert.equal(client.parseWindow('00:00-06:00', 'Europe/Berlin').offen(new Date('2026-09-21T22:30:00Z')), true); // 00:30 in Berlin
  assert.match(client.parseWindow('22:00-06:00', 'Mond/Krater').error, /Zeitzone/);
});

test('nach dem Warten auf den Server wird das Zeitfenster erneut geprüft', async () => {
  // Das Warten auf den Server dauert eine Viertelstunde oder länger. Wurde
  // danach nicht noch einmal aufs Fenster geschaut, begann der Upload
  // womöglich am Sonntagmorgen – genau das soll das Fenster verhindern.
  await mitPsalmio({ beschaeftigtBis: 2 }, async (config, z) => {
    const blicke = [];
    const fenster = { offen: () => { blicke.push(z.queueAbfragen); return true; } };
    await client.runBatch(config, zeilen('1'), { window: fenster }, SCHNELL);
    assert.ok(z.queueAbfragen >= 3, 'der Server war erst nach mehreren Abfragen frei');
    assert.equal(Math.max(...blicke), z.queueAbfragen, 'zuletzt wurde nach der Queue aufs Fenster geschaut');
  });
});

test('außerhalb des Zeitfensters wird gewartet', async () => {
  await mitPsalmio({}, async (config, z) => {
    let blicke = 0;
    const lauf = await client.runBatch(config, zeilen('1'), { window: { offen: () => ++blicke > 3 } }, SCHNELL);
    assert.equal(lauf.ok, true);
    assert.ok(blicke > 3);
    assert.deepEqual(z.hochgeladen, ['1']);
  });
});

test('ältere Psalmio-Fassung ohne /queue: lädt trotzdem, sagt aber, dass die Bremse fehlt', async () => {
  await mitPsalmio({ ohneQueue: true }, async (config, z) => {
    const ereignisse = [];
    const lauf = await client.runBatch(config, zeilen('1', '2'), { onEvent: (e) => ereignisse.push(e.type) }, SCHNELL);
    assert.equal(lauf.ok, true);
    assert.equal(ereignisse.filter((t) => t === 'no-queue').length, 1);
    assert.equal(z.queueAbfragen, 1, 'nicht bei jeder Datei erneut fragen');
  });
});

test('Abbrechen: Stand bleibt, der Rest bleibt offen', async () => {
  await mitPsalmio({}, async (config) => {
    const controller = new AbortController();
    const lauf = await client.runBatch(config, zeilen('1', '2', '3'), {
      signal: controller.signal,
      onEvent: (e) => { if (e.type === 'finished' && e.eventId === '1') controller.abort(); },
    }, SCHNELL);
    assert.equal(lauf.aborted, true);
    assert.deepEqual(lauf.counts, { done: 1, exists: 0, unknown: 0, failed: 0, open: 2 });
  });
});
