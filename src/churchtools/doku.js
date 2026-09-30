/**
 * Die API-Beschreibung des ChurchTools selbst – damit ein Assistent auch das
 * findet, wofür es hier kein eigenes Werkzeug gibt.
 *
 * Jedes ChurchTools liefert seine Schnittstelle als OpenAPI-Dokument aus
 * (`/system/runtime/swagger/openapi.json`, dieselbe Quelle wie die Seite
 * `/api`). Es passt immer zur Fassung genau dieses ChurchTools – anders als
 * eine Liste, die hier mitgeliefert würde. Das Dokument ist groß (über 500
 * Wege, rund 30 MB); es wird erst geholt, wenn ein Assistent danach fragt, und
 * dann je Server einmal.
 */

const { erreichbar } = require('./regeln');

const BESCHREIBUNG_PFAD = '/system/runtime/swagger/openapi.json';
const METHODEN = ['get', 'post', 'put', 'patch', 'delete'];
const LADEN_TIMEOUT_MS = 90000;
const LADEN_HOECHSTENS_BYTES = 120 * 1024 * 1024;

/**
 * Die Beschreibung holen. Nichts wirft.
 *
 * @returns {Promise<{ok: true, spec: object} | {ok: false, error: string}>}
 */
async function ladeBeschreibung(config, deps = {}) {
  const doFetch = deps.fetch || fetch;
  try {
    const response = await doFetch(`${config.baseUrl}${BESCHREIBUNG_PFAD}`, {
      headers: { Authorization: `Login ${config.token}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.docsTimeoutMs || LADEN_TIMEOUT_MS),
    });
    if (response.status !== 200) return { ok: false, error: `Die API-Beschreibung ist nicht abrufbar (HTTP ${response.status}).` };
    const groesse = Number(response.headers.get('content-length'));
    if (Number.isFinite(groesse) && groesse > LADEN_HOECHSTENS_BYTES) return { ok: false, error: 'Die API-Beschreibung ist unerwartet groß – nicht geladen.' };
    const spec = JSON.parse(await response.text());
    if (!spec || typeof spec !== 'object' || typeof spec.paths !== 'object') return { ok: false, error: 'Die API-Beschreibung hat nicht die erwartete Form (OpenAPI).' };
    return { ok: true, spec };
  } catch (err) {
    return { ok: false, error: `Die API-Beschreibung ist nicht abrufbar: ${err.message}` };
  }
}

// ── Verweise und Schemata ───────────────────────────────────────────

/** Einem `$ref` im Dokument folgen (`#/components/schemas/Name`). Kreise enden bei `gesehen`. */
function aufloesen(spec, knoten, gesehen = new Set()) {
  let aktuell = knoten;
  while (aktuell && typeof aktuell === 'object' && typeof aktuell.$ref === 'string') {
    const ref = aktuell.$ref;
    if (gesehen.has(ref) || !ref.startsWith('#/')) return { typ: `↺ ${ref.split('/').pop()}` };
    gesehen.add(ref);
    aktuell = ref.slice(2).split('/').reduce((o, teil) => (o == null ? o : o[teil.replace(/~1/g, '/').replace(/~0/g, '~')]), spec);
  }
  return aktuell ?? {};
}

const kurzText = (text, laenge) => {
  const glatt = String(text ?? '').replace(/\s+/g, ' ').trim();
  return glatt.length > laenge ? `${glatt.slice(0, laenge - 1)}…` : glatt;
};

/**
 * Ein Schema so knapp, dass ein Assistent es lesen kann: Felder mit Typ,
 * Pflichtfelder mit `*`, Beschreibungen gekürzt, Alternativen mit ` | `.
 */
function schemaText(spec, schema, tiefe = 5, einzug = '', gesehen = new Set()) {
  // Die Verweise auf dem Weg bis hierher – ein Schema, das sich selbst enthält, endet beim zweiten Mal
  const verweise = new Set(gesehen);
  const s = aufloesen(spec, schema, verweise);
  if (s.typ) return s.typ;
  for (const art of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(s[art])) {
      const teile = s[art].map((teil) => schemaText(spec, teil, tiefe, einzug, verweise));
      return teile.join(art === 'allOf' ? ' & ' : ' | ');
    }
  }
  if (Array.isArray(s.enum)) return `enum[${s.enum.map((w) => JSON.stringify(w)).join(', ')}]`;
  const typ = Array.isArray(s.type) ? s.type.join('|') : s.type;
  if (typ === 'array') return `[${schemaText(spec, s.items ?? {}, tiefe, einzug, verweise)}]`;
  if (typ === 'object' || s.properties) {
    const felder = Object.entries(s.properties ?? {});
    if (!felder.length) return '{}';
    if (tiefe <= 0) return '{…}';
    const pflicht = new Set(s.required ?? []);
    const zeilen = felder.map(([name, feld]) => {
      const beschreibung = aufloesen(spec, feld).description;
      const hinweis = beschreibung ? `  // ${kurzText(beschreibung, 110)}` : '';
      return `${einzug}  ${name}${pflicht.has(name) ? '*' : ''}: ${schemaText(spec, feld, tiefe - 1, `${einzug}  `, verweise)}${hinweis}`;
    });
    return `{\n${zeilen.join('\n')}\n${einzug}}`;
  }
  const zusatz = ['format', 'default', 'minimum', 'maximum'].filter((k) => k in s).map((k) => ` ${k}=${s[k]}`).join('');
  return `${typ ?? 'beliebig'}${zusatz}`;
}

// ── Suchen und beschreiben ──────────────────────────────────────────

/** Alle Wege des Dokuments, die ein Server in diesem Modus aufrufen darf. */
function wege(spec, modus) {
  const liste = [];
  for (const [pfad, eintrag] of Object.entries(spec.paths ?? {})) {
    for (const methode of METHODEN) {
      const op = eintrag?.[methode];
      if (!op || !erreichbar(methode, pfad, modus)) continue;
      liste.push({ methode: methode.toUpperCase(), pfad, op });
    }
  }
  return liste;
}

/**
 * Wege nach Stichwörtern – alle Wörter müssen vorkommen (im Pfad, im Titel,
 * in der Beschreibung oder im Bereich). Treffer im Pfad wiegen am meisten. Nur
 * Wege, die der Server im Modus `modus` auch aufrufen darf – lesend also nur GET.
 *
 * @returns {Array<{methode: string, pfad: string, titel: string}>}
 */
function suche(spec, anfrage, { modus = 'loeschen', limit = 40 } = {}) {
  const woerter = String(anfrage ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!woerter.length) return [];
  const treffer = [];
  for (const { methode, pfad, op } of wege(spec, modus)) {
    const imPfad = `${methode} ${pfad}`.toLowerCase();
    const imTitel = `${op.summary ?? ''} ${(op.tags ?? []).join(' ')}`.toLowerCase();
    const imText = String(op.description ?? '').toLowerCase();
    let gewicht = 0;
    for (const wort of woerter) {
      if (imPfad.includes(wort)) gewicht += 3;
      else if (imTitel.includes(wort)) gewicht += 2;
      else if (imText.includes(wort)) gewicht += 1;
      else { gewicht = -1; break; }
    }
    if (gewicht > 0) treffer.push({ methode, pfad, titel: kurzText(op.summary || op.description || '', 100), gewicht });
  }
  treffer.sort((a, b) => b.gewicht - a.gewicht || a.pfad.localeCompare(b.pfad) || a.methode.localeCompare(b.methode));
  return treffer.slice(0, limit).map(({ methode, pfad, titel }) => ({ methode, pfad, titel }));
}

/** Den Eintrag des Dokuments zu einem Pfad finden – als Vorlage (`/events/{eventId}`) oder ausgefüllt (`/events/12`). */
function findePfad(spec, pfad) {
  if (spec.paths?.[pfad]) return pfad;
  const teile = pfad.split('/');
  let bester = null;
  let besteFeste = -1;
  for (const vorlage of Object.keys(spec.paths ?? {})) {
    const v = vorlage.split('/');
    if (v.length !== teile.length) continue;
    let feste = 0;
    const passt = v.every((segment, i) => {
      if (/^\{.*\}$/.test(segment)) return true;
      feste += 1;
      return segment === teile[i];
    });
    if (passt && feste > besteFeste) { bester = vorlage; besteFeste = feste; }
  }
  return bester;
}

/**
 * Einen Weg beschreiben: Parameter, Körper, Antworten. `null`, wenn es ihn nicht gibt.
 */
function beschreibe(spec, methode, pfad) {
  const vorlage = findePfad(spec, pfad);
  const eintrag = vorlage ? spec.paths[vorlage] : null;
  const op = eintrag?.[methode.toLowerCase()];
  if (!op) {
    if (!eintrag) return null;
    const andere = METHODEN.filter((m) => eintrag[m]).map((m) => m.toUpperCase());
    return `${methode.toUpperCase()} ${vorlage} gibt es nicht. Auf diesem Pfad gibt es: ${andere.join(', ') || 'nichts'}.`;
  }

  const zeilen = [`${methode.toUpperCase()} ${vorlage} — ${kurzText(op.summary ?? '', 160)}`];
  if (op.description) zeilen.push(kurzText(op.description, 900));

  const gesehen = new Set();
  const parameter = [...(eintrag.parameters ?? []), ...(op.parameters ?? [])]
    .map((p) => aufloesen(spec, p))
    .filter((p) => p.name && !gesehen.has(`${p.in}:${p.name}`) && gesehen.add(`${p.in}:${p.name}`));
  if (parameter.length) {
    zeilen.push('', 'Parameter:');
    for (const p of parameter) {
      const wo = p.in === 'path' ? 'Pfad' : p.in === 'query' ? 'query' : p.in;
      const hinweis = p.description ? `  // ${kurzText(p.description, 200)}` : '';
      zeilen.push(`  ${wo} ${p.name}${p.required ? '*' : ''}: ${schemaText(spec, p.schema ?? {}, 2)}${hinweis}`);
    }
  }

  const koerper = aufloesen(spec, op.requestBody ?? {});
  const koerperSchema = koerper.content?.['application/json']?.schema ?? Object.values(koerper.content ?? {})[0]?.schema;
  if (koerperSchema) zeilen.push('', `Körper (JSON${koerper.required ? ', Pflicht' : ''}):`, schemaText(spec, koerperSchema, 6));

  zeilen.push('', 'Antworten:');
  for (const [code, roh] of Object.entries(op.responses ?? {})) {
    const antwort = aufloesen(spec, roh);
    const schema = antwort.content?.['application/json']?.schema;
    const form = code.startsWith('2') && schema ? ` ${schemaText(spec, schema, 2)}` : '';
    zeilen.push(`  ${code}: ${kurzText(antwort.description ?? '', 120)}${form}`);
  }
  zeilen.push('', '* = Pflichtfeld. Pfade stehen relativ zu /api.');
  return zeilen.join('\n');
}

module.exports = { BESCHREIBUNG_PFAD, ladeBeschreibung, schemaText, suche, beschreibe, findePfad };
