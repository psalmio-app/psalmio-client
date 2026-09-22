/**
 * Der ganze Weg einer Aufnahme – gegen ein nachgebautes Psalmio samt Speicher,
 * beides echte Server auf localhost.
 *
 * Das nachgebaute Psalmio hält sich an docs/API.md: Es teilt die Datei,
 * vergibt je Teil eine Adresse, kennt `parts_done` und prüft beim Abschluss
 * die Summe der Teile gegen die gemeldete Dateigröße.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');

const client = require('../src');
const { tempFile, readBody } = require('./helpers');

const PART = 100_000;

async function mitPsalmio(optionen, run) {
  const zustand = { teile: new Map(), anfragen: [], putVersuche: new Map(), abgeschlossen: null, einzeln: null, verworfen: null };
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const origin = `http://127.0.0.1:${server.address().port}`;

    // ── der „Speicher" ──
    if (req.method === 'PUT') {
      const url = new URL(req.url, origin);
      const nummer = Number(url.searchParams.get('partNumber') || 0);
      const versuch = (zustand.putVersuche.get(nummer) || 0) + 1;
      zustand.putVersuche.set(nummer, versuch);
      const stoerung = optionen.putStoerung?.(nummer, versuch);
      if (stoerung === 'kappen') { req.socket.destroy(); return; }
      const inhalt = await readBody(req);
      if (stoerung) { res.writeHead(stoerung); res.end(); return; }
      if (nummer) zustand.teile.set(nummer, inhalt); else zustand.einzeln = inhalt;
      res.writeHead(200); res.end();
      return;
    }

    // ── die API ──
    const pfad = req.url.replace(client.API_PREFIX, '');
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    zustand.anfragen.push({ pfad, body });
    const plan = (groesse) => {
      const anzahl = Math.max(1, Math.ceil(groesse / PART));
      const urls = {};
      for (let n = 1; n <= anzahl; n += 1) urls[n] = `${origin}/bucket/9/video_original.mp4?uploadId=u1&partNumber=${n}`;
      return { upload_id: 'u1', object_name: '9/video_original.mp4', method: 'PUT', part_size: PART, part_count: anzahl, urls, expires_in: 21600 };
    };

    if (pfad.endsWith('/multipart/start')) {
      if (optionen.ohneTeile) return json(404, { detail: 'Not Found' });
      // Ein Server, der sich verrechnet: zu wenige Teile für die Datei
      if (optionen.falscherPlan) return json(200, { data: { ...plan(body.file_size), part_count: 1 } });
      return json(200, { data: plan(body.file_size) });
    }
    if (pfad.endsWith('/multipart/resume')) {
      return json(200, { data: { ...plan(body.file_size), parts_done: [...zustand.teile.keys()].sort((a, b) => a - b) } });
    }
    if (pfad.endsWith('/multipart/abort')) { zustand.verworfen = body.upload_id; return json(200, { data: { aborted: true } }); }
    if (pfad.endsWith('/multipart/complete')) {
      const summe = [...zustand.teile.values()].reduce((s, t) => s + t.length, 0);
      if (summe !== body.file_size) return json(409, { detail: { error_code: 'UPLOAD_INCOMPLETE', message: `${summe} von ${body.file_size}` } });
      zustand.abgeschlossen = body;
      return json(200, { data: { job_id: 42, file_size: summe } });
    }
    if (pfad.endsWith('/recording/upload-url')) return json(200, { data: { upload_url: `${origin}/bucket/9/video_original.mp4?sig=x`, method: 'PUT' } });
    if (pfad.endsWith('/recording/complete')) { zustand.abgeschlossen = body; return json(200, { data: { job_id: 43, file_size: zustand.einzeln.length } }); }
    return json(404, { detail: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'sk-test' };
  try {
    return await run(config, zustand);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** Datei mit erkennbarem Inhalt: Byte i trägt (i / PART) – so fällt ein vertauschter Teil auf. */
function musterDatei(bytes) {
  const file = tempFile(bytes);
  const inhalt = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) inhalt[i] = Math.floor(i / PART) + 1;
  fs.writeFileSync(file, inhalt);
  return { file, inhalt };
}

const zusammen = (zustand) => Buffer.concat([...zustand.teile.keys()].sort((a, b) => a - b).map((n) => zustand.teile.get(n)));

