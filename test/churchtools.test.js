/**
 * Der ChurchTools-Server – gegen ein nachgebautes ChurchTools auf localhost.
 *
 * Was hier vor allem feststeht: Ein Ablaufplan kommt so bei ChurchTools an, wie
 * die API ihn erwartet (Kalender des Termins, Dauern in Sekunden, Lieder über
 * ihr Arrangement), er wird nie über einen vorhandenen gelegt, der Modus
 * bestimmt, was angeboten wird, die Sperren gelten auch für die allgemeinen
 * Werkzeuge, Zeiten stimmen in Ortszeit – und der Login-Token steht in keiner
 * Antwort.
 *
 * Die Antworten des Nachbaus folgen der API-Beschreibung von ChurchTools 3.137
 * und dem, was das Psalmio-Backend seit Monaten aus einem echten ChurchTools
 * liest; die Fehlerform stammt aus echten Antworten.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createServer, normalisiereAdresse, einrichtungsfehler } = require('../src/churchtools');
const { pfadPruefen, verboten } = require('../src/churchtools/regeln');
const { zuZulu } = require('../src/churchtools/werkzeuge');
const { schemaText } = require('../src/churchtools/doku');
const { readBody } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'psalmio.js');
const TOKEN = 'ct-login-geheim-9876';

// ── Das nachgebaute ChurchTools ───────────────────────────────────────

const VORLAGE = {
  id: 40, name: 'Sonntag', series: 'Gottesdienst', calendarId: 2, isLocked: false,
  items: [
    { id: 4001, position: 0, type: 'text', title: 'Begrüßung', duration: 300, responsible: { text: '[Moderation]', persons: [] } },
    { id: 4002, position: 1, type: 'text', title: 'Predigt', duration: 1800, responsible: { text: '[Predigt]', persons: [] } },
  ],
};

const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/persons/{personId}/absences': {
      get: {
        summary: 'Get absences of a person',
        tags: ['Person'],
        parameters: [
          { name: 'personId', in: 'path', required: true, schema: { type: 'integer' }, description: 'ID of person' },
          { name: 'from_date', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Start of the range' },
        ],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Absence' } } } } } } } },
      },
      post: {
        summary: 'Create absence',
        tags: ['Person'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AbsenceCreate' } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/persons/{personId}/absences/{id}': { delete: { summary: 'Delete absence', responses: { 204: { description: 'Deleted' } } } },
    '/login': { post: { summary: 'Login with username and password (absence of session)', responses: { 200: { description: 'OK' } } } },
    '/persons/{personId}/logintoken': { get: { summary: 'Get login token of a person', responses: { 200: { description: 'OK' } } } },
    '/finance/accounts': { get: { summary: 'Get finance accounts with absence flag', responses: { 200: { description: 'OK' } } } },
    '/permissions/global': {
      get: { summary: 'Global permissions', responses: { 200: { description: 'OK' } } },
      put: { summary: 'Update global permissions', responses: { 200: { description: 'OK' } } },
    },
    '/wiki/categories': { get: { summary: 'Get wiki categories', responses: { 200: { description: 'OK' } } } },
  },
  components: {
    schemas: {
      // Absence enthält Person, Person enthält Absences – ein Kreis, wie es ihn in der echten Beschreibung gibt
      Absence: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'integer' }, startDate: { type: 'string', format: 'date', description: 'First day' },
          comment: { type: ['string', 'null'] }, person: { $ref: '#/components/schemas/Person' },
        },
      },
      Person: { type: 'object', properties: { id: { type: 'integer' }, absences: { type: 'array', items: { $ref: '#/components/schemas/Absence' } } } },
      AbsenceCreate: {
        type: 'object', required: ['absenceReasonId', 'startDate'],
        properties: {
          absenceReasonId: { type: 'integer', description: 'Reason of the absence' }, startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' }, comment: { type: 'string' },
        },
      },
    },
  },
};

function neuerStand() {
  return {
    anfragen: [],
    geschlafen: [],
    openapiAbrufe: 0,
    rollenAbrufe: 0,
    drossel: 0,
    naechsteId: 5000,
    events: new Map([
      [12, {
        id: 12, name: 'Gottesdienst', startDate: '2026-10-04T08:00:00Z', endDate: '2026-10-04T09:30:00Z', appointmentId: 500,
        calendar: { domainType: 'calendar', domainIdentifier: '2', title: 'Gottesdienste' }, isCanceled: false, note: 'Erntedank',
        eventServices: [
          { id: 901, serviceId: 1, personId: 7, person: { title: 'Anna Beispiel', domainIdentifier: '7' }, name: null, isAccepted: true, isValid: true, comment: '' },
          { id: 902, serviceId: 2, personId: null, person: null, name: null, isAccepted: false, isValid: true, comment: '' },
          { id: 903, serviceId: 1, personId: 8, person: { title: 'Abgelöst' }, name: null, isAccepted: false, isValid: false, comment: '' },
        ],
      }],
      [13, { id: 13, name: 'Jugendgottesdienst', startDate: '2026-10-11T16:00:00Z', endDate: '2026-10-11T17:30:00Z', calendar: { domainIdentifier: '2', title: 'Gottesdienste' }, isCanceled: false }],
      [14, { id: 14, name: 'Bibelstunde', startDate: '2026-10-07T17:30:00Z', endDate: '2026-10-07T19:00:00Z', calendar: null, isCanceled: false }],
    ]),
    agendas: new Map([
      [12, {
        id: 300, calendarId: 2, isLocked: false, name: null, series: null, eventStartPosition: 0,
        // Absichtlich nicht in Reihenfolge – die Werkzeuge sortieren nach position
        items: [
          {
            id: 1003, position: 2, type: 'text', title: 'Predigt', duration: 1800, start: '2026-10-04T08:04:00Z', isBeforeEvent: false,
            note: 'Folien bei Punkt 2', responsible: { text: '[Predigt]', persons: [] }, serviceGroupNotes: [{ serviceGroupId: 11, note: 'Mikro 2' }],
          },
          { id: 1001, position: 0, type: 'header', title: 'Ankommen', duration: 0, start: '2026-10-04T08:00:00Z', isBeforeEvent: false },
          {
            id: 1002, position: 1, type: 'song', title: 'Großer Gott', duration: 240, start: '2026-10-04T08:00:00Z', isBeforeEvent: false, note: null,
            responsible: { text: '[Lobpreis]', persons: [{ service: '[Lobpreis]', accepted: true, person: { title: 'Ben Musik' } }] },
            song: { songId: 55, title: 'Großer Gott, wir loben dich', arrangementId: 77, arrangement: 'Standard', key: 'F', bpm: 90, category: 'Lieder', isDefault: true },
            serviceGroupNotes: [],
          },
        ],
      }],
    ]),
  };
}

/** Ein Eintrag, wie ChurchTools ihn zurückgibt, aus dem, was hingeschickt wurde. */
function alsEintrag(z, e, position) {
  if (e.type === 'header') return { id: z.naechsteId++, position, type: 'header', title: e.title, duration: 0, start: null, isBeforeEvent: false };
  return {
    id: z.naechsteId++, position, type: e.type, title: e.title ?? (e.type === 'song' ? 'Großer Gott, wir loben dich' : ''),
    duration: e.duration ?? 0, start: null, isBeforeEvent: false, note: e.note ?? null,
    responsible: { text: e.responsible ?? null, persons: [] },
    serviceGroupNotes: e.serviceGroupNotes ?? [],
    ...(e.type === 'song'
      ? { song: e.arrangementId ? { songId: 55, title: 'Großer Gott, wir loben dich', arrangementId: e.arrangementId, arrangement: 'Standard', key: 'F' } : null }
      : {}),
  };
}

const FEHLER_401 = { message: 'Session expired!', translatedMessage: 'Die Session ist abgelaufen, bitte logge dich erneut ein.', messageKey: 'exception.unauthorized', args: [], errors: [] };
const FEHLER_404 = { message: 'Resource not found', translatedMessage: 'Nicht gefunden.', messageKey: 'exception.not_found', args: [], errors: [] };

