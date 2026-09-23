/**
 * Die Kommandozeile – als eigener Prozess gegen ein nachgebautes Psalmio samt
 * Speicher auf localhost.
 *
 * Anlass war Tim Fasts Nachstellung: „psalmio upload … --resume u1" gab keinen
 * Fingerabdruck an die Bibliothek, die Prüfung fiel weg, und eine gleich groß
 * neu geschriebene Datei wurde mit den Teilen der alten zu einer Aufnahme.
 * Hier bricht der Upload so ab wie im echten Leben: Der Prozess wird mitten im
 * Upload abgeschossen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const client = require('../src');
const { tempFile, readBody } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'psalmio.js');
const PART = 100_000;

/**
 * Psalmio mit Speicher, der sich wie der echte verhält: Jeder Start eröffnet
 * einen neuen Upload mit eigener Kennung, `abort` wirft seine Teile weg,
 * `resume` kennt nur, was noch da ist. `steuerung.beimTeil` wird gerufen,
 * bevor ein Teil gelesen wird – dort lässt sich der Prozess abschießen.
 */
async function mitPsalmio(steuerung, run) {
  const z = { uploads: new Map(), anfragen: [], verworfen: [], abgeschlossen: null, starts: 0 };
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const origin = `http://127.0.0.1:${server.address().port}`;

    if (req.method === 'PUT') {
      const url = new URL(req.url, origin);
      const nummer = Number(url.searchParams.get('partNumber'));
      steuerung.beimTeil?.(nummer);
      const inhalt = await readBody(req);
      z.uploads.get(url.searchParams.get('uploadId'))?.set(nummer, inhalt);
      res.writeHead(200); res.end();
      return;
    }

    const pfad = req.url.replace(client.API_PREFIX, '');
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    z.anfragen.push(pfad);
    const plan = (uploadId, groesse) => {
      const anzahl = Math.ceil(groesse / PART);
      const urls = {};
      for (let n = 1; n <= anzahl; n += 1) urls[n] = `${origin}/bucket/9/video_original.mp4?uploadId=${uploadId}&partNumber=${n}`;
      return { upload_id: uploadId, part_size: PART, part_count: anzahl, urls, expires_in: 21600 };
    };

    if (pfad.endsWith('/start') && !pfad.includes('/multipart/')) {
      z.gestartet = body.started_at;
      return json(200, { data: { already_started: false } });
    }
    if (pfad.endsWith('/multipart/start')) {
      z.starts += 1;
      const uploadId = `u${z.starts}`;
      z.uploads.set(uploadId, new Map());
      return json(200, { data: plan(uploadId, body.file_size) });
    }
    if (pfad.endsWith('/multipart/resume')) {
      const teile = z.uploads.get(body.upload_id);
      if (!teile) return json(404, { detail: { error_code: 'UPLOAD_NOT_RESUMABLE', message: 'unbekannt' } });
      // Wie Psalmio: Der Plan entsteht aus der gesendeten Größe neu
      return json(200, { data: { ...plan(body.upload_id, body.file_size), parts_done: [...teile.keys()].sort((a, b) => a - b) } });
    }
    if (pfad.endsWith('/multipart/abort')) {
      z.verworfen.push(body.upload_id);
      z.uploads.delete(body.upload_id);
      return json(200, { data: { aborted: true } });
    }
    if (pfad.endsWith('/multipart/complete')) {
      // Wie der Speicher mit der Ein-Tag-Regel: Der Upload ist beim Zusammenfügen schon weg
      if (steuerung.verworfenBeimZusammenfuegen) {
        z.uploads.delete(body.upload_id);
        return json(404, { detail: { error_code: 'UPLOAD_NOT_RESUMABLE', message: 'Upload unbekannt oder abgelaufen' } });
      }
      const teile = z.uploads.get(body.upload_id);
      const ganz = Buffer.concat([...teile.keys()].sort((a, b) => a - b).map((n) => teile.get(n)));
      if (ganz.length !== body.file_size) return json(409, { detail: { error_code: 'UPLOAD_INCOMPLETE', message: `${ganz.length} von ${body.file_size}` } });
      z.abgeschlossen = { uploadId: body.upload_id, inhalt: ganz };
      return json(200, { data: { job_id: 42, file_size: ganz.length } });
    }
    return json(404, { detail: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, z);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** Die Kommandozeile als eigener Prozess. `beiStart` bekommt ihn – zum Abschießen. */
function psalmio(origin, args, beiStart) {
  return new Promise((resolve) => {
    const kind = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PSALMIO_URL: origin, PSALMIO_API_KEY: 'sk-test' },
    });
    let out = '';
    let err = '';
    kind.stdout.on('data', (d) => { out += d; });
    kind.stderr.on('data', (d) => { err += d; });
    beiStart?.(kind);
    kind.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

/** Datei mit erkennbarem Inhalt je Teil – ein Teil der falschen Datei fiele beim Vergleich auf. */
function musterDatei(bytes, versatz = 0) {
  const file = tempFile(bytes);
  const inhalt = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) inhalt[i] = (Math.floor(i / PART) + 1 + versatz) % 256;
  fs.writeFileSync(file, inhalt);
  return { file, inhalt };
}

/** Upload starten und abschießen, sobald Teil 2 ankommt – Teil 1 liegt dann schon. */
async function abgebrochenerUpload(origin, file, steuerung) {
  let kind;
  steuerung.beimTeil = (nummer) => { if (nummer === 2) kind.kill('SIGKILL'); };
  const lauf = await psalmio(origin, ['upload', file, '--event', '9'], (k) => { kind = k; });
  steuerung.beimTeil = null;
  return lauf;
}

test('abgeschossen mitten im Upload: --resume setzt dieselbe Datei fort, Byte für Byte', async () => {
  const { file, inhalt } = musterDatei(PART * 3 + 500);
  const steuerung = {};
  await mitPsalmio(steuerung, async (origin, z) => {
    const erster = await abgebrochenerUpload(origin, file, steuerung);
    assert.equal(erster.signal, 'SIGKILL');

    // Kennung und Fingerabdruck liegen neben der Aufnahme, bevor das erste Byte floss
    const merk = JSON.parse(fs.readFileSync(`${file}.psalmio-upload.json`, 'utf8'));
    assert.equal(merk.uploadId, 'u1');
    assert.equal(merk.eventId, '9');
    assert.deepEqual(Object.keys(merk.file).sort(), ['mtimeMs', 'path', 'size']);

    const zweiter = await psalmio(origin, ['upload', file, '--event', '9', '--resume']);
    assert.equal(zweiter.code, 0, zweiter.err);
    assert.equal(z.starts, 1, 'fortgesetzt, nicht neu eröffnet');
    assert.ok(z.abgeschlossen.inhalt.equals(inhalt));
    assert.equal(fs.existsSync(`${file}.psalmio-upload.json`), false, 'erledigt – nichts mehr fortzusetzen');
  });
});

test('Tims Nachstellung: gleich groß neu geschrieben – --resume verweigert, statt zwei Dateien zu einer Aufnahme zu machen', async () => {
  const { file } = musterDatei(PART * 3 + 500);
  const steuerung = {};
  await mitPsalmio(steuerung, async (origin, z) => {
    await abgebrochenerUpload(origin, file, steuerung);
    const merk = JSON.parse(fs.readFileSync(`${file}.psalmio-upload.json`, 'utf8'));

    // Unter demselben Pfad liegt jetzt eine andere Aufnahme derselben Größe
    const neu = musterDatei(PART * 3 + 500, 100);
    fs.copyFileSync(neu.file, file);
    fs.utimesSync(file, new Date(), new Date(merk.file.mtimeMs + 60_000));

    const weiter = await psalmio(origin, ['upload', file, '--event', '9', '--resume']);
    assert.equal(weiter.code, 1);
    assert.match(weiter.err, /RESUME_FILE_MISMATCH/);
    assert.equal(z.anfragen.filter((p) => p.endsWith('/multipart/resume')).length, 0);
    assert.equal(z.abgeschlossen, null, 'nichts zusammengefügt');

    // Von vorn: Der halbe Upload der alten Datei wird zurückgegeben, die neue geht ganz hoch
    const vonVorn = await psalmio(origin, ['upload', file, '--event', '9']);
    assert.equal(vonVorn.code, 0, vonVorn.err);
    assert.deepEqual(z.verworfen, ['u1']);
    assert.equal(z.abgeschlossen.uploadId, 'u2');
    assert.ok(z.abgeschlossen.inhalt.equals(neu.inhalt));
  });
});

test('--resume ohne gemerkten Stand: Fehler statt still von vorn', async () => {
  const { file } = musterDatei(PART);
  await mitPsalmio({}, async (origin, z) => {
    const lauf = await psalmio(origin, ['upload', file, '--event', '9', '--resume']);
    assert.equal(lauf.code, 1);
    assert.match(lauf.err, /Nichts zum Fortsetzen/);
    assert.equal(z.anfragen.length, 0);
  });
});

test('--resume mit dem Stand eines anderen Termins: Fehler, bevor Psalmio gefragt wird', async () => {
  const { file } = musterDatei(PART);
  await mitPsalmio({}, async (origin, z) => {
    const stat = fs.statSync(file);
    fs.writeFileSync(`${file}.psalmio-upload.json`, JSON.stringify({
      baseUrl: origin, eventId: '7', uploadId: 'u9', file: { path: file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
    }));
    const lauf = await psalmio(origin, ['upload', file, '--event', '9', '--resume']);
    assert.equal(lauf.code, 1);
    assert.match(lauf.err, /Termin 7/);
    assert.equal(z.anfragen.length, 0);
  });
});

test('Stand nicht schreibbar: Der Upload endet vor dem ersten Byte, der eröffnete wird zurückgegeben', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({}, async (origin, z) => {
    const lauf = await psalmio(origin, ['upload', file, '--event', '9', '--state', path.join(file, 'gibt-es-nicht', 'stand.json')]);
    assert.equal(lauf.code, 1);
    assert.match(lauf.err, /nicht schreibbar/);
    assert.match(lauf.err, /UPLOAD_START_HOOK_FAILED/);
    assert.deepEqual(z.verworfen, ['u1']);
    assert.equal(z.uploads.size, 0);
  });
});

test('Optionen auch als --name=wert: --window-tz=Europe/Berlin fällt nicht mehr still weg', async () => {
  const { file } = musterDatei(10);
  const manifest = path.join(path.dirname(file), 'zuordnung.tsv');
  fs.writeFileSync(manifest, `pfad\tct_id\n${file}\t9\n`);
  const lauf = await psalmio('http://127.0.0.1:9', ['batch', manifest, '--window=22:00-06:00', '--window-tz=Europe/Berlin', '--dry-run']);
  assert.equal(lauf.code, 0, lauf.err);
  assert.match(lauf.err, /Zeitfenster 22:00-06:00 in der Zone Europe\/Berlin\./);
});

test('falsch aufgerufen: unbekannte Option, fehlender Wert, alte Form „--resume <id>" – Rückgabewert 64, nichts geht los', async () => {
  const { file } = musterDatei(PART);
  await mitPsalmio({}, async (origin, z) => {
    for (const args of [
      ['upload', file, '--event', '9', '--resume', 'u1'],
      ['upload', file, '--event', '9', '--resume=u1'],
      ['batch', 'zuordnung.tsv', '--wndow', '22:00-06:00'],
      ['batch', 'zuordnung.tsv', '--window-tz'],
      ['upload', file, '--event', '--resume'],
    ]) {
      const lauf = await psalmio(origin, args);
      assert.equal(lauf.code, 64, `${args.join(' ')} → ${lauf.code}: ${lauf.err}`);
    }
    assert.equal(z.anfragen.length, 0);
  });
});

test('Option am falschen Befehl: „upload … --dry-run" lädt nicht wirklich hoch – Rückgabewert 64', async () => {
  const { file } = musterDatei(PART);
  await mitPsalmio({}, async (origin, z) => {
    for (const args of [
      ['upload', file, '--event', '9', '--dry-run'],
      ['start', '9', '--window', '22:00-06:00'],
      ['batch', 'zuordnung.tsv', '--event', '9'],
      ['event', '9', '--state', 'stand.json'],
      ['status', '--resume'],
    ]) {
      const lauf = await psalmio(origin, args);
      assert.equal(lauf.code, 64, `${args.join(' ')} → ${lauf.code}: ${lauf.err}`);
      assert.match(lauf.err, /gilt nicht für/);
    }
    assert.equal(z.anfragen.length, 0);
    assert.equal(fs.existsSync(`${file}.psalmio-upload.json`), false);
  });
});

test('Psalmio verwirft den Upload beim Zusammenfügen: kein Stand zum Fortsetzen, Hinweis auf einen neuen Upload', async () => {
  const { file } = musterDatei(PART * 2);
  await mitPsalmio({ verworfenBeimZusammenfuegen: true }, async (origin) => {
    const lauf = await psalmio(origin, ['upload', file, '--event', '9']);
    assert.equal(lauf.code, 1, lauf.err);
    assert.match(lauf.err, /UPLOAD_NOT_RESUMABLE/);
    assert.match(lauf.err, /ohne --resume neu hochladen/);
    assert.equal(fs.existsSync(`${file}.psalmio-upload.json`), false, 'eine Kennung, die Psalmio nicht mehr kennt, wird nicht zum Fortsetzen angeboten');
  });
});

test('Befehlsname wie eine Eigenschaft des Objekt-Prototyps: Rückgabewert 64, kein „is not a function"', async () => {
  for (const args of [['constructor', '--json'], ['__proto__', '--json'], ['toString', '--url', 'http://127.0.0.1:9']]) {
    const lauf = await psalmio('http://127.0.0.1:9', args);
    assert.equal(lauf.code, 64, `${args.join(' ')} → ${lauf.code}: ${lauf.err}`);
    assert.doesNotMatch(lauf.err, /is not a function/);
  }
});

test('unplausible Zeiten enden mit 64, bevor Psalmio gefragt wird – „2026" ist kein Zeitpunkt, Millisekunden sind keine Sekunden', async () => {
  const { file } = musterDatei(PART);
  await mitPsalmio({}, async (origin, z) => {
    for (const [args, grund] of [
      [['start', '9', '--at', '2026'], /unplausibel: 2026 wäre 1970/],
      [['start', '9', '--at', '1790000000000'], /Millisekunden/],
      [['start', '9', '--at', 'gestern'], /nicht lesbar/],
      [['upload', file, '--event', '9', '--started-at', '2026'], /unplausibel/],
    ]) {
      const lauf = await psalmio(origin, args);
      assert.equal(lauf.code, 64, `${args.join(' ')} → ${lauf.code}: ${lauf.err}`);
      assert.match(lauf.err, grund);
    }
    assert.equal(z.anfragen.length, 0);
    assert.equal(fs.existsSync(`${file}.psalmio-upload.json`), false);
  });
});

test('gültige Zeiten gehen durch: Unix-Sekunden und ISO-Zeit mit Zone', async () => {
  await mitPsalmio({}, async (origin, z) => {
    let lauf = await psalmio(origin, ['start', '9', '--at', '2026-09-20T10:00:00+02:00']);
    assert.equal(lauf.code, 0, lauf.err);
    assert.equal(z.gestartet, Date.UTC(2026, 8, 20, 8, 0, 0) / 1000);
    lauf = await psalmio(origin, ['start', '9', '--at', '1790000000']);
    assert.equal(lauf.code, 0, lauf.err);
    assert.equal(z.gestartet, 1790000000);
  });
});