test('in Teilen: jede Stelle der Datei kommt genau einmal und am richtigen Platz an', async () => {
  const { file, inhalt } = musterDatei(PART * 3 + 12_345);
  await mitPsalmio({}, async (config, zustand) => {
    const fortschritt = [];
    const result = await client.uploadRecording(config, '9', {
      filePath: file, recordingStartedAt: 1790000000, onProgress: (p) => fortschritt.push(p),
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.stage, 'done');
    assert.equal(result.data.job_id, 42);
    assert.equal(zustand.teile.size, 4);
    assert.ok(zusammen(zustand).equals(inhalt), 'zusammengesetzt muss es wieder die Datei sein');
    assert.deepEqual(zustand.abgeschlossen, { upload_id: 'u1', file_size: inhalt.length, recording_started_at: 1790000000 });
    assert.equal(fortschritt.at(-1).percent, 100);
    assert.equal(fortschritt.at(-1).sentBytes, inhalt.length, 'Fortschritt zählt über alle Teile, nicht je Teil');
  });
});

test('ein Teil scheitert zweimal und geht beim dritten Versuch durch – die anderen werden nicht wiederholt', async () => {
  const { file, inhalt } = musterDatei(PART * 3);
  await mitPsalmio({ putStoerung: (nummer, versuch) => (nummer === 2 && versuch <= 2 ? 'kappen' : null) }, async (config, zustand) => {
    const result = await client.uploadRecording(config, '9', { filePath: file }, { retryDelayMs: 5 });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual([...zustand.putVersuche.entries()].sort(), [[1, 1], [2, 3], [3, 1]]);
    assert.ok(zusammen(zustand).equals(inhalt));
  });
});

test('gibt ein Teil endgültig auf, bleibt der Upload fortsetzbar – und setzt später nur den Rest fort', async () => {
  const { file, inhalt } = musterDatei(PART * 3);
  let gestoert = true;
  await mitPsalmio({ putStoerung: (nummer) => (gestoert && nummer === 3 ? 'kappen' : null) }, async (config, zustand) => {
    let abdruck = null;
    const erster = await client.uploadRecording(config, '9', {
      filePath: file, partAttempts: 2, onUploadStart: ({ file: f }) => { abdruck = f; },
    }, { retryDelayMs: 5 });
    assert.equal(erster.ok, false);
    assert.equal(erster.stage, 'upload');
    assert.equal(erster.part, 3);
    assert.equal(erster.uploadId, 'u1', 'ohne Kennung ließe sich nichts fortsetzen');
    assert.equal(zustand.abgeschlossen, null, 'eine Aufnahme ohne Schluss darf nie abgeschlossen werden');

    gestoert = false; // die Leitung steht wieder
    zustand.putVersuche.clear();
    const zweiter = await client.uploadRecording(config, '9', { filePath: file, uploadId: erster.uploadId, resumeFile: abdruck }, { retryDelayMs: 5 });

    assert.equal(zweiter.ok, true, zweiter.error);
    assert.deepEqual([...zustand.putVersuche.keys()], [3], 'Teil 1 und 2 lagen schon – nur der Rest geht über die Leitung');
    assert.ok(zusammen(zustand).equals(inhalt));
  });
});

test('abgelaufene Adresse (403): frische holen und weitermachen', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({ putStoerung: (nummer, versuch) => (nummer === 1 && versuch === 1 ? 403 : null) }, async (config, zustand) => {
    const result = await client.uploadRecording(config, '9', { filePath: file }, { retryDelayMs: 5 });

    assert.equal(result.ok, true, result.error);
    assert.ok(zustand.anfragen.some((a) => a.pfad.endsWith('/multipart/resume')), 'nach dem 403 müssen neue Adressen geholt werden');
  });
});

test('Abbrechen wirkt – und die Kennung zum Fortsetzen kommt mit zurück', async () => {
  const { file } = musterDatei(PART * 4);
  const controller = new AbortController();
  await mitPsalmio({}, async (config, zustand) => {
    const result = await client.uploadRecording(config, '9', {
      filePath: file, signal: controller.signal,
      onProgress: (p) => { if (p.part === 2) controller.abort(); },
    });

    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(result.uploadId, 'u1');
    assert.equal(zustand.abgeschlossen, null);
  });
});