async function mitChurchTools(run, { modus = 'schreiben', probe = false, zeitzone = 'Europe/Berlin', token = TOKEN } = {}) {
  const z = neuerStand();
  const server = http.createServer(async (req, res) => {
    const json = (status, body, kopf = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...kopf }); res.end(JSON.stringify(body)); };
    const leer = () => { res.writeHead(204); res.end(); };
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const roh = (await readBody(req)).toString();
    const body = roh ? JSON.parse(roh) : undefined;
    const query = {};
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
    const q = (name) => query[name]?.[0];
    z.anfragen.push({ method: req.method, path: p, query, body, auth: req.headers.authorization });

    if (p === '/system/runtime/swagger/openapi.json') { z.openapiAbrufe += 1; return json(200, OPENAPI); }
    if (req.headers.authorization !== `Login ${TOKEN}`) return json(401, FEHLER_401);
    let m;

    if (req.method === 'GET' && p === '/api/whoami') return json(200, { data: { id: 7, firstName: 'Anna', lastName: 'Beispiel', email: 'anna@example.org' } });
    // /info kommt ohne data-Hülle – wie beim echten ChurchTools
    if (req.method === 'GET' && p === '/api/info') return json(200, { build: '32910', version: '3.137.0', siteName: 'Testgemeinde', shortName: null });

    if (req.method === 'GET' && p === '/api/events') {
      const liste = [13, 12, 14].map((id) => { const { eventServices, ...e } = z.events.get(id); return e; });
      return json(200, { data: liste, meta: { count: liste.length } });
    }
    if ((m = /^\/api\/events\/(\d+)$/.exec(p)) && req.method === 'GET') {
      const e = z.events.get(Number(m[1]));
      return e ? json(200, { data: e }) : json(404, FEHLER_404);
    }
    if ((m = /^\/api\/events\/(\d+)\/agenda$/.exec(p))) {
      const id = Number(m[1]);
      if (!z.events.has(id)) return json(404, FEHLER_404);
      const agenda = z.agendas.get(id);
      if (req.method === 'GET') return agenda ? json(200, { data: agenda }) : json(404, FEHLER_404);
      if (req.method === 'DELETE') { z.agendas.delete(id); return leer(); }
      if (req.method === 'PUT') {
        if (!Number.isInteger(body?.calendarId)) {
          return json(400, { message: 'Validation failed', translatedMessage: 'Eingaben ungültig', errors: [{ fieldId: 'calendarId', message: 'required', translatedMessage: 'Pflichtfeld' }] });
        }
        let quelle = body.items ?? [];
        if (q('template_id')) quelle = VORLAGE.items.map((e) => ({ ...e, responsible: e.responsible.text }));
        if (q('event_id')) quelle = (z.agendas.get(Number(q('event_id')))?.items ?? []).map((e) => ({ ...e, responsible: e.responsible?.text }));
        const neu = {
          id: z.naechsteId++, calendarId: body.calendarId, isLocked: false, name: null, series: body.series ?? null,
          eventStartPosition: body.eventStartPosition ?? 0, items: quelle.map((e, i) => alsEintrag(z, e, i)),
        };
        z.agendas.set(id, neu);
        return json(200, { data: neu });
      }
    }
    if ((m = /^\/api\/events\/(\d+)\/agenda\/(lock|unlock)$/.exec(p)) && req.method === 'POST') return leer();
    if ((m = /^\/api\/events\/(\d+)\/agenda\/items$/.exec(p)) && req.method === 'POST') {
      const agenda = z.agendas.get(Number(m[1]));
      if (!agenda) return json(404, FEHLER_404);
      if (body?.title === 'SCHEITERT') {
        return json(400, { message: 'Validation failed', translatedMessage: 'Eingaben ungültig', errors: [{ fieldId: 'title', message: 'invalid', translatedMessage: 'Titel ungültig' }] });
      }
      const geordnet = [...agenda.items].sort((a, b) => a.position - b.position);
      let stelle = geordnet.length;
      if (q('after_id')) stelle = geordnet.findIndex((e) => e.id === Number(q('after_id'))) + 1;
      if (q('before_id')) stelle = geordnet.findIndex((e) => e.id === Number(q('before_id')));
      const neu = alsEintrag(z, body, 0);
      geordnet.splice(stelle, 0, neu);
      geordnet.forEach((e, i) => { e.position = i; });
      agenda.items = geordnet;
      return json(201, { data: neu });
    }
    if ((m = /^\/api\/events\/(\d+)\/agenda\/items\/(\d+)\/servicegroups\/(\d+)$/.exec(p)) && req.method === 'PUT') {
      return m[3] === '99' ? json(403, { message: 'Forbidden', translatedMessage: 'Keine Berechtigung für diese Dienstgruppe.', errors: [] }) : leer();
    }
    if ((m = /^\/api\/events\/(\d+)\/agenda\/items\/(\d+)$/.exec(p))) {
      const agenda = z.agendas.get(Number(m[1]));
      const eintrag = agenda?.items.find((e) => e.id === Number(m[2]));
      if (!eintrag) return json(404, FEHLER_404);
      if (req.method === 'DELETE') { agenda.items = agenda.items.filter((e) => e !== eintrag); return leer(); }
      if (req.method === 'PUT') {
        const neu = { ...alsEintrag(z, body, eintrag.position), id: eintrag.id };
        agenda.items = agenda.items.map((e) => (e === eintrag ? neu : e));
        return json(200, { data: neu });
      }
    }

    if (req.method === 'GET' && p === '/api/agendatemplates') return json(200, { data: [VORLAGE] });
    if (req.method === 'GET' && p === '/api/agendatemplates/40') return json(200, { data: VORLAGE });
    if (req.method === 'GET' && p === '/api/songs') {
      return json(200, {
        data: [{
          id: 55, name: 'Großer Gott, wir loben dich', author: 'Ignaz Franz', ccli: '123', category: { id: 1, name: 'Lieder' },
          arrangements: [{ id: 77, name: 'Standard', key: 'F', tempo: 90, duration: 240, isDefault: true }, { id: 78, name: 'Band', key: 'G', isDefault: false }],
        }],
        meta: { count: 1, pagination: { current: 1, lastPage: 3, total: 25, limit: 20 } },
      });
    }
    if (req.method === 'GET' && p === '/api/services') {
      return json(200, { data: [{ id: 2, name: 'Technik', serviceGroupId: 11, sortKey: 1 }, { id: 1, name: 'Moderation', nameTranslated: 'Moderation', serviceGroupId: 10, sortKey: 1 }] });
    }
    if (req.method === 'GET' && p === '/api/servicegroups') return json(200, { data: [{ id: 11, name: 'Technik', sortKey: 2 }, { id: 10, name: 'Leitung', sortKey: 1 }] });
    if (req.method === 'GET' && p === '/api/events/12/services/2/possiblepersons') {
      return json(200, {
        data: [{
          person: { domainIdentifier: '9', title: 'Carl Technik' },
          absences: [{ startDate: '2026-10-03', endDate: '2026-10-05', comment: 'Urlaub' }],
          lastService: { event: { domainAttributes: { startDate: '2026-09-20T08:00:00Z' } } }, nextService: null,
        }],
      });
    }
    if ((m = /^\/api\/events\/(\d+)\/servicerequests\/(\d+)$/.exec(p)) && req.method === 'PUT') {
      return json(200, { data: { id: 950, serviceId: 2, serviceName: 'Technik', personId: body.personId, person: body.personId ? { title: 'Carl Technik' } : null, name: body.name, isAccepted: false, isValid: true } });
    }
    if (req.method === 'GET' && p === '/api/persons') {
      return json(200, { data: [{ id: 7, firstName: 'Anna', lastName: 'Beispiel', email: 'anna@example.org', mobile: '0170 1234567', birthday: '1990-01-01' }], meta: { pagination: { current: 1, lastPage: 1, total: 1 } } });
    }
    if (req.method === 'GET' && p === '/api/persons/7') {
      return json(200, { data: { id: 7, firstName: 'Anna', lastName: 'Beispiel', email: 'anna@example.org', imageUrl: 'https://bild.example/a.jpg', guid: 'abc', meta: { createdDate: 'x' }, street: '', cmsUserId: 'anna' } });
    }
    if (req.method === 'GET' && p === '/api/groups') {
      return json(200, { data: [{ id: 20, name: 'Technikteam', information: { groupTypeId: 1, groupStatusId: 1, meetingTime: 'Mi 19 Uhr', note: 'Treffen im Keller' } }], meta: { pagination: { current: 1, lastPage: 1 } } });
    }
    if (req.method === 'GET' && p === '/api/groups/20/members') {
      return json(200, { data: [{ personId: 7, person: { title: 'Anna Beispiel', domainIdentifier: '7' }, groupTypeRoleId: 5, groupMemberStatus: 'active' }], meta: { pagination: { current: 1, lastPage: 1 } } });
    }
    if (req.method === 'GET' && p === '/api/group/roles') { z.rollenAbrufe += 1; return json(200, { data: [{ id: 5, name: 'Leiter', nameTranslated: 'Leitung' }] }); }
    if (req.method === 'GET' && p === '/api/calendars') {
      return json(200, { data: [{ id: 3, name: 'Gruppen', type: 'group', sortKey: 2 }, { id: 2, name: 'Gottesdienste', nameTranslated: 'Gottesdienste', type: 'church', sortKey: 1 }] });
    }
    if (req.method === 'GET' && p === '/api/calendars/appointments') {
      return json(200, {
        data: [
          {
            appointment: {
              base: {
                id: 500, title: 'Gottesdienst', startDate: '2026-09-06T08:00:00Z', endDate: '2026-09-06T09:30:00Z', allDay: false, repeatId: 7, isInternal: false,
                calendar: { id: 2, name: 'Gottesdienste', nameTranslated: 'Gottesdienste' },
                address: { meetingAt: 'Gemeindehaus', street: 'Hauptstr. 1', zip: '32657', city: 'Lemgo' },
              },
              calculated: { startDate: '2026-10-04T08:00:00Z', endDate: '2026-10-04T09:30:00Z' },
            },
            event: { domainType: 'event', domainIdentifier: '12', title: 'Gottesdienst' },
          },
          {
            // Ganztägig über zwei Tage; das Vorkommen beginnt um Mitternacht Ortszeit, in Zulu-Zeit also am Vortag
            appointment: {
              base: { id: 501, title: 'Gemeindefest', startDate: '2026-10-03', endDate: '2026-10-04', allDay: true, repeatId: 0, calendar: { id: 3, name: 'Gruppen' } },
              calculated: { startDate: '2026-10-02T22:00:00Z', endDate: '2026-10-04T21:59:59Z' },
            },
          },
        ],
      });
    }
    if ((m = /^\/api\/calendars\/(\d+)\/appointments$/.exec(p)) && req.method === 'POST') {
      return json(201, { data: { id: 600, title: body.title, startDate: body.startDate, endDate: body.endDate, allDay: /^\d{4}-\d{2}-\d{2}$/.test(body.startDate), calendar: { id: Number(m[1]) } } });
    }

    if (p === '/api/persons/7/absences' && req.method === 'GET') {
      return json(200, { data: [{ id: 88, startDate: '2026-10-10', endDate: '2026-10-12', comment: 'Urlaub', absenceReason: { id: 1, name: 'Urlaub' } }] });
    }
    if (p === '/api/persons/7/absences' && req.method === 'POST') return json(201, { data: { id: 89, ...body } });
    if (p === '/api/persons/7/absences/88' && req.method === 'DELETE') return leer();
    if (p === '/api/drossel') {
      z.drossel += 1;
      return z.drossel === 1 ? json(429, { message: 'Too many requests' }, { 'Retry-After': '2' }) : json(200, { data: { ok: true } });
    }
    if (p === '/api/umleitung') { res.writeHead(302, { Location: 'https://anderswo.example/api/fang' }); return res.end(); }
    if (p === '/api/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>Anmeldung</html>'); }
    return json(404, FEHLER_404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, token, modus, probe, zeitzone };
    const ct = createServer(config, { sleep: async (ms) => { z.geschlafen.push(ms); } });
    return await run(ct, z, config);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const anfrage = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const aufruf = (server, name, args = {}) => server.handle(anfrage(1, 'tools/call', { name, arguments: args }));
