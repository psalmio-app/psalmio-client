/**
 * Der gemeinsame Kern der MCP-Server dieses Pakets – `psalmio mcp` und
 * `psalmio churchtools-mcp`.
 *
 * Das Protokoll ist JSON-RPC 2.0, eine Nachricht je Zeile, ohne Fremdpaket:
 * `initialize`, `notifications/initialized`, `ping`, `tools/list`,
 * `tools/call`. Was ein Server kann, sagen allein seine Werkzeuge; hier steht
 * nur, wie sie aufgerufen werden und wie ihre Eingabe geprüft wird.
 *
 * Ein Werkzeug ist `{ name, description, inputSchema, annotations, run }`.
 * `run(args, kontext)` bekommt die geprüfte Eingabe und gibt
 * `{ text, isError? }` zurück.
 */

const readline = require('node:readline');

// Neueste zuerst: Kennt der Client eine davon, bekommt er sie; sonst die neueste
const PROTOKOLL_VERSIONEN = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ── Eingaben prüfen ─────────────────────────────────────────────────

const TYP_PASST = {
  string: (w) => typeof w === 'string',
  integer: (w) => Number.isInteger(w),
  number: (w) => typeof w === 'number' && Number.isFinite(w),
  boolean: (w) => typeof w === 'boolean',
  array: (w) => Array.isArray(w),
  object: (w) => w !== null && typeof w === 'object' && !Array.isArray(w),
};

/**
 * Passt die Eingabe zum Schema? Genug für die Schemata dieses Pakets:
 * Pflichtfelder, Typen, feste Werte (`enum`), unbekannte Felder, Listen – auch
 * von Objekten – und verschachtelte Objekte. Ein Feld ohne `type` nimmt jedes
 * JSON. Liefert die Mängel als Text – der Agent bekommt sie als
 * Fehlerergebnis und kann sich korrigieren.
 */
function eingabeMaengel(schema, args) {
  if (!TYP_PASST.object(args)) return ['arguments muss ein Objekt sein'];
  return objektMaengel(schema, args, '');
}

function objektMaengel(schema, wert, vor) {
  const maengel = [];
  for (const name of schema.required ?? []) {
    if (!(name in wert)) maengel.push(`${vor}${name} fehlt`);
  }
  for (const [name, inhalt] of Object.entries(wert)) {
    const feld = schema.properties?.[name];
    if (!feld) {
      if (schema.additionalProperties === false) maengel.push(`unbekanntes Feld ${vor}${name}`);
      continue;
    }
    maengel.push(...wertMaengel(feld, inhalt, `${vor}${name}`));
  }
  return maengel;
}

function wertMaengel(feld, wert, name) {
  if (!feld.type) return [];
  if (!TYP_PASST[feld.type]?.(wert)) return [`${name} muss vom Typ ${feld.type} sein`];
  if (feld.enum && !feld.enum.includes(wert)) return [`${name} muss einer dieser Werte sein: ${feld.enum.join(', ')}`];
  if (feld.type === 'array' && feld.items?.type) {
    if (feld.items.type === 'object') {
      return wert.flatMap((element, i) => (TYP_PASST.object(element)
        ? objektMaengel(feld.items, element, `${name}[${i}].`)
        : [`${name}[${i}] muss vom Typ object sein`]));
    }
    if (!wert.every((element) => TYP_PASST[feld.items.type](element))) return [`${name}: jedes Element muss vom Typ ${feld.items.type} sein`];
  }
  if (feld.type === 'object' && feld.properties) return objektMaengel(feld, wert, `${name}.`);
  return [];
}

// ── JSON-RPC ────────────────────────────────────────────────────────

const rpcFehler = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcErgebnis = (id, result) => ({ jsonrpc: '2.0', id, result });
const ergebnis = ({ text, isError }) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/**
 * Ein Server als reine Funktion: eine Nachricht hinein, eine Antwort heraus
 * (oder null bei einer Benachrichtigung). So lässt er sich ohne stdin/stdout
 * prüfen; `anLeitung` hängt ihn an die Leitung.
 *
 * @param {object} server
 * @param {string} server.name        Name in `serverInfo`
 * @param {string} server.version
 * @param {string} server.instructions
 * @param {Array} server.werkzeuge    die Werkzeuge, in der Reihenfolge, in der `tools/list` sie nennt
 * @param {object} [server.kontext]   was jedes `run` neben `progress` bekommt (Verbindung, Abhängigkeiten)
 */