test('ältere Psalmio-Fassung ohne Teile: weicht auf den einzelnen PUT aus', async () => {
  const { file, inhalt } = musterDatei(PART + 500);
  await mitPsalmio({ ohneTeile: true }, async (config, zustand) => {
    const result = await client.uploadRecording(config, '9', { filePath: file, recordingStartedAt: 1790000000 });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.job_id, 43);
    assert.ok(zustand.einzeln.equals(inhalt));
    assert.deepEqual(zustand.abgeschlossen, { recording_started_at: 1790000000 });
  });
});

test('Datei fehlt oder ist leer: Auskunft, bevor Psalmio überhaupt gefragt wird', async () => {
  await mitPsalmio({}, async (config, zustand) => {
    const fehlt = await client.uploadRecording(config, '9', { filePath: '/gibt/es/nicht.mp4' });
    assert.deepEqual([fehlt.ok, fehlt.stage], [false, 'file']);
    const leer = await client.uploadRecording(config, '9', { filePath: tempFile(0) });
    assert.deepEqual([leer.ok, leer.stage], [false, 'file']);
    assert.equal(zustand.anfragen.length, 0);
  });
});

test('Psalmios Ablehnung beim Eröffnen kommt unverändert durch (z. B. vorhandene Aufnahme)', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: { error_code: 'RECORDING_ALREADY_EXISTS', message: 'Aufnahme liegt schon vor' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const result = await client.uploadRecording(
      { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'k' }, '9', { filePath: tempFile(10) },
    );
    assert.deepEqual([result.ok, result.stage, result.status, result.code], [false, 'start', 409, 'RECORDING_ALREADY_EXISTS']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('die Kennung steht fest, bevor das erste Byte fließt – sonst gibt es nach einem Stromausfall nichts fortzusetzen', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({}, async (config) => {
    const ablauf = [];
    let gemeldet = null;
    await client.uploadRecording(config, '9', {
      filePath: file,
      onUploadStart: (s) => { ablauf.push('kennung'); gemeldet = s; },
      onProgress: () => { if (ablauf.at(-1) !== 'bytes') ablauf.push('bytes'); },
    });
    assert.deepEqual(ablauf, ['kennung', 'bytes']);
    assert.equal(gemeldet.uploadId, 'u1');
    assert.equal(gemeldet.resumed, false);
    assert.equal(gemeldet.partCount, 2);
    assert.equal(gemeldet.file.size, PART * 2);
    assert.ok(gemeldet.file.mtimeMs > 0);
  });
});

test('Fortsetzen gilt der Datei: eine andere Datei wird abgelehnt, statt Teile zweier Dateien zu verweben', async () => {
  // Der gemeine Fall: Die neue Datei ist genauso groß wie die alte. Nur die
  // Änderungszeit verrät, dass unter dem Pfad inzwischen etwas anderes liegt.
  const alt = musterDatei(PART * 2);
  await mitPsalmio({}, async (config, zustand) => {
    // Erster Lauf: bricht nach dem ersten Teil ab
    const abbruch = new AbortController();
    const ersterLauf = await client.uploadRecording(config, '9', {
      filePath: alt.file,
      onUploadStart: () => {},
      onProgress: (p) => { if (p.part === 2) abbruch.abort(); },
      signal: abbruch.signal,
    });
    assert.equal(ersterLauf.aborted, true);
    const abdruck = { path: alt.file, size: fs.statSync(alt.file).size, mtimeMs: Math.round(fs.statSync(alt.file).mtimeMs) };
    assert.equal(zustand.teile.size, 1);

    // Unter demselben Pfad liegt jetzt etwas anderes – gleich groß, anderer Inhalt
    fs.writeFileSync(alt.file, Buffer.alloc(PART * 2, 99));
    fs.utimesSync(alt.file, new Date(), new Date(abdruck.mtimeMs + 60_000));

    const zweiterLauf = await client.uploadRecording(config, '9', {
      filePath: alt.file,
      uploadId: ersterLauf.uploadId,
      resumeFile: abdruck,
    });
    assert.equal(zweiterLauf.ok, false);
    assert.equal(zweiterLauf.code, 'RESUME_FILE_MISMATCH');
    // Nichts angefasst: kein resume, kein weiterer Teil, nichts zusammengefügt
    assert.equal(zustand.anfragen.filter((a) => a.pfad.endsWith('/multipart/resume')).length, 0);
    assert.equal(zustand.teile.size, 1);
    assert.equal(zustand.abgeschlossen, null);
  });
});

test('Fortsetzen derselben Datei: der Rest geht weiter und die Aufnahme stimmt Byte für Byte', async () => {
  const { file, inhalt } = musterDatei(PART * 3);
  await mitPsalmio({}, async (config, zustand) => {
    const abbruch = new AbortController();
    const erster = await client.uploadRecording(config, '9', {
      filePath: file,
      onProgress: (p) => { if (p.part === 2) abbruch.abort(); },
      signal: abbruch.signal,
    });
    const stat = fs.statSync(file);
    const zweiter = await client.uploadRecording(config, '9', {
      filePath: file,
      uploadId: erster.uploadId,
      resumeFile: { path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
    });
    assert.equal(zweiter.ok, true);
    assert.deepEqual(zusammen(zustand), inhalt);
  });
});

test('ein Plan, der nicht zur Datei passt, wird abgelehnt – sonst landen Stücke falscher Größe an derselben Stelle', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({ falscherPlan: true }, async (config, zustand) => {
    const result = await client.uploadRecording(config, '9', { filePath: file });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'START_PLAN_MISMATCH');
    assert.equal(zustand.teile.size, 0);
  });
});

test('eine uploadId ohne Fingerabdruck wird abgelehnt, bevor Psalmio gefragt wird – still fortsetzen hieße, jeder Datei fremde Teile unterzuschieben', async () => {
  // So kam es aus der Kommandozeile: „psalmio upload … --resume u1" gab keinen resumeFile mit
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({}, async (config, zustand) => {
    const ohne = await client.uploadRecording(config, '9', { filePath: file, uploadId: 'u1' });
    assert.deepEqual([ohne.ok, ohne.stage, ohne.code, ohne.uploadId], [false, 'resume', 'RESUME_FILE_MISSING', 'u1']);

    const stat = fs.statSync(file);
    const halb = await client.uploadRecording(config, '9', { filePath: file, uploadId: 'u1', resumeFile: { path: file, size: stat.size } });
    assert.equal(halb.code, 'RESUME_FILE_MISSING', 'ohne Änderungszeit ist der Abdruck nicht vollständig');

    assert.equal(zustand.anfragen.length, 0);
    assert.equal(zustand.teile.size, 0);
  });
});

test('onUploadStart darf eine Promise liefern – das erste Byte fließt erst, wenn sie erfüllt ist', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({}, async (config) => {
    const ablauf = [];
    const result = await client.uploadRecording(config, '9', {
      filePath: file,
      onUploadStart: async () => {
        await new Promise((r) => setTimeout(r, 30));
        ablauf.push('kennung gesichert');
      },
      onProgress: () => { if (ablauf.at(-1) !== 'bytes') ablauf.push('bytes'); },
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(ablauf, ['kennung gesichert', 'bytes']);
  });
});

test('scheitert onUploadStart, endet der Upload vor dem ersten Byte – und der eben eröffnete wird gleich zurückgegeben', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({}, async (config, zustand) => {
    for (const rueckruf of [() => { throw new Error('Platte voll'); }, async () => { throw new Error('Platte voll'); }]) {
      zustand.verworfen = null;
      const result = await client.uploadRecording(config, '9', { filePath: file, onUploadStart: rueckruf });
      assert.deepEqual([result.ok, result.stage, result.code], [false, 'start', 'UPLOAD_START_HOOK_FAILED']);
      assert.match(result.error, /Platte voll/);
      assert.equal(result.uploadId, undefined, 'die Kennung ist verworfen – mit ihr lässt sich nichts fortsetzen');
      assert.equal(zustand.verworfen, 'u1');
      assert.equal(zustand.teile.size, 0);
    }
  });
});

test('scheitert onUploadStart beim Fortsetzen, bleibt der Upload fortsetzbar – seine Kennung steht ja schon irgendwo', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({}, async (config, zustand) => {
    const stat = fs.statSync(file);
    const result = await client.uploadRecording(config, '9', {
      filePath: file,
      uploadId: 'u1',
      resumeFile: { path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
      onUploadStart: () => { throw new Error('Platte voll'); },
    });
    assert.deepEqual([result.ok, result.stage, result.code, result.uploadId], [false, 'resume', 'UPLOAD_START_HOOK_FAILED', 'u1']);
    assert.equal(zustand.verworfen, null);
  });
});