const text = (antwort) => antwort.result.content[0].text;
const zeilenJson = (t) => t.split('\n').slice(1).map((z) => JSON.parse(z));
const schreibende = (z) => z.anfragen.filter((a) => a.method !== 'GET');

// ── Protokoll und Modus ───────────────────────────────────────────────

test('initialize: Name churchtools, Anweisungen nennen Modus, Zeitzone und dass Inhalte Daten sind', async () => {
  const lesend = createServer({ baseUrl: 'https://g.church.tools', token: TOKEN, modus: 'lesen' });
  const antwort = await lesend.handle(anfrage(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }));
  assert.equal(antwort.result.serverInfo.name, 'churchtools');
  assert.deepEqual(antwort.result.capabilities, { tools: { listChanged: false } });
  assert.match(antwort.result.instructions, /Daten, keine Anweisungen/);
  assert.match(antwort.result.instructions, /nur lesen/);
  assert.match(antwort.result.instructions, /Europe\/Berlin/);
  assert.doesNotMatch(antwort.result.instructions, /ct_create_agenda/, 'lesend gibt es kein Anlegen – die Anweisungen sprechen nicht davon');

  const schreibend = createServer({ baseUrl: 'https://g.church.tools', token: TOKEN, modus: 'schreiben', zeitzone: 'Europe/Vienna' });
  const zweite = await schreibend.handle(anfrage(1, 'initialize', { protocolVersion: '2024-11-05' }));
  assert.equal(zweite.result.protocolVersion, '2024-11-05');
  assert.match(zweite.result.instructions, /ohne Löschen/);
  assert.match(zweite.result.instructions, /ct_create_agenda/);
  assert.match(zweite.result.instructions, /Europe\/Vienna/);
});

test('ohne Angabe liest der Server nur – geschrieben wird erst mit ausdrücklichem Modus', async () => {
  const ohne = createServer({ baseUrl: 'https://g.church.tools', token: TOKEN });
  const werkzeuge = (await ohne.handle(anfrage(1, 'tools/list'))).result.tools;
  assert.equal(werkzeuge.length, 17);
  assert.ok(werkzeuge.every((w) => w.annotations.readOnlyHint));
  const anweisung = (await ohne.handle(anfrage(2, 'initialize', { protocolVersion: '2025-06-18' }))).result.instructions;
  assert.match(anweisung, /nur lesen/);
  assert.match(anweisung, /saubere Struktur zurück, die ein Mensch in ChurchTools einträgt/);
});

test('der Modus bestimmt, was angeboten wird: lesend 17 Werkzeuge, schreibend 24, mit Löschen 26', async () => {
  const liste = async (modus) => (await createServer({ baseUrl: 'https://g.church.tools', token: TOKEN, modus }).handle(anfrage(1, 'tools/list'))).result.tools;
  const lesen = await liste('lesen');
  const schreiben = await liste('schreiben');
  const loeschen = await liste('loeschen');
  assert.equal(lesen.length, 17);
  assert.equal(schreiben.length, 24);
  assert.equal(loeschen.length, 26);
  assert.ok(lesen.every((w) => w.annotations.readOnlyHint), 'lesend nur Werkzeuge, die nichts ändern');
  assert.ok(!lesen.some((w) => ['ct_create_agenda', 'ct_api_write', 'ct_assign_service'].includes(w.name)));
  assert.ok(schreiben.some((w) => w.name === 'ct_create_agenda') && schreiben.some((w) => w.name === 'ct_api_write'));
  assert.ok(!schreiben.some((w) => w.annotations.destructiveHint && w.name.startsWith('ct_delete')), 'schreibend kein Löschwerkzeug');
  assert.deepEqual(loeschen.filter((w) => w.name.startsWith('ct_delete')).map((w) => w.name).sort(), ['ct_delete_agenda', 'ct_delete_agenda_item']);
  for (const w of loeschen) {
    assert.ok(w.name.startsWith('ct_') && w.description.length > 20 && w.inputSchema.type === 'object', w.name);
    assert.equal(w.run, undefined, 'tools/list gibt nur Beschreibung und Schema heraus');
  }
});

test('ein Werkzeug, das der Modus nicht anbietet, gibt es auch beim Aufruf nicht', async () => {
  await mitChurchTools(async (ct, z) => {
    const antwort = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'Begrüßung' }] });
    assert.equal(antwort.error.code, -32602);
    assert.equal(z.anfragen.length, 0);
  }, { modus: 'lesen' });
});

test('Eingaben werden auch in Listen von Objekten geprüft – bevor etwas zu ChurchTools geht', async () => {
  await mitChurchTools(async (ct, z) => {
    const unbekannt = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'Begrüßung', dauer: 5 }] });
    assert.equal(unbekannt.result.isError, true);
    assert.match(text(unbekannt), /unbekanntes Feld items\[0\]\.dauer/);
    const art = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'x', type: 'lied' }] });
    assert.match(text(art), /items\[0\]\.type muss einer dieser Werte sein: text, song, header/);
    const notiz = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'x', service_group_notes: [{ note: 'ohne Gruppe' }] }] });
    assert.match(text(notiz), /items\[0\]\.service_group_notes\[0\]\.service_group_id fehlt/);
    assert.equal(z.anfragen.length, 0);
  });
});

// ── Regeln ────────────────────────────────────────────────────────────

test('pfadPruefen: nur Pfade auf dem eingerichteten ChurchTools, ohne Tricks', () => {
  assert.deepEqual(pfadPruefen('/events/12'), { pfad: '/events/12', segmente: ['events', '12'] });
  assert.equal(pfadPruefen('events/12/').pfad, '/events/12');
  assert.equal(pfadPruefen('/api/events/12').pfad, '/events/12', 'mit und ohne /api');
  for (const schlecht of ['', '/api', 'https://evil.example/api/x', '//evil.example/x', '/events/../login', '/events/./12', '/events//12',
    '/events/%2e%2e/login', '/events/12%2flogin', '/events/%252e', '/events?from=1', '/events#x', '/events/1 2', '/events\\12']) {
    assert.ok(pfadPruefen(schlecht).fehler, `„${schlecht}“ müsste abgelehnt werden`);
  }
});

test('verboten: Zugangsdaten und Finanzen nie, Einstellungen nur lesend, Löschen nur mit --allow-delete', () => {
  const seg = (p) => pfadPruefen(p).segmente;
  // In keinem Modus – auch nicht lesend, auch nicht versteckt in der Mitte
  for (const p of ['/login', '/LOGIN', '/persons/5/logintoken', '/persons/5/loginstring', '/persons/5/password', '/persons/5/settings/twofactor', '/oauthclients', '/simulate', '/persons/5/devices', '/finance/accounts', '/logs']) {
    assert.ok(verboten('GET', seg(p), 'loeschen'), p);
  }
  assert.equal(verboten('GET', seg('/permissions/global'), 'lesen'), null, 'Rechte lesen geht');
  assert.match(verboten('PUT', seg('/permissions/global'), 'loeschen'), /nur gelesen/);
  assert.match(verboten('POST', seg('/routines/3/runs/bulk/start'), 'loeschen'), /nur gelesen/);
  assert.match(verboten('POST', seg('/persons/5/privacypolicy'), 'loeschen'), /Zustimmung/);
  assert.match(verboten('POST', seg('/events/12/agenda/items'), 'lesen'), /nur lesend/);
  assert.equal(verboten('POST', seg('/events/12/agenda/items'), 'schreiben'), null);
  assert.match(verboten('DELETE', seg('/events/12/agenda'), 'schreiben'), /--allow-delete/);
  assert.match(verboten('POST', seg('/persons/5/merge/6'), 'schreiben'), /--allow-delete/, 'Zusammenführen löscht eine Person');
  assert.equal(verboten('DELETE', seg('/events/12/agenda'), 'loeschen'), null);
  // Den ganzen Plan ersetzt ChurchTools als Ganzes – dabei verschwanden bei der MBG Lemgo sechs Lieder
  assert.match(verboten('PUT', seg('/events/12/agenda'), 'loeschen'), /ct_create_agenda/);
  assert.equal(verboten('PUT', seg('/events/12/agenda/items/5'), 'schreiben'), null, 'ein einzelner Eintrag geht');
});