function createHandler({ name, version, instructions, werkzeuge, kontext = {} }) {
  const nachName = new Map(werkzeuge.map((w) => [w.name, w]));

  async function handle(nachricht, { notify } = {}) {
    if (!TYP_PASST.object(nachricht) || nachricht.jsonrpc !== '2.0' || typeof nachricht.method !== 'string') {
      return rpcFehler(TYP_PASST.object(nachricht) ? nachricht.id ?? null : null, -32600, 'Invalid Request');
    }
    const { id, method, params = {} } = nachricht;
    const benachrichtigung = id === undefined;

    if (method.startsWith('notifications/')) return null;
    if (benachrichtigung) return null; // eine Anfrage ohne id bekommt keine Antwort

    if (method === 'initialize') {
      const gewuenscht = params.protocolVersion;
      return rpcErgebnis(id, {
        protocolVersion: PROTOKOLL_VERSIONEN.includes(gewuenscht) ? gewuenscht : PROTOKOLL_VERSIONEN[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name, version },
        instructions,
      });
    }
    if (method === 'ping') return rpcErgebnis(id, {});
    if (method === 'tools/list') {
      return rpcErgebnis(id, {
        tools: werkzeuge.map((w) => ({ name: w.name, description: w.description, inputSchema: w.inputSchema, annotations: w.annotations })),
      });
    }
    if (method === 'tools/call') {
      const werkzeug = nachName.get(params.name);
      if (!werkzeug) return rpcFehler(id, -32602, `Unbekanntes Werkzeug: ${params.name}`);
      const args = params.arguments ?? {};
      const maengel = eingabeMaengel(werkzeug.inputSchema, args);
      if (maengel.length) return rpcErgebnis(id, ergebnis({ text: `Eingabe passt nicht: ${maengel.join('; ')}`, isError: true }));

      const token = params._meta?.progressToken;
      const progress = token !== undefined && notify
        ? (prozent, text) => notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: prozent, total: 100, message: text } })
        : undefined;
      try {
        return rpcErgebnis(id, ergebnis(await werkzeug.run(args, { ...kontext, progress })));
      } catch (err) {
        // Ein Fehler im Werkzeug selbst – die Meldung enthält kein Geheimnis, Schlüssel und Token sind Header
        return rpcErgebnis(id, ergebnis({ text: `Werkzeug gescheitert: ${err?.message ?? err}`, isError: true }));
      }
    }
    return rpcFehler(id, -32601, `Unbekannte Methode: ${method}`);
  }

  return { handle, tools: werkzeuge.map((w) => w.name) };
}

/**
 * Einen Server an eine Leitung hängen – eine JSON-RPC-Nachricht je Zeile.
 *
 * Anfragen laufen nebeneinander: Ein langer Aufruf blockiert kein `ping`. Löst
 * auf, wenn die Eingabe endet (der Client hat die Verbindung geschlossen),
 * sobald die noch laufenden Anfragen zu Ende sind.
 *
 * @returns {Promise<number>} Rückgabewert für die Kommandozeile
 */
async function anLeitung(server, { input = process.stdin, output = process.stdout } = {}) {
  const schreiben = (nachricht) => {
    try {
      output.write(`${JSON.stringify(nachricht)}\n`);
    } catch {
      // Der Client ist weg – es gibt niemanden mehr, dem die Antwort fehlt
    }
  };
  output.on?.('error', () => {});

  const offen = new Set();
  const leitung = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const zeile of leitung) {
    if (!zeile.trim()) continue;
    let nachricht;
    try {
      nachricht = JSON.parse(zeile);
    } catch {
      schreiben(rpcFehler(null, -32700, 'Parse error'));
      continue;
    }
    const lauf = server.handle(nachricht, { notify: schreiben }).then((antwort) => { if (antwort) schreiben(antwort); });
    offen.add(lauf);
    lauf.finally(() => offen.delete(lauf));
  }
  await Promise.allSettled([...offen]);
  return 0;
}

module.exports = { PROTOKOLL_VERSIONEN, TYP_PASST, eingabeMaengel, createHandler, anLeitung };