// ── Verbindung und Fehler ─────────────────────────────────────────────

test('ct_check_connection nennt Person, Fassung und Modus; der Token geht als Login-Header und steht in keiner Antwort', async () => {
  await mitChurchTools(async (ct, z) => {
    const antwort = await aufruf(ct, 'ct_check_connection');
    assert.equal(antwort.result.isError, undefined);
    assert.match(text(antwort), /ChurchTools 3\.137\.0 \(„Testgemeinde“\) als Anna Beispiel \(Person 7\)/);
    assert.match(text(antwort), /lesen und schreiben, ohne Löschen/);
    assert.ok(z.anfragen.every((a) => a.auth === `Login ${TOKEN}`));
    assert.deepEqual(z.anfragen[0].query, { only_allow_authenticated: ['true'] }, 'ohne Anmeldung liefert whoami sonst den anonymen Benutzer');
    assert.doesNotMatch(JSON.stringify(antwort), new RegExp(TOKEN));
  });
});

test('ein falscher Token: die Meldung von ChurchTools und der Hinweis, woran es liegt', async () => {
  await mitChurchTools(async (ct) => {
    const antwort = await aufruf(ct, 'ct_check_connection');
    assert.equal(antwort.result.isError, true);
    assert.match(text(antwort), /Die Session ist abgelaufen, bitte logge dich erneut ein\. \(HTTP 401\) – ChurchTools nimmt den Login-Token nicht an/);
    assert.doesNotMatch(text(antwort), /falscher-token/);
  }, { token: 'falscher-token' });
});

test('eine Absage wegen 429 wird nach Retry-After wiederholt; Umleitungen und HTML sind Fehler', async () => {
  await mitChurchTools(async (ct, z) => {
    const gedrosselt = await aufruf(ct, 'ct_api_get', { path: '/drossel' });
    assert.equal(gedrosselt.result.isError, undefined, text(gedrosselt));
    assert.deepEqual(z.geschlafen, [2000]);
    assert.equal(z.drossel, 2);

    const umgeleitet = await aufruf(ct, 'ct_api_get', { path: '/umleitung' });
    assert.equal(umgeleitet.result.isError, true);
    assert.match(text(umgeleitet), /leitet um \(HTTP 302\) – der Umleitung wird nicht gefolgt/);
    assert.equal(z.anfragen.filter((a) => a.path === '/api/umleitung').length, 1);

    const html = await aufruf(ct, 'ct_api_get', { path: '/html' });
    assert.match(text(html), /kein JSON – zeigt die Adresse wirklich auf ein ChurchTools/);
  });
});

// ── Termine ───────────────────────────────────────────────────────────

test('ct_list_events: Zeitraum mit ausdrücklichem Ende, nach Beginn sortiert, Beginn auch in Ortszeit', async () => {
  await mitChurchTools(async (ct, z) => {
    const antwort = await aufruf(ct, 'ct_list_events', { from: '2026-10-01' });
    assert.deepEqual(z.anfragen[0].query, { from: ['2026-10-01'], to: ['2026-12-02'] }, '62 Tage – sonst rechnet ChurchTools zwei Monate ab heute');
    const termine = zeilenJson(text(antwort));
    assert.deepEqual(termine.map((t) => t.id), [12, 14, 13]);
    assert.equal(termine[0].start_local, 'So., 04.10.2026, 10:00');
    assert.equal(termine[0].calendar, 'Gottesdienste');

    await aufruf(ct, 'ct_list_events', {});
    const ohne = z.anfragen[1].query;
    assert.match(ohne.from[0], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(Date.parse(ohne.to[0]) - Date.parse(ohne.from[0]), 62 * 24 * 60 * 60 * 1000);

    const falsch = await aufruf(ct, 'ct_list_events', { from: '4.10.2026' });
    assert.match(text(falsch), /from als JJJJ-MM-TT/);
  });
});

test('ct_get_event: Dienste mit Namen, offene Dienste als offen, abgelöste Einträge fehlen', async () => {
  await mitChurchTools(async (ct) => {
    const termin = JSON.parse(text(await aufruf(ct, 'ct_get_event', { event_id: 12 })));
    assert.equal(termin.start_local, 'So., 04.10.2026, 10:00');
    assert.deepEqual(termin.calendar, { id: 2, title: 'Gottesdienste' });
    assert.deepEqual(termin.services, [
      { request_id: 901, service_id: 1, service: 'Moderation', person_id: 7, person: 'Anna Beispiel', accepted: true },
      { request_id: 902, service_id: 2, service: 'Technik', open: true },
    ]);
  });
});

// ── Ablaufplan ────────────────────────────────────────────────────────

test('ct_get_agenda: nach Position, Dauer in Minuten, Anfang in Ortszeit, Lied mit Arrangement', async () => {
  await mitChurchTools(async (ct) => {
    const t = text(await aufruf(ct, 'ct_get_agenda', { event_id: 12 }));
    const [kopf, ...eintraege] = t.split('\n').map((z) => JSON.parse(z));
    assert.deepEqual(kopf, { agenda_id: 300, locked: false, entries: 3 });
    assert.deepEqual(eintraege.map((e) => e.id), [1001, 1002, 1003]);
    assert.deepEqual(eintraege[1], {
      id: 1002, position: 1, type: 'song', title: 'Großer Gott', duration_minutes: 4, start_local: '10:00', responsible: '[Lobpreis]',
      responsible_persons: ['[Lobpreis]: Ben Musik'], song: { song_id: 55, title: 'Großer Gott, wir loben dich', arrangement_id: 77, arrangement: 'Standard', key: 'F' },
    });
    assert.deepEqual(eintraege[2].service_group_notes, [{ service_group_id: 11, note: 'Mikro 2' }]);
    assert.equal(eintraege[2].duration_minutes, 30);

    const ohne = await aufruf(ct, 'ct_get_agenda', { event_id: 13 });
    assert.equal(ohne.result.isError, undefined);
    assert.match(text(ohne), /hat keinen Ablaufplan/);
  });
});

test('ct_create_agenda aus Einträgen: Kalender des Termins, Dauern in Sekunden, Lied über sein Arrangement', async () => {
  await mitChurchTools(async (ct, z) => {
    const antwort = await aufruf(ct, 'ct_create_agenda', {
      event_id: 13,
      event_start_position: 1,
      items: [
        { title: 'Soundcheck', duration_minutes: 20, responsible: '[Technik]', note: 'Funkstrecken' },
        { type: 'header', title: 'Gottesdienst' },
        { type: 'song', arrangement_id: 77, duration_minutes: 4.5, service_group_notes: [{ service_group_id: 11, note: 'Text auf Folie' }] },
        { title: 'Predigt', duration_minutes: 30, responsible: 'Pastor Müller' },
      ],
    });
    assert.equal(antwort.result.isError, undefined, text(antwort));
    const put = z.anfragen.find((a) => a.method === 'PUT');
    assert.equal(put.path, '/api/events/13/agenda');
    assert.deepEqual(put.query, {});
    assert.deepEqual(put.body, {
      calendarId: 2,
      eventStartPosition: 1,
      items: [
        { type: 'text', title: 'Soundcheck', duration: 1200, note: 'Funkstrecken', responsible: '[Technik]' },
        { type: 'header', title: 'Gottesdienst' },
        { type: 'song', arrangementId: 77, duration: 270, serviceGroupNotes: [{ serviceGroupId: 11, note: 'Text auf Folie' }] },
        { type: 'text', title: 'Predigt', duration: 1800, responsible: 'Pastor Müller' },
      ],
    });
    assert.match(text(antwort), /Ablaufplan für „Jugendgottesdienst“ \(So\., 11\.10\.2026, 18:00\) angelegt\./);
    assert.equal(zeilenJson(text(antwort).split('\n').slice(1).join('\n')).length, 4);
  });
});

test('ct_create_agenda legt nie über einen vorhandenen Plan – und prüft vorher, was geht', async () => {
  await mitChurchTools(async (ct, z) => {
    const vorhanden = await aufruf(ct, 'ct_create_agenda', { event_id: 12, items: [{ title: 'Neu' }] });
    assert.equal(vorhanden.result.isError, true);
    assert.match(text(vorhanden), /hat schon einen Ablaufplan mit 3 Einträgen – nichts geändert.*ct_add_agenda_items/);

    const zweiQuellen = await aufruf(ct, 'ct_create_agenda', { event_id: 13, template_id: 40, items: [{ title: 'x' }] });
    assert.match(text(zweiQuellen), /Nur eine Quelle/);
    const ueberschrift = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'A' }, { type: 'header', title: 'B', duration_minutes: 5 }] });
    assert.match(text(ueberschrift), /Eintrag 2: eine Überschrift hat nur title \(nicht duration_minutes\)/);
    const ohneTitel = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: '  ' }] });
    assert.match(text(ohneTitel), /Eintrag 1: title fehlt/);
    const lied = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ type: 'song' }] });
    assert.match(text(lied), /ein Lied braucht arrangement_id/);
    const arrangementAmText = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'Gebet', arrangement_id: 77 }] });
    assert.match(text(arrangementAmText), /arrangement_id gibt es nur bei type "song"/);
    const ohneKalender = await aufruf(ct, 'ct_create_agenda', { event_id: 14, items: [{ title: 'Bibeltext' }] });
    assert.match(text(ohneKalender), /Kalender des Termins ist nicht erkennbar/);
    assert.equal(schreibende(z).length, 0, 'nichts davon hat etwas geschrieben');
  });
});

test('ct_create_agenda aus einer Vorlage oder als Kopie eines anderen Termins', async () => {
  await mitChurchTools(async (ct, z) => {
    const vorlage = await aufruf(ct, 'ct_create_agenda', { event_id: 13, template_id: 40 });
    assert.match(text(vorlage), /angelegt aus Vorlage 40/);
    assert.deepEqual(schreibende(z)[0].query, { template_id: ['40'] });
    assert.deepEqual(schreibende(z)[0].body, { calendarId: 2 }, 'ohne items – die kommen aus der Vorlage');
    assert.match(text(vorlage), /"title":"Begrüßung"/);

    z.agendas.delete(13);
    const kopie = await aufruf(ct, 'ct_create_agenda', { event_id: 13, copy_from_event_id: 12 });
    assert.match(text(kopie), /als Kopie von Termin 12/);
    assert.deepEqual(schreibende(z)[1].query, { event_id: ['12'] });
  });
});

test('ct_add_agenda_items: in Reihenfolge ans Ende, hinter oder vor einen Eintrag', async () => {
  await mitChurchTools(async (ct, z) => {
    const ans = await aufruf(ct, 'ct_add_agenda_items', { event_id: 12, items: [{ title: 'Segen', duration_minutes: 2 }, { title: 'Ausgang' }] });
    assert.equal(ans.result.isError, undefined, text(ans));
    const posts = z.anfragen.filter((a) => a.method === 'POST');
    assert.deepEqual(posts.map((a) => a.query), [{ after_id: ['1003'] }, { after_id: [String(posts[0].body && 5000)] }]);
    assert.deepEqual(posts[0].body, { type: 'text', title: 'Segen', duration: 120 });
    assert.deepEqual(z.agendas.get(12).items.map((e) => e.title), ['Ankommen', 'Großer Gott', 'Predigt', 'Segen', 'Ausgang']);

    await aufruf(ct, 'ct_add_agenda_items', { event_id: 12, before_item_id: 1003, items: [{ title: 'Lesung' }, { title: 'Stille' }] });
    assert.deepEqual(z.agendas.get(12).items.map((e) => e.title), ['Ankommen', 'Großer Gott', 'Lesung', 'Stille', 'Predigt', 'Segen', 'Ausgang']);

    const fremd = await aufruf(ct, 'ct_add_agenda_items', { event_id: 12, after_item_id: 4711, items: [{ title: 'x' }] });
    assert.match(text(fremd), /Eintrag 4711 gibt es in diesem Ablaufplan nicht/);
    const ohnePlan = await aufruf(ct, 'ct_add_agenda_items', { event_id: 13, items: [{ title: 'x' }] });
    assert.match(text(ohnePlan), /hat noch keinen Ablaufplan – zuerst ct_create_agenda/);
  });
});

test('ct_add_agenda_items bricht beim ersten Fehler ab und sagt, wie weit es kam – mit der Meldung von ChurchTools', async () => {
  await mitChurchTools(async (ct, z) => {
    const antwort = await aufruf(ct, 'ct_add_agenda_items', { event_id: 12, items: [{ title: 'Segen' }, { title: 'SCHEITERT' }, { title: 'Ausgang' }] });
    assert.equal(antwort.result.isError, true);
    assert.match(text(antwort), /^1 von 3 Einträgen angelegt; gescheitert bei Eintrag 2 \(„SCHEITERT“\)\. Fehler: Eingaben ungültig \(title: Titel ungültig\) \(HTTP 400\)/);
    assert.equal(z.anfragen.filter((a) => a.method === 'POST').length, 2, 'der dritte geht gar nicht erst los');
  });
});

test('ct_update_agenda_item behält, was nicht genannt wird, verschiebt und setzt Notizen für Dienstgruppen', async () => {
  await mitChurchTools(async (ct, z) => {
    const antwort = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1003, title: 'Predigt: Erntedank', move_after_item_id: 1001 });
    assert.equal(antwort.result.isError, undefined, text(antwort));
    const put = schreibende(z)[0];
    assert.equal(put.path, '/api/events/12/agenda/items/1003');
    assert.deepEqual(put.query, { after_id: ['1001'] });
    assert.deepEqual(put.body, { type: 'text', title: 'Predigt: Erntedank', duration: 1800, note: 'Folien bei Punkt 2', responsible: '[Predigt]' });
    assert.match(text(antwort), /geändert \(title, Position\)/);

    const lied = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1002, arrangement_id: 78 });
    assert.equal(schreibende(z)[1].body.arrangementId, 78);
    assert.match(text(lied), /geändert \(arrangement_id\)/);

    const notiz = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1003, service_group_notes: [{ service_group_id: 11, note: 'Mikro 3' }] });
    assert.equal(notiz.result.isError, undefined, text(notiz));
    assert.equal(schreibende(z).length, 3, 'nur die Notiz – der Eintrag selbst bleibt unberührt');
    assert.deepEqual(schreibende(z)[2], { method: 'PUT', path: '/api/events/12/agenda/items/1003/servicegroups/11', query: {}, body: { note: 'Mikro 3' }, auth: `Login ${TOKEN}` });

    const verboten_ = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1003, service_group_notes: [{ service_group_id: 99, note: 'x' }] });
    assert.match(text(verboten_), /0 von 1 Notizen gesetzt, gescheitert bei Dienstgruppe 99\. Fehler: Keine Berechtigung für diese Dienstgruppe\. \(HTTP 403\)/);

    const ueberschrift = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1001, duration_minutes: 3 });
    assert.match(text(ueberschrift), /Eine Überschrift hat nur einen Titel/);
    const arrangement = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1003, arrangement_id: 77 });
    assert.match(text(arrangement), /arrangement_id gibt es nur bei einem Lied/);
    const nichts = await aufruf(ct, 'ct_update_agenda_item', { event_id: 12, item_id: 1003 });
    assert.match(text(nichts), /Nichts zu ändern/);
  });
});

test('Sperren, Vorlagen – und Löschen nur mit --allow-delete', async () => {
  await mitChurchTools(async (ct, z) => {
    assert.match(text(await aufruf(ct, 'ct_set_agenda_lock', { event_id: 12, locked: true })), /gesperrt/);
    assert.equal(schreibende(z)[0].path, '/api/events/12/agenda/lock');
    const vorlagen = text(await aufruf(ct, 'ct_list_agenda_templates'));
    assert.match(vorlagen, /\{"id":40,"name":"Sonntag","series":"Gottesdienst","calendar_id":2,"entries":2\}/);
    assert.match(text(await aufruf(ct, 'ct_list_agenda_templates', { template_id: 40 })), /"responsible":"\[Moderation\]"/);
    assert.equal((await aufruf(ct, 'ct_delete_agenda', { event_id: 12 })).error.code, -32602, 'schreibend gibt es das Werkzeug nicht');
  });
  await mitChurchTools(async (ct, z) => {
    assert.match(text(await aufruf(ct, 'ct_delete_agenda_item', { event_id: 12, item_id: 1002 })), /gelöscht/);
    assert.equal(z.agendas.get(12).items.length, 2);
    assert.match(text(await aufruf(ct, 'ct_delete_agenda', { event_id: 12 })), /Ablaufplan von Termin 12 gelöscht/);
    assert.equal(z.agendas.has(12), false);
  }, { modus: 'loeschen' });
});

// ── Lieder, Dienste, Personen, Gruppen ────────────────────────────────

test('ct_search_songs: mit Arrangements und dem Hinweis auf weitere Seiten', async () => {
  await mitChurchTools(async (ct, z) => {
    const t = text(await aufruf(ct, 'ct_search_songs', { query: 'Großer Gott' }));
    assert.deepEqual(z.anfragen[0].query, { query: ['Großer Gott'], include: ['arrangements'], limit: ['20'] });
    assert.match(t, /Seite 1 von 3, 25 insgesamt – weiter mit page/);
    assert.deepEqual(JSON.parse(t.split('\n')[1]).arrangements, [
      { id: 77, name: 'Standard', key: 'F', tempo: 90, duration_minutes: 4, default: true },
      { id: 78, name: 'Band', key: 'G' },
    ]);
  });
});

test('ct_list_services nach Gruppen geordnet; ct_find_service_candidates mit Abwesenheiten', async () => {
  await mitChurchTools(async (ct) => {
    assert.deepEqual(zeilenJson(text(await aufruf(ct, 'ct_list_services'))), [
      { id: 1, name: 'Moderation', group_id: 10, group: 'Leitung' },
      { id: 2, name: 'Technik', group_id: 11, group: 'Technik' },
    ]);
    assert.deepEqual(zeilenJson(text(await aufruf(ct, 'ct_find_service_candidates', { event_id: 12, service_id: 2 }))), [
      { person_id: 9, name: 'Carl Technik', absences: ['2026-10-03–2026-10-05 (Urlaub)'], last_service: '2026-09-20' },
    ]);
  });
});

test('ct_assign_service: genau eine Person oder ein Name', async () => {
  await mitChurchTools(async (ct, z) => {
    const person = await aufruf(ct, 'ct_assign_service', { event_id: 12, request_id: 902, person_id: 9 });
    assert.match(text(person), /^Eingeteilt: Carl Technik für Technik an Termin 12\./);
    assert.deepEqual(schreibende(z)[0].body, { personId: 9, name: null });
    await aufruf(ct, 'ct_assign_service', { event_id: 12, request_id: 902, name: ' Gast von außerhalb ' });
    assert.deepEqual(schreibende(z)[1].body, { name: 'Gast von außerhalb', personId: null });
    assert.match(text(await aufruf(ct, 'ct_assign_service', { event_id: 12, request_id: 902 })), /Genau eines angeben/);
    assert.match(text(await aufruf(ct, 'ct_assign_service', { event_id: 12, request_id: 902, person_id: 9, name: 'x' })), /Genau eines angeben/);
    assert.equal(schreibende(z).length, 2);
  });
});

test('Personen: die Suche liefert nur Namen; Einzelheiten ohne Bild, Kennungen und Leeres', async () => {
  await mitChurchTools(async (ct) => {
    const suche = text(await aufruf(ct, 'ct_search_persons', { query: 'Anna' }));
    assert.deepEqual(zeilenJson(suche), [{ id: 7, first_name: 'Anna', last_name: 'Beispiel' }]);
    assert.doesNotMatch(suche, /anna@example\.org|0170|1990/, 'keine Kontaktdaten in der Suche');
    assert.deepEqual(JSON.parse(text(await aufruf(ct, 'ct_get_person', { person_id: 7 }))), { id: 7, firstName: 'Anna', lastName: 'Beispiel', email: 'anna@example.org' });
  });
});

test('Gruppen und Mitglieder – die Rollen werden je Server einmal geholt', async () => {
  await mitChurchTools(async (ct, z) => {
    assert.deepEqual(zeilenJson(text(await aufruf(ct, 'ct_list_groups', { query: 'Technik' }))), [
      { id: 20, name: 'Technikteam', group_type_id: 1, group_status_id: 1, meeting_time: 'Mi 19 Uhr', note: 'Treffen im Keller' },
    ]);
    const mitglieder = zeilenJson(text(await aufruf(ct, 'ct_list_group_members', { group_id: 20 })));
    assert.deepEqual(mitglieder, [{ person_id: 7, name: 'Anna Beispiel', role: 'Leitung', status: 'active' }]);
    await aufruf(ct, 'ct_list_group_members', { group_id: 20 });
    assert.equal(z.rollenAbrufe, 1);
  });
});

// ── Kalender ──────────────────────────────────────────────────────────

test('ct_list_appointments: alle sichtbaren Kalender, Ortszeit, ganztägig am richtigen Tag, event_id zum Termin', async () => {
  await mitChurchTools(async (ct, z) => {
    const t = text(await aufruf(ct, 'ct_list_appointments', { from: '2026-10-01' }));
    const abruf = z.anfragen.find((a) => a.path === '/api/calendars/appointments');
    assert.deepEqual(abruf.query, { 'calendar_ids[]': ['3', '2'], from: ['2026-10-01'], to: ['2026-11-01'], 'include[]': ['event'] });
    const [fest, gottesdienst] = zeilenJson(t);
    assert.deepEqual(fest, {
      id: 501, title: 'Gemeindefest', start: '2026-10-02T22:00:00Z', start_local: 'Sa., 03.10.2026', end_local: 'So., 04.10.2026', all_day: true,
      calendar: 'Gruppen', calendar_id: 3,
    });
    assert.equal(gottesdienst.start_local, 'So., 04.10.2026, 10:00', 'das Vorkommen der Serie, nicht ihr erster Termin');
    assert.equal(gottesdienst.place, 'Gemeindehaus, Hauptstr. 1, 32657 Lemgo');
    assert.equal(gottesdienst.event_id, 12);
    assert.equal(gottesdienst.repeats, true);

    await aufruf(ct, 'ct_list_appointments', { calendar_ids: [2], from: '2026-10-01', to: '2026-10-07' });
    assert.deepEqual(z.anfragen.at(-1).query['calendar_ids[]'], ['2']);
    assert.deepEqual(z.anfragen.at(-1).query.to, ['2026-10-07']);
  });
});

test('ct_create_appointment: Ortszeit wird Zulu-Zeit, ganztägig bleibt ein Datum, auf Wunsch mit Termin der Dienstplanung', async () => {
  await mitChurchTools(async (ct, z) => {
    const sommer = await aufruf(ct, 'ct_create_appointment', {
      calendar_id: 2, title: 'Erntedankgottesdienst', start: '2026-10-04T10:00', end: '2026-10-04T11:30',
      place: { name: 'Gemeindehaus', city: 'Lemgo' }, create_event: true, event_template_id: 3,
    });
    assert.equal(sommer.result.isError, undefined, text(sommer));
    assert.deepEqual(schreibende(z)[0].body, {
      calendarId: 2, title: 'Erntedankgottesdienst', startDate: '2026-10-04T08:00:00Z', endDate: '2026-10-04T09:30:00Z', isInternal: false,
      address: { meetingAt: 'Gemeindehaus', city: 'Lemgo' }, events: [{ startDate: '2026-10-04T08:00:00Z', eventTemplateId: 3 }],
    });
    assert.match(text(sommer), /angelegt \(id 600\), So\., 04\.10\.2026, 10:00 bis So\., 04\.10\.2026, 11:30\. Der Termin in der Dienstplanung ist mit angelegt/);

    await aufruf(ct, 'ct_create_appointment', { calendar_id: 2, title: 'Christvesper', start: '2026-12-24T17:00', end: '2026-12-24T18:00' });
    assert.equal(schreibende(z)[1].body.startDate, '2026-12-24T16:00:00Z', 'im Winter eine Stunde, im Sommer zwei');

    const ganztags = await aufruf(ct, 'ct_create_appointment', { calendar_id: 3, title: 'Freizeit', start: '2026-10-16', end: '2026-10-18' });
    assert.deepEqual([schreibende(z)[2].body.startDate, schreibende(z)[2].body.endDate], ['2026-10-16', '2026-10-18']);
    assert.match(text(ganztags), /Fr\., 16\.10\.2026 bis So\., 18\.10\.2026, ganztägig/);

    for (const [args, fehler] of [
      [{ start: '2026-10-04T10:00' }, /end fehlt/],
      [{ start: '2026-10-04T10:00', end: '2026-10-04T09:00' }, /end muss nach start liegen/],
      [{ start: 'Sonntag 10 Uhr', end: 'Sonntag 11 Uhr' }, /start und end als 2026-10-04T10:00/],
      [{ start: '2026-10-16', end: '2026-10-15' }, /end liegt vor start/],
      [{ start: '2026-10-16', create_event: true }, /create_event braucht einen Beginn mit Uhrzeit/],
      [{ start: '2026-10-04T10:00', end: '2026-10-04T11:00', event_template_id: 3 }, /nur zusammen mit create_event/],
    ]) {
      const antwort = await aufruf(ct, 'ct_create_appointment', { calendar_id: 2, title: 'x', ...args });
      assert.match(text(antwort), fehler);
    }
    assert.equal(schreibende(z).length, 3);
  });
});

test('zuZulu: Ortszeit mit Sommer- und Winterzeit, auch an den Tagen der Umstellung', () => {
  const b = 'Europe/Berlin';
  assert.equal(zuZulu('2026-10-04T10:00', b), '2026-10-04T08:00:00Z');
  assert.equal(zuZulu('2026-12-24 18:00', b), '2026-12-24T17:00:00Z');
  assert.equal(zuZulu('2026-10-04T10:00:00+02:00', b), '2026-10-04T08:00:00Z');
  assert.equal(zuZulu('2026-10-04T08:00Z', b), '2026-10-04T08:00:00Z');
  assert.equal(zuZulu('2026-03-29T01:30', b), '2026-03-29T00:30:00Z', 'vor der Umstellung im März');
  assert.equal(zuZulu('2026-03-29T03:30', b), '2026-03-29T01:30:00Z', 'nach der Umstellung im März');
  assert.equal(zuZulu('2026-10-25T01:30', b), '2026-10-24T23:30:00Z', 'vor der Umstellung im Oktober');
  assert.equal(zuZulu('2026-10-25T03:30', b), '2026-10-25T02:30:00Z', 'nach der Umstellung im Oktober');
  assert.equal(zuZulu('2026-07-01T12:00', 'America/New_York'), '2026-07-01T16:00:00Z');
  assert.equal(zuZulu('morgen um 10', b), null);
  assert.equal(zuZulu('2026-13-45T10:00+02:00', b), null);
});

// ── Alles Übrige: die API selbst ──────────────────────────────────────

test('ct_api_search: die Beschreibung wird einmal geholt; Gesperrtes taucht nicht auf, lesend nur GET', async () => {
  await mitChurchTools(async (ct, z) => {
    const t = text(await aufruf(ct, 'ct_api_search', { query: 'absence' }));
    assert.match(t, /GET \/persons\/\{personId\}\/absences — Get absences of a person/);
    assert.match(t, /POST \/persons\/\{personId\}\/absences — Create absence/);
    assert.doesNotMatch(t, /DELETE/, 'schreibend ohne Löschen – DELETE bietet die Suche nicht an');
    assert.doesNotMatch(t, /\/login|\/finance/, 'gesperrte Wege findet die Suche nicht, auch wenn das Wort passt');
    await aufruf(ct, 'ct_api_search', { query: 'wiki' });
    assert.equal(z.openapiAbrufe, 1);
    assert.match(text(await aufruf(ct, 'ct_api_search', { query: 'gottesdienst' })), /Nichts gefunden.*englisch/);
  });
  await mitChurchTools(async (ct) => {
    const t = text(await aufruf(ct, 'ct_api_search', { query: 'absence' }));
    assert.match(t, /GET \/persons\/\{personId\}\/absences/);
    assert.doesNotMatch(t, /POST|DELETE/);
  }, { modus: 'lesen' });
});

test('ct_api_describe: Parameter, Körper mit Pflichtfeldern, Antworten – auch bei einem Schema, das sich selbst enthält', async () => {
  await mitChurchTools(async (ct) => {
    const lesen = text(await aufruf(ct, 'ct_api_describe', { method: 'GET', path: '/persons/7/absences' }));
    assert.match(lesen, /^GET \/persons\/\{personId\}\/absences — Get absences of a person/);
    assert.match(lesen, /Pfad personId\*: integer/);
    assert.match(lesen, /query from_date: string format=date {2}\/\/ Start of the range/);
    assert.match(lesen, /200: OK/);
    assert.match(lesen, /person: \{…\}/, 'Antworten nur zwei Ebenen tief – sie sind in ChurchTools sehr groß');

    const schreiben = text(await aufruf(ct, 'ct_api_describe', { method: 'POST', path: '/api/persons/{personId}/absences' }));
    assert.match(schreiben, /Körper \(JSON, Pflicht\):/);
    assert.match(schreiben, /absenceReasonId\*: integer {2}\/\/ Reason of the absence/);

    assert.match(text(await aufruf(ct, 'ct_api_describe', { method: 'PATCH', path: '/persons/7/absences' })), /gibt es nicht\. Auf diesem Pfad gibt es: GET, POST/);
    assert.match(text(await aufruf(ct, 'ct_api_describe', { method: 'GET', path: '/gibtsnicht' })), /kennt dieses ChurchTools nicht/);
    assert.match(text(await aufruf(ct, 'ct_api_describe', { method: 'GET', path: '/persons/{personId}/logintoken' })), /Zugangsdaten/);
  });
});

test('schemaText: ein Schema, das sich selbst enthält, endet beim zweiten Mal – auch ohne Grenze der Tiefe', () => {
  const t = schemaText(OPENAPI, { $ref: '#/components/schemas/Absence' }, 50);
  assert.match(t, /absences: \[↺ Absence\]/);
  assert.equal((t.match(/startDate/g) ?? []).length, 1);
});

test('ct_api_get: Felder auswählen, Listen in der Abfrage; Gesperrtes geht gar nicht erst los', async () => {
  await mitChurchTools(async (ct, z) => {
    const t = text(await aufruf(ct, 'ct_api_get', { path: 'persons/7/absences', query: { 'ids[]': [1, 2], from_date: '2026-10-01' }, fields: ['id', 'comment'] }));
    assert.deepEqual(JSON.parse(t), [{ id: 88, comment: 'Urlaub' }]);
    assert.deepEqual(z.anfragen[0].query, { 'ids[]': ['1', '2'], from_date: ['2026-10-01'] });

    const vorher = z.anfragen.length;
    for (const [pfad, fehler] of [
      ['/persons/7/logintoken', /Zugangsdaten/],
      ['/finance/accounts', /Bereich „finance“/],
      ['https://evil.example/api/persons', /keine ganze Adresse/],
      ['/persons/7/..%2f..%2flogin', /verschlüsselten/],
      ['/persons?query=anna', /ohne \? und #/],
    ]) {
      const antwort = await aufruf(ct, 'ct_api_get', { path: pfad });
      assert.equal(antwort.result.isError, true, pfad);
      assert.match(text(antwort), fehler, pfad);
    }
    assert.equal(z.anfragen.length, vorher, 'keiner davon hat ChurchTools erreicht');
  });
});

test('ct_api_write: schreibend POST ja – Löschen, Rechte, Zusammenführen und Zustimmungen nein', async () => {
  await mitChurchTools(async (ct, z) => {
    const neu = await aufruf(ct, 'ct_api_write', { method: 'POST', path: '/persons/7/absences', body: { absenceReasonId: 1, startDate: '2026-11-02', endDate: '2026-11-06' } });
    assert.match(text(neu), /^POST \/persons\/7\/absences: erledigt \(HTTP 201\)\./);
    assert.deepEqual(schreibende(z)[0].body, { absenceReasonId: 1, startDate: '2026-11-02', endDate: '2026-11-06' });

    for (const [method, pfad, fehler] of [
      ['DELETE', '/persons/7/absences/88', /--allow-delete/],
      ['PUT', '/permissions/global', /nur gelesen/],
      ['POST', '/persons/7/merge/8', /--allow-delete/],
      ['POST', '/persons/7/privacypolicy', /Zustimmung/],
      ['POST', '/login', /Zugangsdaten/],
      ['PATCH', '/persons/7/password', /Zugangsdaten/],
      ['PUT', '/events/12/agenda', /ct_create_agenda/],
    ]) {
      const antwort = await aufruf(ct, 'ct_api_write', { method, path: pfad, body: {} });
      assert.equal(antwort.result.isError, true, `${method} ${pfad}`);
      assert.match(text(antwort), fehler, `${method} ${pfad}`);
    }
    assert.equal(schreibende(z).length, 1);
  });
  await mitChurchTools(async (ct, z) => {
    assert.match(text(await aufruf(ct, 'ct_api_write', { method: 'DELETE', path: '/persons/7/absences/88' })), /erledigt \(HTTP 204\)\.$/);
    assert.equal(schreibende(z)[0].method, 'DELETE');
  }, { modus: 'loeschen' });
});

test('der Login-Token steht in keiner Antwort – über alle Werkzeuge hinweg', async () => {
  await mitChurchTools(async (ct) => {
    const alle = [
      await aufruf(ct, 'ct_check_connection'),
      await aufruf(ct, 'ct_list_events', { from: '2026-10-01' }),
      await aufruf(ct, 'ct_get_event', { event_id: 12 }),
      await aufruf(ct, 'ct_get_agenda', { event_id: 12 }),
      await aufruf(ct, 'ct_api_get', { path: '/umleitung' }),
      await aufruf(ct, 'ct_api_get', { path: '/persons/7/logintoken' }),
      await aufruf(ct, 'ct_api_search', { query: 'token' }),
      await aufruf(ct, 'ct_create_appointment', { calendar_id: 2, title: 'x', start: '2026-10-04T10:00', end: '2026-10-04T11:00' }),
    ];
    assert.doesNotMatch(JSON.stringify(alle), new RegExp(TOKEN));
  }, { modus: 'loeschen' });
});

// ── Probemodus ────────────────────────────────────────────────────────

test('Probemodus: schreibende Werkzeuge prüfen und lesen wie sonst, schicken aber nichts', async () => {
  await mitChurchTools(async (ct, z) => {
    const liste = (await ct.handle(anfrage(1, 'tools/list'))).result.tools;
    assert.equal(liste.length, 24);
    assert.match(liste.find((w) => w.name === 'ct_create_agenda').description, /PROBEMODUS/);

    const plan = await aufruf(ct, 'ct_create_agenda', { event_id: 13, items: [{ title: 'Begrüßung', duration_minutes: 5 }, { type: 'song', arrangement_id: 77 }] });
    assert.equal(plan.result.isError, undefined, text(plan));
    assert.match(text(plan), /^PROBEMODUS – nichts an ChurchTools gesendet\. Dieser Aufruf hätte 1 Änderung\(en\) geschickt:/);
    assert.match(text(plan), /1\. PUT \/events\/13\/agenda\n {3}\{"calendarId":2,"items":\[\{"type":"text","title":"Begrüßung","duration":300\}/);

    const mehr = await aufruf(ct, 'ct_add_agenda_items', { event_id: 12, items: [{ title: 'Segen' }, { title: 'Ausgang' }] });
    assert.match(text(mehr), /hätte 2 Änderung\(en\)/);
    assert.match(text(mehr), /1\. POST \/events\/12\/agenda\/items\?after_id=1003/);

    // Was eine Prüfung ablehnt, bleibt ein Fehler – geplant wird da nichts
    const vorhanden = await aufruf(ct, 'ct_create_agenda', { event_id: 12, items: [{ title: 'x' }] });
    assert.equal(vorhanden.result.isError, true);
    assert.match(text(vorhanden), /hat schon einen Ablaufplan/);

    const termin = await aufruf(ct, 'ct_create_appointment', { calendar_id: 2, title: 'Probe', start: '2026-10-04T10:00', end: '2026-10-04T11:00' });
    assert.match(text(termin), /POST \/calendars\/2\/appointments/);

    assert.equal(schreibende(z).length, 0, 'nichts Schreibendes hat ChurchTools erreicht');
    assert.ok(z.anfragen.some((a) => a.path === '/api/events/13/agenda'), 'gelesen wurde wie sonst');
  }, { probe: true });
});

test('Probemodus ohne Schreibrecht: ein Probelauf bietet die Schreibwerkzeuge trotzdem an', async () => {
  const probe = createServer({ baseUrl: 'https://g.church.tools', token: TOKEN, probe: true });
  const init = await probe.handle(anfrage(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.match(init.result.instructions, /im Probemodus: nichts wird gesendet/);
  assert.equal((await probe.handle(anfrage(2, 'tools/list'))).result.tools.length, 24);
});

// ── Einrichtung und Kommandozeile ─────────────────────────────────────

test('Adresse und Einrichtung: https, ohne /api, Token, Zeitzone', () => {
  assert.equal(normalisiereAdresse('gemeinde.church.tools/api/'), 'https://gemeinde.church.tools');
  assert.equal(normalisiereAdresse(' https://gemeinde.de/churchtools/ '), 'https://gemeinde.de/churchtools');
  const gut = { baseUrl: 'https://gemeinde.church.tools', token: 't', modus: 'schreiben', zeitzone: 'Europe/Berlin' };
  assert.equal(einrichtungsfehler(gut), null);
  assert.match(einrichtungsfehler({ ...gut, baseUrl: '' }), /CHURCHTOOLS_URL/);
  assert.match(einrichtungsfehler({ ...gut, token: '' }), /CHURCHTOOLS_TOKEN/);
  assert.match(einrichtungsfehler({ ...gut, baseUrl: 'http://gemeinde.church.tools' }), /https/);
  assert.equal(einrichtungsfehler({ ...gut, baseUrl: 'http://localhost:8080' }), null, 'ein ChurchTools auf demselben Rechner darf http');
  assert.match(einrichtungsfehler({ ...gut, baseUrl: 'https://nutzer:pw@gemeinde.church.tools' }), /Benutzernamen/);
  assert.match(einrichtungsfehler({ ...gut, zeitzone: 'Mars/Olympus' }), /Zeitzone/);
  assert.match(einrichtungsfehler({ ...gut, modus: 'alles' }), /Modus/);
});

/** `psalmio churchtools-mcp` als eigener Prozess; `zeilen` gehen nacheinander auf stdin, dann wird stdin geschlossen. */
function ueberStdio(args, env, zeilen) {
  return new Promise((resolve) => {
    const kind = spawn(process.execPath, [CLI, 'churchtools-mcp', ...args], { env: { ...process.env, CHURCHTOOLS_URL: '', CHURCHTOOLS_TOKEN: '', CHURCHTOOLS_TIMEZONE: '', ...env } });
    let out = '';
    let err = '';
    kind.stdout.on('data', (d) => { out += d; });
    kind.stderr.on('data', (d) => { err += d; });
    kind.on('close', (code) => resolve({ code, out, err }));
    for (const zeile of zeilen) kind.stdin.write(`${zeile}\n`);
    kind.stdin.end();
  });
}

test('psalmio churchtools-mcp --read-only: nur JSON-RPC auf stdout, lesende Werkzeuge, der Token nirgends', async () => {
  await mitChurchTools(async (_ct, z, config) => {
    const { code, out, err } = await ueberStdio(['--read-only'], { CHURCHTOOLS_URL: config.baseUrl, CHURCHTOOLS_TOKEN: TOKEN }, [
      JSON.stringify(anfrage(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify(anfrage(2, 'tools/list')),
      JSON.stringify(anfrage(3, 'tools/call', { name: 'ct_check_connection', arguments: {} })),
    ]);
    assert.equal(code, 0, err);
    const antworten = out.trim().split('\n').map((zeile) => JSON.parse(zeile));
    assert.deepEqual(antworten.map((a) => a.id), [1, 2, 3]);
    assert.equal(antworten[1].result.tools.length, 17);
    assert.match(antworten[2].result.content[0].text, /als Anna Beispiel .* Dieser Server darf: nur lesen/);
    assert.match(err, /psalmio churchtools-mcp bereit – http:\/\/127\.0\.0\.1:\d+ \(nur lesen, Zeitzone Europe\/Berlin\)/);
    assert.doesNotMatch(out + err, new RegExp(TOKEN));
    assert.ok(z.anfragen.every((a) => a.auth === `Login ${TOKEN}`));
  });
});

test('psalmio churchtools-mcp: ohne Option nur lesen, --allow-write schreibt, --dry-run zeigt nur', async () => {
  await mitChurchTools(async (_ct, z, config) => {
    const env = { CHURCHTOOLS_URL: config.baseUrl, CHURCHTOOLS_TOKEN: TOKEN };
    const zeilen = [
      JSON.stringify(anfrage(1, 'tools/list')),
      JSON.stringify(anfrage(2, 'tools/call', { name: 'ct_check_connection', arguments: {} })),
    ];
    // Anfragen laufen nebeneinander – die Antworten kommen in keiner festen Reihenfolge
    const nachId = (out) => out.trim().split('\n').map((zeile) => JSON.parse(zeile)).sort((a, b) => a.id - b.id);
    const ohne = await ueberStdio([], env, zeilen);
    const [liste, verbindung] = nachId(ohne.out);
    assert.equal(liste.result.tools.length, 17);
    assert.match(verbindung.result.content[0].text, /Dieser Server darf: nur lesen/);

    const schreiben = await ueberStdio(['--allow-write'], env, zeilen);
    assert.equal(nachId(schreiben.out)[0].result.tools.length, 24);
    assert.match(schreiben.err, /lesen und schreiben, ohne Löschen, Zeitzone/);

    const probe = await ueberStdio(['--dry-run'], env, [
      ...zeilen,
      JSON.stringify(anfrage(3, 'tools/call', { name: 'ct_add_agenda_items', arguments: { event_id: 12, items: [{ title: 'Segen' }] } })),
    ]);
    const antworten = nachId(probe.out);
    assert.equal(antworten[0].result.tools.length, 24);
    assert.match(antworten[1].result.content[0].text, /im Probemodus: nichts wird gesendet/);
    assert.match(antworten[2].result.content[0].text, /^PROBEMODUS/);
    assert.match(probe.err, /im Probemodus: nichts wird gesendet/);
    assert.equal(schreibende(z).length, 0);
  });
});

test('psalmio churchtools-mcp endet mit 64, wenn die Einrichtung nicht stimmt – bevor irgendetwas läuft', async () => {
  const ohneToken = await ueberStdio([], { CHURCHTOOLS_URL: 'https://gemeinde.church.tools' }, [JSON.stringify(anfrage(1, 'ping'))]);
  assert.equal(ohneToken.code, 64);
  assert.equal(ohneToken.out, '');
  assert.match(ohneToken.err, /CHURCHTOOLS_TOKEN/);

  const httpAdresse = await ueberStdio([], { CHURCHTOOLS_URL: 'http://gemeinde.church.tools', CHURCHTOOLS_TOKEN: TOKEN }, []);
  assert.equal(httpAdresse.code, 64);
  assert.match(httpAdresse.err, /https/);

  const beides = await ueberStdio(['--read-only', '--allow-delete'], { CHURCHTOOLS_URL: 'https://gemeinde.church.tools', CHURCHTOOLS_TOKEN: TOKEN }, []);
  assert.equal(beides.code, 64);
  assert.match(beides.err, /--read-only schließt --allow-write, --allow-delete und --dry-run aus/);

  const zone = await ueberStdio(['--timezone', 'Mars/Olympus'], { CHURCHTOOLS_URL: 'https://gemeinde.church.tools', CHURCHTOOLS_TOKEN: TOKEN }, []);
  assert.equal(zone.code, 64);
  assert.match(zone.err, /Zeitzone/);

  const json = await ueberStdio(['--json'], { CHURCHTOOLS_URL: 'https://gemeinde.church.tools', CHURCHTOOLS_TOKEN: TOKEN }, []);
  assert.equal(json.code, 64);
  assert.match(json.err, /--json gilt nicht für „psalmio churchtools-mcp"/);
  assert.doesNotMatch(ohneToken.err + httpAdresse.err + beides.err + zone.err + json.err, new RegExp(TOKEN));
});
