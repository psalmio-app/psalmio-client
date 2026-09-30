/**
 * Die Werkzeuge des ChurchTools-Servers (`psalmio churchtools-mcp`).
 *
 * Zwei Sorten:
 *
 *  - Eigene Werkzeuge für das, was in einer Gemeinde ständig vorkommt –
 *    Termine, Ablaufpläne, Lieder, Dienste, Personen, Gruppen, Kalender. Sie
 *    geben knappe Antworten (eine JSON-Zeile je Eintrag, Zeiten zusätzlich in
 *    Ortszeit) und kennen die Stolpersteine: Ein Ablaufplan wird nie über einen
 *    vorhandenen gelegt, ein geänderter Eintrag behält, was nicht genannt wurde.
 *  - Vier allgemeine Werkzeuge für alles Übrige: in der API-Beschreibung des
 *    ChurchTools suchen, einen Weg nachlesen, lesen, schreiben. ChurchTools
 *    hat über 500 Wege; für jeden ein eigenes Werkzeug wäre für einen
 *    Assistenten unlesbar.
 *
 * Jedes Werkzeug trägt seine Stufe (`lesen`, `schreiben`, `loeschen`); der
 * Server bietet nur an, was zu seinem Modus gehört. Was darüber hinaus nie
 * geht, steht in `regeln.js`.
 */

const api = require('./api');
const doku = require('./doku');
const { STUFEN, pfadPruefen, verboten } = require('./regeln');

// ── Kleine Helfer ───────────────────────────────────────────────────

const zeilen = (liste) => liste.map((eintrag) => JSON.stringify(eintrag)).join('\n');
const json = (wert) => JSON.stringify(wert, null, 2);
const istLeer = (w) => w === undefined || w === null || w === '' || (Array.isArray(w) && !w.length) || (typeof w === 'object' && !Array.isArray(w) && !Object.keys(w).length);
/** Leere Felder weglassen – die Antworten bleiben kurz. */
const ohneLeeres = (objekt) => Object.fromEntries(Object.entries(objekt).filter(([, w]) => !istLeer(w)));
const ohneUndefined = (objekt) => Object.fromEntries(Object.entries(objekt).filter(([, w]) => w !== undefined));
const kurz = (text, laenge) => {
  const glatt = String(text ?? '').replace(/\s+/g, ' ').trim();
  return glatt.length > laenge ? `${glatt.slice(0, laenge - 1)}…` : glatt;
};
const begrenzt = (text, hoechstens, hinweis) => (text.length > hoechstens ? `${text.slice(0, hoechstens)}\n… gekürzt (${text.length} Zeichen). ${hinweis}` : text);

const ct = (ctx, methode, pfad, anfrage) => api.request(ctx.config, methode, pfad, anfrage, ctx.deps);

/** Ein gescheiterter Aufruf als Werkzeug-Ergebnis – mit der Meldung von ChurchTools, damit der Assistent reagieren kann. */
function fehler(result, vorspann) {
  const teile = [vorspann, `Fehler: ${result.error ?? 'unbekannt'}`];
  if (result.status) teile.push(`(HTTP ${result.status})`);
  if (result.status === 401) teile.push('– ChurchTools nimmt den Login-Token nicht an.');
  if (result.status === 403) teile.push('– ChurchTools erlaubt das der Person hinter dem Login-Token nicht.');
  return { text: teile.filter(Boolean).join(' '), isError: true };
}

const DATUM = 'Tag als JJJJ-MM-TT';
const NUR_DATUM = /^\d{4}-\d{2}-\d{2}$/;
const falschesDatum = (args, ...namen) => namen.find((n) => args[n] !== undefined && !NUR_DATUM.test(args[n]));

// ── Zeit ────────────────────────────────────────────────────────────
//
// ChurchTools rechnet in Zulu-Zeit, Menschen in der Zeit ihres Ortes. Ein
// Assistent, der selbst umrechnet, liegt an den Tagen der Zeitumstellung gern
// eine Stunde daneben – deshalb steht die Ortszeit in jeder Antwort dabei.

const format = (zone, optionen) => new Intl.DateTimeFormat('de-DE', { timeZone: zone, ...optionen });

/** „So., 04.10.2026, 10:00“ – ein reines Datum (ganztägig) bleibt ein Datum. */
function ortszeit(iso, zone) {
  if (!iso) return undefined;
  const zeit = new Date(iso);
  if (Number.isNaN(zeit.getTime())) return undefined;
  if (NUR_DATUM.test(iso)) return format('UTC', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(zeit);
  return format(zone, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(zeit);
}

/** „10:05“ */
function uhrzeit(iso, zone) {
  if (!iso) return undefined;
  const zeit = new Date(iso);
  return Number.isNaN(zeit.getTime()) ? undefined : format(zone, { hour: '2-digit', minute: '2-digit' }).format(zeit);
}

/** Der Tag, auf den ein Zeitpunkt in der Zone fällt, als JJJJ-MM-TT. */
function ortsdatum(iso, zone) {
  const zeit = new Date(iso);
  return Number.isNaN(zeit.getTime()) ? undefined : new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(zeit);
}

/** Der heutige Tag in der Zone, als JJJJ-MM-TT. */
const tag = (zone) => ortsdatum(new Date().toISOString(), zone);

/** Ein Tag (JJJJ-MM-TT) und `tage` Tage weiter, wieder als JJJJ-MM-TT. */
const plusTage = (datum, tage) => new Date(Date.parse(`${datum}T00:00:00Z`) + tage * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Ein ganztägiger Kalendereintrag: sein Tag – bei einer Serie der des
 * Vorkommens – und, wenn er mehrere Tage dauert, der letzte. ChurchTools führt
 * ganztägige Einträge mit reinem Datum und einschließlichem Ende; das berechnete
 * Vorkommen kommt als Zeitpunkt, und dessen Tag zählt in der Ortszeit. So fällt
 * ein Eintrag am 3. Oktober nicht auf den 2., nur weil Mitternacht in Zulu-Zeit
 * noch der Vortag ist.
 */
function ganztaegig(basis, berechnet, zone) {
  const erster = NUR_DATUM.test(String(basis.startDate)) ? basis.startDate : ortsdatum(basis.startDate, zone);
  const letzter = NUR_DATUM.test(String(basis.endDate)) ? basis.endDate : ortsdatum(basis.endDate, zone);
  const vorkommen = (berechnet.startDate && ortsdatum(berechnet.startDate, zone)) || erster;
  const tage = erster && letzter ? Math.round((Date.parse(`${letzter}T00:00:00Z`) - Date.parse(`${erster}T00:00:00Z`)) / 86400000) : 0;
  return {
    start_local: vorkommen ? ortszeit(vorkommen, zone) : undefined,
    end_local: vorkommen && tage > 0 ? ortszeit(plusTage(vorkommen, tage), zone) : undefined,
  };
}

/** Um wie viele Millisekunden die Zone zu diesem Zeitpunkt vor UTC liegt. */
function versatz(ms, zone) {
  const teile = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const w = Object.fromEntries(teile.filter((t) => t.type !== 'literal').map((t) => [t.type, Number(t.value)]));
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Eine Zeitangabe als Zulu-Zeit, wie ChurchTools sie erwartet. Mit `Z` oder
 * Versatz (`+02:00`) gilt sie, wie sie dasteht; ohne beides ist sie die
 * Ortszeit der Zone. null, wenn sie sich nicht lesen lässt.
 */
function zuZulu(text, zone) {
  const roh = String(text ?? '').trim();
  const alsIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(roh)) {
    const ms = Date.parse(roh);
    return Number.isNaN(ms) ? null : alsIso(ms);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(roh);
  if (!m) return null;
  const [jahr, monat, tagImMonat, stunde, minute, sekunde] = m.slice(1).map((x) => Number(x ?? 0));
  const alsUtc = Date.UTC(jahr, monat - 1, tagImMonat, stunde, minute, sekunde);
  if (Number.isNaN(alsUtc)) return null;
  // Zweimal: Der Versatz hängt vom Zeitpunkt ab, und der steht erst nach dem ersten Schritt fest
  const ersterVersuch = alsUtc - versatz(alsUtc, zone);
  return alsIso(alsUtc - versatz(ersterVersuch, zone));
}

// ── Namen ───────────────────────────────────────────────────────────

/** Der Name einer Person – ChurchTools liefert sie mal als „Domain Object“ (title), mal mit Vor- und Nachname. */
function personName(p) {
  if (!p) return undefined;
  const ausTeilen = [p.domainAttributes?.firstName ?? p.firstName, p.domainAttributes?.lastName ?? p.lastName].filter(Boolean).join(' ');
  return p.title || ausTeilen || undefined;
}

const zahl = (wert) => {
  const n = Number(wert);
  return Number.isInteger(n) ? n : undefined;
};

/** Einmal je Server holen, was sich selten ändert (Dienste, Rollen) – scheitert es, beim nächsten Mal neu. */
function gemerkt(ctx, name, holen) {
  const zustand = ctx.zustand;
  if (!zustand[name]) {
    zustand[name] = holen().then((wert) => {
      if (wert === null) zustand[name] = null;
      return wert;
    });
  }
  return zustand[name];
}

/** Dienste nach ID – damit im Termin „Moderation“ steht und nicht nur eine Nummer. */
const dienste = (ctx) => gemerkt(ctx, 'dienste', async () => {
  const result = await ct(ctx, 'get', '/services');
  return result.ok && Array.isArray(result.data) ? new Map(result.data.map((d) => [d.id, d])) : null;
});

const rollen = (ctx) => gemerkt(ctx, 'rollen', async () => {
  const result = await ct(ctx, 'get', '/group/roles');
  return result.ok && Array.isArray(result.data) ? new Map(result.data.map((r) => [r.id, r.nameTranslated || r.name])) : null;
});

const beschreibung = (ctx) => gemerkt(ctx, 'beschreibung', async () => {
  const result = await doku.ladeBeschreibung(ctx.config, ctx.deps);
  if (!result.ok) ctx.zustand.beschreibungFehler = result.error;
  return result.ok ? result.spec : null;
});

const seitenHinweis = (meta) => {
  const p = meta?.pagination;
  return p && p.lastPage > 1 ? ` Seite ${p.current} von ${p.lastPage}${p.total !== undefined ? `, ${p.total} insgesamt` : ''} – weiter mit page.` : '';
};

// ── Ablaufplan ──────────────────────────────────────────────────────

const EINTRAG = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['text', 'song', 'header'], description: 'text (Vorgabe): ein Programmpunkt; song: ein Lied; header: eine Zwischenüberschrift' },
    title: { type: 'string', description: 'Titel des Eintrags. Bei einem Lied mit arrangement_id optional – ChurchTools zeigt dann den Titel des Liedes.' },
    duration_minutes: { type: 'number', description: 'Dauer in Minuten (auch 2.5). Aus den Dauern rechnet ChurchTools die Anfangszeiten.' },
    responsible: {
      type: 'string',
      description: 'Wer den Punkt verantwortet: ein Name als freier Text – oder ein Dienst in eckigen Klammern wie [Predigt], genau so geschrieben, wie er in bestehenden Abläufen der Gemeinde steht (mit ct_get_agenda an einem früheren Termin nachsehen); ChurchTools setzt dann ein, wer für den Dienst eingeteilt ist.',
    },
    note: { type: 'string', description: 'Notiz zum Eintrag' },
    arrangement_id: { type: 'integer', description: 'Nur bei song: das Arrangement des Liedes (id aus ct_search_songs). Ohne bleibt das Lied ein Platzhalter mit title.' },
    service_group_notes: {
      type: 'array',
      description: 'Notizen, die nur eine Dienstgruppe sieht (z. B. Technik)',
      items: {
        type: 'object',
        properties: {
          service_group_id: { type: 'integer', description: 'Dienstgruppe (group_id aus ct_list_services)' },
          note: { type: 'string' },
        },
        required: ['service_group_id', 'note'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const EVENT_ID = { type: 'integer', description: 'Kennung des Termins in der Dienstplanung (id aus ct_list_events) – nicht die des Kalendereintrags' };

const dienstgruppenNotizen = (liste) => liste.map((n) => ({ serviceGroupId: n.service_group_id, note: n.note }));

/** Ein Eintrag aus der Eingabe in der Form, die ChurchTools erwartet – oder der Mangel als Text. */
function eintragFuerApi(e, nr) {
  const art = e.type ?? 'text';
  const titel = typeof e.title === 'string' ? e.title.trim() : '';
  if (art === 'header') {
    if (!titel) return { mangel: `Eintrag ${nr}: eine Überschrift braucht title` };
    const zuviel = ['duration_minutes', 'responsible', 'note', 'arrangement_id', 'service_group_notes'].filter((f) => e[f] !== undefined);
    if (zuviel.length) return { mangel: `Eintrag ${nr}: eine Überschrift hat nur title (nicht ${zuviel.join(', ')})` };
    return { eintrag: { type: 'header', title: titel } };
  }
  if (art === 'text' && !titel) return { mangel: `Eintrag ${nr}: title fehlt` };
  if (art === 'text' && e.arrangement_id !== undefined) return { mangel: `Eintrag ${nr}: arrangement_id gibt es nur bei type "song"` };
  if (art === 'song' && !titel && e.arrangement_id === undefined) return { mangel: `Eintrag ${nr}: ein Lied braucht arrangement_id (aus ct_search_songs) oder title` };
  if (e.duration_minutes !== undefined && (e.duration_minutes < 0 || e.duration_minutes > 24 * 60)) return { mangel: `Eintrag ${nr}: duration_minutes zwischen 0 und 1440` };

  const eintrag = { type: art };
  if (titel) eintrag.title = titel;
  if (art === 'song') eintrag.arrangementId = e.arrangement_id ?? null;
  if (e.duration_minutes !== undefined) eintrag.duration = Math.round(e.duration_minutes * 60);
  if (e.note !== undefined) eintrag.note = e.note;
  if (e.responsible !== undefined) eintrag.responsible = e.responsible;
  if (e.service_group_notes) eintrag.serviceGroupNotes = dienstgruppenNotizen(e.service_group_notes);
  return { eintrag };
}

/** Alle Einträge umsetzen – oder der erste Mangel. */
function eintraegeFuerApi(liste) {
  const eintraege = [];
  for (const [i, e] of liste.entries()) {
    const { eintrag, mangel } = eintragFuerApi(e, i + 1);
    if (mangel) return { mangel };
    eintraege.push(eintrag);
  }
  return { eintraege };
}

/** Ein Eintrag des Ablaufplans, knapp. */
function eintragKurz(e, zone) {
  return ohneLeeres({
    id: e.id,
    position: e.position,
    type: e.type,
    title: e.title,
    duration_minutes: typeof e.duration === 'number' && e.duration > 0 ? Math.round(e.duration / 6) / 10 : undefined,
    start_local: uhrzeit(e.start, zone),
    before_event: e.isBeforeEvent || undefined,
    responsible: e.responsible?.text,
    responsible_persons: (e.responsible?.persons ?? []).map((p) => (personName(p?.person) ? `${p.service}: ${personName(p.person)}` : null)).filter(Boolean),
    note: e.note,
    song: e.song
      ? ohneLeeres({ song_id: e.song.songId, title: e.song.title, arrangement_id: e.song.arrangementId, arrangement: e.song.arrangement, key: e.song.key })
      : undefined,
    service_group_notes: (e.serviceGroupNotes ?? []).map((n) => ({ service_group_id: n.serviceGroupId, note: n.note })),
  });
}

/**
 * Der Körper für das Ändern eines Eintrags. ChurchTools nimmt den Eintrag als
 * Ganzes – deshalb geht mit, was er schon hat, und nur das Genannte ändert sich.
 * Notizen für Dienstgruppen gehen hier nicht mit: Sie haben ihren eigenen Weg,
 * und die fremder Gruppen sähe der Token nicht einmal.
 */
function eintragKoerper(eintrag, felder) {
  if (eintrag.type === 'header') return { type: 'header', title: felder.title ?? eintrag.title };
  return ohneUndefined({
    type: eintrag.type,
    title: felder.title ?? eintrag.title,
    duration: felder.duration_minutes !== undefined ? Math.round(felder.duration_minutes * 60) : eintrag.duration,
    note: felder.note !== undefined ? felder.note : eintrag.note ?? null,
    responsible: felder.responsible !== undefined ? felder.responsible : eintrag.responsible?.text ?? null,
    arrangementId: eintrag.type === 'song' ? felder.arrangement_id ?? eintrag.song?.arrangementId ?? null : undefined,
  });
}

const geordnet = (eintraege) => [...(eintraege ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

/** Kopfzeile und Einträge eines Ablaufplans (oder einer Vorlage) als Text. */
function ablaufText(agenda, zone) {
  const kopf = ohneLeeres({
    agenda_id: agenda.id, name: agenda.name, series: agenda.series, locked: agenda.isLocked ?? agenda.isFinal,
    entries: agenda.items?.length ?? 0, event_start_position: agenda.eventStartPosition || undefined,
  });
  const eintraege = geordnet(agenda.items).map((e) => eintragKurz(e, zone));
  return eintraege.length ? `${JSON.stringify(kopf)}\n${zeilen(eintraege)}` : `${JSON.stringify(kopf)}\n(keine Einträge)`;
}

// ── Werkzeuge ───────────────────────────────────────────────────────

const LESEND = { readOnlyHint: true };

const WERKZEUGE = [
  // ── Verbindung ──
  {
    name: 'ct_check_connection',
    stufe: 'lesen',
    description: 'Verbindung zu ChurchTools prüfen. Sagt, als welche Person der Login-Token arbeitet, welche Fassung ChurchTools hat und was dieser Server darf (nur lesen, schreiben, löschen).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LESEND,
    async run(_args, ctx) {
      const ich = await ct(ctx, 'get', '/whoami', { query: { only_allow_authenticated: true } });
      if (!ich.ok) return fehler(ich, 'Keine Verbindung zu ChurchTools.');
      const info = await ct(ctx, 'get', '/info');
      const fassung = info.ok && info.data?.version ? ` ${info.data.version}` : '';
      const gemeinde = info.ok && (info.data?.siteName || info.data?.shortName) ? ` („${info.data.siteName || info.data.shortName}“)` : '';
      const darf = { lesen: 'nur lesen', schreiben: 'lesen und schreiben, ohne Löschen', loeschen: 'lesen, schreiben und löschen' }[ctx.config.modus];
      return {
        text: `Verbunden mit ChurchTools${fassung}${gemeinde} als ${personName(ich.data) ?? 'unbekannt'} (Person ${ich.data?.id ?? '?'}). `
          + `Dieser Server darf: ${darf}. Ortszeiten stehen in ${ctx.config.zeitzone}.`,
      };
    },
  },

  // ── Termine ──
  {
    name: 'ct_list_events',
    stufe: 'lesen',
    description:
      'Termine der Dienstplanung (Gottesdienste und andere Veranstaltungen mit Diensten und Ablaufplan), aufsteigend nach Beginn – je Zeile ein '
      + 'JSON-Objekt mit id, Name, Beginn (Zulu und Ortszeit) und Kalender. Ohne Zeitraum: ab heute, rund zwei Monate. Mit der id arbeiten die '
      + 'Ablaufplan- und Dienst-Werkzeuge.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Frühester ${DATUM} (Vorgabe: heute)` },
        to: { type: 'string', description: `Spätester ${DATUM} (Vorgabe: 62 Tage nach from)` },
        include_canceled: { type: 'boolean', description: 'Auch abgesagte Termine zeigen' },
        limit: { type: 'integer', description: 'Höchstens so viele (Vorgabe 50, höchstens 500)' },
      },
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const falsch = falschesDatum(args, 'from', 'to');
      if (falsch) return { text: `${falsch} als JJJJ-MM-TT angeben.`, isError: true };
      const zone = ctx.config.zeitzone;
      const from = args.from ?? tag(zone);
      const result = await ct(ctx, 'get', '/events', { query: { from, to: args.to ?? plusTage(from, 62), canceled: args.include_canceled ? true : undefined } });
      if (!result.ok) return fehler(result);
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
      const alle = (Array.isArray(result.data) ? result.data : []).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
      const gezeigt = alle.slice(0, limit).map((e) => ohneLeeres({
        id: e.id, name: e.name, start: e.startDate, start_local: ortszeit(e.startDate, zone), calendar: e.calendar?.title, canceled: e.isCanceled || undefined,
      }));
      const kopf = alle.length > limit ? `${alle.length} Termine, die ersten ${limit}:` : `${alle.length} Termin(e):`;
      return { text: gezeigt.length ? `${kopf}\n${zeilen(gezeigt)}` : 'Keine Termine in diesem Zeitraum.' };
    },
  },
  {
    name: 'ct_get_event',
    stufe: 'lesen',
    description:
      'Einen Termin der Dienstplanung lesen: Name, Beginn und Ende, Kalender, Notiz und die Dienste – je Dienst, wer eingeteilt ist, ob '
      + 'zugesagt wurde und die request_id, mit der ct_assign_service jemanden einteilt. Ein Dienst ohne Person ist offen.',
    inputSchema: { type: 'object', properties: { event_id: EVENT_ID }, required: ['event_id'], additionalProperties: false },
    annotations: LESEND,
    async run(args, ctx) {
      const result = await ct(ctx, 'get', `/events/${args.event_id}`);
      if (!result.ok) return fehler(result);
      const e = result.data ?? {};
      const zone = ctx.config.zeitzone;
      const namen = await dienste(ctx);
      const eingeteilt = (e.eventServices ?? e.event_services ?? [])
        .filter((d) => d.isValid !== false)
        .map((d) => ohneLeeres({
          request_id: d.id,
          service_id: d.serviceId,
          service: namen?.get(d.serviceId)?.name,
          person_id: d.personId,
          person: personName(d.person) ?? d.name,
          accepted: d.personId || d.name ? Boolean(d.isAccepted ?? d.agreed) : undefined,
          open: d.personId || d.name ? undefined : true,
          comment: d.comment,
        }));
      return {
        text: json(ohneLeeres({
          id: e.id, name: e.name, start: e.startDate, start_local: ortszeit(e.startDate, zone), end_local: ortszeit(e.endDate, zone),
          calendar: ohneLeeres({ id: zahl(e.calendar?.domainIdentifier), title: e.calendar?.title }),
          canceled: e.isCanceled || undefined, note: e.note, appointment_id: e.appointmentId, services: eingeteilt,
        })),
      };
    },
  },

  // ── Ablaufplan ──
  {
    name: 'ct_get_agenda',
    stufe: 'lesen',
    description:
      'Den Ablaufplan eines Termins lesen: erst eine Zeile zum Plan (gesperrt?, Anzahl Einträge), dann je Eintrag ein JSON-Objekt mit id, '
      + 'Art (text, song, header), Titel, Dauer in Minuten, Anfang in Ortszeit, Verantwortlichen, Notiz und bei Liedern Arrangement und Tonart.',
    inputSchema: { type: 'object', properties: { event_id: EVENT_ID }, required: ['event_id'], additionalProperties: false },
    annotations: LESEND,
    async run(args, ctx) {
      const result = await ct(ctx, 'get', `/events/${args.event_id}/agenda`);
      if (!result.ok) return result.status === 404 ? { text: `Termin ${args.event_id} hat keinen Ablaufplan (oder es gibt den Termin nicht).` } : fehler(result);
      return { text: ablaufText(result.data ?? {}, ctx.config.zeitzone) };
    },
  },
  {
    name: 'ct_create_agenda',
    stufe: 'schreiben',
    description:
      'Einen Ablaufplan für einen Termin anlegen – aus einer Liste von Einträgen (items, in dieser Reihenfolge), aus einer Vorlage '
      + '(template_id aus ct_list_agenda_templates) oder als Kopie des Plans eines anderen Termins (copy_from_event_id); genau eine der drei '
      + 'Quellen, oder keine für einen leeren Plan. Legt nie über einen vorhandenen Plan: Hat der Termin schon Einträge, ändert sich nichts '
      + '(dann ct_add_agenda_items). Vorher den Termin mit ct_list_events suchen und Lieder mit ct_search_songs. Anfangszeiten rechnet '
      + 'ChurchTools aus den Dauern ab Terminbeginn.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: EVENT_ID,
        items: { type: 'array', description: 'Die Einträge des Plans in ihrer Reihenfolge', items: EINTRAG },
        template_id: { type: 'integer', description: 'Statt items: eine Ablaufplan-Vorlage übernehmen' },
        copy_from_event_id: { type: 'integer', description: 'Statt items: den Plan dieses Termins kopieren' },
        event_start_position: {
          type: 'integer',
          description: 'Position (ab 0) des ersten Eintrags, der zum Terminbeginn läuft – Einträge davor (Soundcheck, Gebet des Teams) liegen vor dem Beginn. Vorgabe 0.',
        },
        series: { type: 'string', description: 'Name der Reihe, zu der der Plan gehört (optional)' },
      },
      required: ['event_id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async run(args, ctx) {
      const quellen = ['items', 'template_id', 'copy_from_event_id'].filter((q) => args[q] !== undefined);
      if (quellen.length > 1) return { text: `Nur eine Quelle angeben, nicht ${quellen.join(' und ')}.`, isError: true };
      if (args.event_start_position !== undefined && args.event_start_position < 0) return { text: 'event_start_position ab 0.', isError: true };
      const { eintraege, mangel } = args.items ? eintraegeFuerApi(args.items) : {};
      if (mangel) return { text: mangel, isError: true };

      const event = await ct(ctx, 'get', `/events/${args.event_id}`);
      if (!event.ok) return fehler(event, `Termin ${args.event_id} ist nicht lesbar.`);
      const vorhanden = await ct(ctx, 'get', `/events/${args.event_id}/agenda`);
      if (!vorhanden.ok && vorhanden.status !== 404) return fehler(vorhanden, 'Ob es schon einen Ablaufplan gibt, ließ sich nicht prüfen.');
      const schonDa = vorhanden.ok ? vorhanden.data?.items?.length ?? 0 : 0;
      if (schonDa > 0) {
        return {
          text: `„${event.data?.name ?? args.event_id}“ hat schon einen Ablaufplan mit ${schonDa} Einträgen – nichts geändert. `
            + 'Ergänzen: ct_add_agenda_items. Ersetzen geht nur, nachdem der vorhandene Plan gelöscht wurde (ct_delete_agenda, nur mit --allow-delete).',
          isError: true,
        };
      }
      // Der Plan gehört zum Kalender des Termins – ChurchTools verlangt ihn beim Anlegen
      const calendarId = (vorhanden.ok && zahl(vorhanden.data?.calendarId)) || zahl(event.data?.calendar?.domainIdentifier);
      if (calendarId === undefined) return { text: 'Der Kalender des Termins ist nicht erkennbar – ohne ihn legt ChurchTools keinen Ablaufplan an.', isError: true };

      const result = await ct(ctx, 'put', `/events/${args.event_id}/agenda`, {
        query: { template_id: args.template_id, event_id: args.copy_from_event_id },
        body: ohneUndefined({ calendarId, items: eintraege, eventStartPosition: args.event_start_position, series: args.series }),
      });
      if (!result.ok) return fehler(result, 'Ablaufplan nicht angelegt.');

      const angelegt = result.data?.items;
      const woher = args.template_id !== undefined ? ` aus Vorlage ${args.template_id}` : args.copy_from_event_id !== undefined ? ` als Kopie von Termin ${args.copy_from_event_id}` : '';
      const kopf = `Ablaufplan für „${event.data?.name ?? args.event_id}“ (${ortszeit(event.data?.startDate, ctx.config.zeitzone) ?? '?'}) angelegt${woher}.`;
      if (!Array.isArray(angelegt)) return { text: `${kopf} ChurchTools hat die Einträge nicht zurückgegeben – mit ct_get_agenda nachsehen.` };
      const abweichung = eintraege && angelegt.length !== eintraege.length
        ? `\nAchtung: ${eintraege.length} Einträge geschickt, ChurchTools führt ${angelegt.length} – bitte prüfen.`
        : '';
      return { text: `${kopf}${abweichung}\n${ablaufText(result.data, ctx.config.zeitzone)}` };
    },
  },
  {
    name: 'ct_add_agenda_items',
    stufe: 'schreiben',
    description:
      'Einträge in einen vorhandenen Ablaufplan einfügen – einen oder mehrere, in der angegebenen Reihenfolge. Ohne Angabe ans Ende; mit '
      + 'after_item_id hinter diesen Eintrag, mit before_item_id davor (ids aus ct_get_agenda). Bricht beim ersten Fehler ab und sagt, wie '
      + 'viele angelegt wurden.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: EVENT_ID,
        items: { type: 'array', description: 'Die neuen Einträge in ihrer Reihenfolge', items: EINTRAG },
        after_item_id: { type: 'integer', description: 'Hinter diesem Eintrag einfügen' },
        before_item_id: { type: 'integer', description: 'Vor diesem Eintrag einfügen' },
      },
      required: ['event_id', 'items'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async run(args, ctx) {
      if (args.after_item_id !== undefined && args.before_item_id !== undefined) return { text: 'after_item_id oder before_item_id – nicht beides.', isError: true };
      if (!args.items.length) return { text: 'items ist leer – nichts einzufügen.', isError: true };
      const { eintraege, mangel } = eintraegeFuerApi(args.items);
      if (mangel) return { text: mangel, isError: true };

      const pfad = `/events/${args.event_id}/agenda`;
      const agenda = await ct(ctx, 'get', pfad);
      if (!agenda.ok) {
        return agenda.status === 404
          ? { text: `Termin ${args.event_id} hat noch keinen Ablaufplan – zuerst ct_create_agenda.`, isError: true }
          : fehler(agenda);
      }
      const vorhandene = geordnet(agenda.data?.items);
      const anker = args.after_item_id ?? args.before_item_id;
      if (anker !== undefined && !vorhandene.some((e) => e.id === anker)) return { text: `Eintrag ${anker} gibt es in diesem Ablaufplan nicht.`, isError: true };

      // Der erste Eintrag kommt an die gewünschte Stelle, jeder weitere hinter den zuvor angelegten – so bleibt die Reihenfolge
      let stelle = {};
      if (args.after_item_id !== undefined) stelle = { after_id: args.after_item_id };
      else if (args.before_item_id !== undefined) stelle = { before_id: args.before_item_id };
      else if (vorhandene.length) stelle = { after_id: vorhandene[vorhandene.length - 1].id };

      const angelegt = [];
      for (const [i, eintrag] of eintraege.entries()) {
        const result = await ct(ctx, 'post', `${pfad}/items`, { query: stelle, body: eintrag });
        if (!result.ok) {
          return fehler(result, `${angelegt.length} von ${eintraege.length} Einträgen angelegt; gescheitert bei Eintrag ${i + 1} („${eintrag.title ?? eintrag.type}“).`);
        }
        angelegt.push(result.data ?? {});
        if (result.data?.id === undefined && i + 1 < eintraege.length) {
          return {
            text: `${angelegt.length} von ${eintraege.length} Einträgen angelegt; ChurchTools hat keine Kennung zurückgegeben, die Reihenfolge der übrigen wäre unsicher – abgebrochen. Mit ct_get_agenda nachsehen.`,
            isError: true,
          };
        }
        stelle = { after_id: result.data?.id };
      }
      return { text: `${angelegt.length} Eintrag/Einträge eingefügt:\n${zeilen(angelegt.map((e) => eintragKurz(e, ctx.config.zeitzone)))}` };
    },
  },
  {
    name: 'ct_update_agenda_item',
    stufe: 'schreiben',
    description:
      'Einen Eintrag des Ablaufplans ändern oder verschieben. Was nicht genannt wird, bleibt, wie es ist. Verschieben mit '
      + 'move_after_item_id oder move_before_item_id (ids aus ct_get_agenda).',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: EVENT_ID,
        item_id: { type: 'integer', description: 'Kennung des Eintrags (id aus ct_get_agenda)' },
        title: { type: 'string' },
        duration_minutes: { type: 'number', description: 'Dauer in Minuten' },
        responsible: { type: 'string', description: 'Verantwortlich: Name oder Dienst-Platzhalter; leer entfernt die Angabe' },
        note: { type: 'string', description: 'Notiz; leer entfernt sie' },
        arrangement_id: { type: 'integer', description: 'Nur bei einem Lied: anderes Arrangement (id aus ct_search_songs)' },
        move_after_item_id: { type: 'integer', description: 'Hinter diesen Eintrag verschieben' },
        move_before_item_id: { type: 'integer', description: 'Vor diesen Eintrag verschieben' },
        service_group_notes: {
          type: 'array',
          description: 'Notizen für Dienstgruppen setzen oder ersetzen (je Gruppe eine); andere Gruppen behalten ihre',
          items: EINTRAG.properties.service_group_notes.items,
        },
      },
      required: ['event_id', 'item_id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const { event_id: eventId, item_id: itemId, move_after_item_id: hinter, move_before_item_id: vor, service_group_notes: notizen, ...felder } = args;
      if (hinter !== undefined && vor !== undefined) return { text: 'move_after_item_id oder move_before_item_id – nicht beides.', isError: true };
      if (!Object.keys(felder).length && hinter === undefined && vor === undefined && !notizen?.length) {
        return { text: 'Nichts zu ändern: mindestens ein Feld, ein Ziel zum Verschieben oder eine Notiz angeben.', isError: true };
      }
      if (notizen?.some((n) => !n.note.trim())) return { text: 'Eine Notiz für eine Dienstgruppe darf nicht leer sein (entfernen: ct_api_write DELETE, nur mit --allow-delete).', isError: true };
      if (felder.duration_minutes !== undefined && (felder.duration_minutes < 0 || felder.duration_minutes > 24 * 60)) return { text: 'duration_minutes zwischen 0 und 1440.', isError: true };

      const agenda = await ct(ctx, 'get', `/events/${eventId}/agenda`);
      if (!agenda.ok) return fehler(agenda, 'Ablaufplan nicht lesbar.');
      const eintrag = (agenda.data?.items ?? []).find((e) => e.id === itemId);
      if (!eintrag) return { text: `Eintrag ${itemId} gibt es im Ablaufplan von Termin ${eventId} nicht.`, isError: true };
      if (eintrag.type !== 'song' && felder.arrangement_id !== undefined) return { text: 'arrangement_id gibt es nur bei einem Lied.', isError: true };
      if (eintrag.type === 'header' && (Object.keys(felder).some((f) => f !== 'title') || notizen?.length)) return { text: 'Eine Überschrift hat nur einen Titel.', isError: true };

      const zone = ctx.config.zeitzone;
      const nurNotizen = !Object.keys(felder).length && hinter === undefined && vor === undefined;
      let ergebnisEintrag = eintrag;
      if (!nurNotizen) {
        const result = await ct(ctx, 'put', `/events/${eventId}/agenda/items/${itemId}`, { query: { after_id: hinter, before_id: vor }, body: eintragKoerper(eintrag, felder) });
        if (!result.ok) return fehler(result);
        ergebnisEintrag = result.data ?? eintrag;
      }
      for (const [i, n] of (notizen ?? []).entries()) {
        const result = await ct(ctx, 'put', `/events/${eventId}/agenda/items/${itemId}/servicegroups/${n.service_group_id}`, { body: { note: n.note } });
        if (!result.ok) return fehler(result, `${nurNotizen ? '' : 'Eintrag geändert; '}${i} von ${notizen.length} Notizen gesetzt, gescheitert bei Dienstgruppe ${n.service_group_id}.`);
      }
      const was = [
        ...Object.keys(felder),
        ...(hinter !== undefined || vor !== undefined ? ['Position'] : []),
        ...(notizen?.length ? [`${notizen.length} Notiz(en) für Dienstgruppen`] : []),
      ].join(', ');
      return { text: `Eintrag ${itemId} geändert (${was}).\n${JSON.stringify(eintragKurz(ergebnisEintrag, zone))}` };
    },
  },
  {
    name: 'ct_set_agenda_lock',
    stufe: 'schreiben',
    description: 'Den Ablaufplan eines Termins sperren (fertig, keine Änderungen mehr) oder wieder freigeben. Teilen sich mehrere Termine einen Plan, gilt es für alle.',
    inputSchema: {
      type: 'object',
      properties: { event_id: EVENT_ID, locked: { type: 'boolean', description: 'true sperrt, false gibt frei' } },
      required: ['event_id', 'locked'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
    async run(args, ctx) {
      const result = await ct(ctx, 'post', `/events/${args.event_id}/agenda/${args.locked ? 'lock' : 'unlock'}`, { body: {} });
      return result.ok ? { text: `Ablaufplan von Termin ${args.event_id} ${args.locked ? 'gesperrt' : 'freigegeben'}.` } : fehler(result);
    },
  },
  {
    name: 'ct_delete_agenda_item',
    stufe: 'loeschen',
    description: 'Einen Eintrag aus dem Ablaufplan löschen. Nicht umkehrbar – nur auf ausdrückliche Bitte.',
    inputSchema: {
      type: 'object',
      properties: { event_id: EVENT_ID, item_id: { type: 'integer', description: 'Kennung des Eintrags (id aus ct_get_agenda)' } },
      required: ['event_id', 'item_id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    async run(args, ctx) {
      const result = await ct(ctx, 'delete', `/events/${args.event_id}/agenda/items/${args.item_id}`);
      return result.ok ? { text: `Eintrag ${args.item_id} aus dem Ablaufplan von Termin ${args.event_id} gelöscht.` } : fehler(result);
    },
  },
  {
    name: 'ct_delete_agenda',
    stufe: 'loeschen',
    description: 'Den ganzen Ablaufplan eines Termins löschen – alle Einträge. Nicht umkehrbar – nur auf ausdrückliche Bitte, und vorher mit ct_get_agenda zeigen, was wegfällt.',
    inputSchema: { type: 'object', properties: { event_id: EVENT_ID }, required: ['event_id'], additionalProperties: false },
    annotations: { destructiveHint: true, idempotentHint: true },
    async run(args, ctx) {
      const result = await ct(ctx, 'delete', `/events/${args.event_id}/agenda`);
      return result.ok ? { text: `Ablaufplan von Termin ${args.event_id} gelöscht.` } : fehler(result);
    },
  },
  {
    name: 'ct_list_agenda_templates',
    stufe: 'lesen',
    description: 'Die Ablaufplan-Vorlagen der Gemeinde – je Zeile id, Name, Reihe und Anzahl Einträge. Mit template_id die Einträge einer Vorlage.',
    inputSchema: { type: 'object', properties: { template_id: { type: 'integer', description: 'Eine Vorlage mit ihren Einträgen zeigen' } }, additionalProperties: false },
    annotations: LESEND,
    async run(args, ctx) {
      if (args.template_id !== undefined) {
        const eine = await ct(ctx, 'get', `/agendatemplates/${args.template_id}`);
        return eine.ok ? { text: ablaufText(eine.data ?? {}, ctx.config.zeitzone) } : fehler(eine);
      }
      const result = await ct(ctx, 'get', '/agendatemplates');
      if (!result.ok) return fehler(result);
      const vorlagen = (Array.isArray(result.data) ? result.data : []).map((v) => ohneLeeres({
        id: v.id, name: v.name, series: v.series, calendar_id: v.calendarId, entries: v.items?.length ?? v.total,
      }));
      return { text: vorlagen.length ? `${vorlagen.length} Vorlage(n):\n${zeilen(vorlagen)}` : 'Es gibt keine Ablaufplan-Vorlagen.' };
    },
  },

  // ── Lieder ──
  {
    name: 'ct_search_songs',
    stufe: 'lesen',
    description:
      'Lieder in der Liederdatenbank suchen (Titel oder Autor) – je Zeile id, Titel, Autor, CCLI-Nummer, Kategorie und die Arrangements mit '
      + 'id, Tonart, Tempo und Dauer. Die id eines Arrangements (arrangement_id) braucht ein Lied im Ablaufplan; „default“ ist das übliche.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchwort in Titel oder Autor; ohne: alle Lieder' },
        limit: { type: 'integer', description: 'Höchstens so viele je Seite (Vorgabe 20, höchstens 100)' },
        page: { type: 'integer', description: 'Seite (ab 1)' },
      },
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const result = await ct(ctx, 'get', '/songs', { query: { query: args.query, include: 'arrangements', limit, page: args.page } });
      if (!result.ok) return fehler(result);
      const lieder = (Array.isArray(result.data) ? result.data : []).map((l) => ohneLeeres({
        id: l.id,
        name: l.name,
        author: l.author,
        ccli: l.ccli,
        category: l.category?.nameTranslated || l.category?.name,
        arrangements: (l.arrangements ?? []).map((a) => ohneLeeres({
          id: a.id, name: a.name, key: a.key ?? a.keyOfArrangement, tempo: a.tempo,
          duration_minutes: a.duration ? Math.round(a.duration / 6) / 10 : undefined, default: a.isDefault || undefined,
        })),
      }));
      return { text: lieder.length ? `${lieder.length} Lied(er).${seitenHinweis(result.meta)}\n${zeilen(lieder)}` : 'Kein Lied gefunden.' };
    },
  },

  // ── Dienste ──
  {
    name: 'ct_list_services',
    stufe: 'lesen',
    description: 'Die Dienste der Gemeinde (Moderation, Predigt, Technik …) mit ihrer Dienstgruppe – je Zeile id, Name, group_id und Gruppe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LESEND,
    async run(_args, ctx) {
      const [gruppen, liste] = await Promise.all([ct(ctx, 'get', '/servicegroups'), ct(ctx, 'get', '/services')]);
      if (!liste.ok) return fehler(liste);
      const gruppe = new Map((gruppen.ok && Array.isArray(gruppen.data) ? gruppen.data : []).map((g) => [g.id, g]));
      const eintraege = (Array.isArray(liste.data) ? liste.data : [])
        .sort((a, b) => (gruppe.get(a.serviceGroupId)?.sortKey ?? 0) - (gruppe.get(b.serviceGroupId)?.sortKey ?? 0) || (a.sortKey ?? 0) - (b.sortKey ?? 0))
        .map((d) => ohneLeeres({ id: d.id, name: d.nameTranslated || d.name, group_id: d.serviceGroupId, group: gruppe.get(d.serviceGroupId)?.name }));
      return { text: eintraege.length ? `${eintraege.length} Dienst(e):\n${zeilen(eintraege)}` : 'Es gibt keine Dienste.' };
    },
  },
  {
    name: 'ct_find_service_candidates',
    stufe: 'lesen',
    description:
      'Wer für einen Dienst an einem Termin in Frage kommt – je Zeile person_id, Name, Abwesenheiten um den Termin, letzter und nächster '
      + 'Einsatz. Hilft vor ct_assign_service.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: EVENT_ID,
        service_id: { type: 'integer', description: 'Der Dienst (service_id aus ct_get_event oder id aus ct_list_services)' },
        limit: { type: 'integer', description: 'Höchstens so viele (Vorgabe 50, höchstens 300)' },
      },
      required: ['event_id', 'service_id'],
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const result = await ct(ctx, 'get', `/events/${args.event_id}/services/${args.service_id}/possiblepersons`);
      if (!result.ok) return fehler(result);
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 300);
      const alle = Array.isArray(result.data) ? result.data : [];
      const einsatz = (e) => e?.event?.domainAttributes?.startDate?.slice(0, 10) ?? e?.eventService?.event?.startDate?.slice(0, 10);
      const leute = alle.slice(0, limit).map((k) => ohneLeeres({
        person_id: zahl(k.person?.domainIdentifier),
        name: personName(k.person),
        absences: (k.absences ?? []).map((a) => `${a.startDate}–${a.endDate}${a.comment ? ` (${a.comment})` : ''}`),
        last_service: einsatz(k.lastService),
        next_service: einsatz(k.nextService),
      }));
      const kopf = alle.length > limit ? `${alle.length} Personen, die ersten ${limit}:` : `${alle.length} Person(en):`;
      return { text: leute.length ? `${kopf}\n${zeilen(leute)}` : 'Für diesen Dienst kommt niemand in Frage.' };
    },
  },
  {
    name: 'ct_assign_service',
    stufe: 'schreiben',
    description:
      'Jemanden für einen Dienst an einem Termin einteilen: eine Person aus ChurchTools (person_id) oder jemanden von außerhalb (name). '
      + 'request_id ist der Eintrag des Dienstes am Termin aus ct_get_event – ein offener, oder einer, dessen Besetzung wechseln soll. '
      + 'ChurchTools fragt die Person je nach Einstellung des Dienstes per E-Mail an – nur auf ausdrückliche Bitte einteilen.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: EVENT_ID,
        request_id: { type: 'integer', description: 'Der Dienst-Eintrag am Termin (request_id aus ct_get_event)' },
        person_id: { type: 'integer', description: 'Person aus ChurchTools (id aus ct_search_persons oder ct_find_service_candidates)' },
        name: { type: 'string', description: 'Statt person_id: Name einer Person, die nicht in ChurchTools steht' },
      },
      required: ['event_id', 'request_id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async run(args, ctx) {
      const mitPerson = args.person_id !== undefined;
      const mitName = typeof args.name === 'string' && args.name.trim() !== '';
      if (mitPerson === mitName) return { text: 'Genau eines angeben: person_id oder name.', isError: true };
      const body = mitPerson ? { personId: args.person_id, name: null } : { name: args.name.trim(), personId: null };
      const result = await ct(ctx, 'put', `/events/${args.event_id}/servicerequests/${args.request_id}`, { body });
      if (!result.ok) return fehler(result);
      const d = result.data ?? {};
      return {
        text: `Eingeteilt: ${personName(d.person) ?? d.name ?? (mitPerson ? `Person ${args.person_id}` : args.name)} für ${d.serviceName ?? `Dienst ${d.serviceId ?? '?'}`} `
          + `an Termin ${args.event_id}. ${JSON.stringify(ohneLeeres({ request_id: d.id, accepted: Boolean(d.isAccepted ?? d.agreed) }))} `
          + '– die request_id kann sich dabei geändert haben.',
      };
    },
  },

  // ── Personen und Gruppen ──
  {
    name: 'ct_search_persons',
    stufe: 'lesen',
    description:
      'Personen suchen (Teil von Vorname, Nachname oder Spitzname) – je Zeile id, Vor- und Nachname. Nur Namen: Mehr zu einer Person liefert '
      + 'ct_get_person, und nur, wenn die Aufgabe es braucht.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Teil des Namens' },
        limit: { type: 'integer', description: 'Höchstens so viele (Vorgabe 20, höchstens 200)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
      const result = await ct(ctx, 'get', '/persons', { query: { query: args.query, limit } });
      if (!result.ok) return fehler(result);
      const leute = (Array.isArray(result.data) ? result.data : []).map((p) => ohneLeeres({ id: p.id, first_name: p.firstName, last_name: p.lastName, nickname: p.nickname }));
      return { text: leute.length ? `${leute.length} Person(en).${seitenHinweis(result.meta)}\n${zeilen(leute)}` : 'Keine Person gefunden.' };
    },
  },
  {
    name: 'ct_get_person',
    stufe: 'lesen',
    description:
      'Die Angaben zu einer Person, soweit der Login-Token sie sehen darf (Kontakt, Anschrift, Geburtstag, Status …). Personenbezogene Daten: '
      + 'nur abrufen, wenn die Aufgabe sie braucht, und nicht weitergeben.',
    inputSchema: { type: 'object', properties: { person_id: { type: 'integer', description: 'Kennung der Person' } }, required: ['person_id'], additionalProperties: false },
    annotations: LESEND,
    async run(args, ctx) {
      const result = await ct(ctx, 'get', `/persons/${args.person_id}`);
      if (!result.ok) return fehler(result);
      const { meta, imageUrl, familyImageUrl, guid, securityLevelForPerson, editSecurityLevelForPerson, cmsUserId, ...rest } = result.data ?? {};
      return { text: json(ohneLeeres(rest)) };
    },
  },
  {
    name: 'ct_list_groups',
    stufe: 'lesen',
    description: 'Gruppen suchen oder auflisten – je Zeile id, Name, Gruppentyp, Status, Treffzeit und Notiz. only_my_groups zeigt nur die der Person hinter dem Login-Token.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchwort im Namen' },
        only_my_groups: { type: 'boolean', description: 'Nur Gruppen, in denen die Person des Login-Tokens ist' },
        limit: { type: 'integer', description: 'Höchstens so viele je Seite (Vorgabe 50, höchstens 200)' },
        page: { type: 'integer', description: 'Seite (ab 1)' },
      },
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      const result = await ct(ctx, 'get', '/groups', { query: { query: args.query, only_my_groups: args.only_my_groups ? true : undefined, limit, page: args.page } });
      if (!result.ok) return fehler(result);
      const gruppen = (Array.isArray(result.data) ? result.data : []).map((g) => ohneLeeres({
        id: g.id, name: g.name, group_type_id: g.information?.groupTypeId, group_status_id: g.information?.groupStatusId,
        meeting_time: g.information?.meetingTime, note: kurz(g.information?.note, 140),
      }));
      return { text: gruppen.length ? `${gruppen.length} Gruppe(n).${seitenHinweis(result.meta)}\n${zeilen(gruppen)}` : 'Keine Gruppe gefunden.' };
    },
  },
  {
    name: 'ct_list_group_members',
    stufe: 'lesen',
    description: 'Die Mitglieder einer Gruppe – je Zeile person_id, Name, Rolle und Status (active, requested, waiting, to_delete).',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Kennung der Gruppe (id aus ct_list_groups)' },
        limit: { type: 'integer', description: 'Höchstens so viele je Seite (Vorgabe 100, höchstens 500)' },
        page: { type: 'integer', description: 'Seite (ab 1)' },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
      const result = await ct(ctx, 'get', `/groups/${args.group_id}/members`, { query: { limit, page: args.page } });
      if (!result.ok) return fehler(result);
      const namen = await rollen(ctx);
      const mitglieder = (Array.isArray(result.data) ? result.data : []).map((m) => ohneLeeres({
        person_id: m.personId ?? zahl(m.person?.domainIdentifier), name: personName(m.person),
        role: namen?.get(m.groupTypeRoleId) ?? m.groupTypeRoleId, status: m.groupMemberStatus, comment: m.comment,
      }));
      return { text: mitglieder.length ? `${mitglieder.length} Mitglied(er).${seitenHinweis(result.meta)}\n${zeilen(mitglieder)}` : 'Diese Gruppe hat keine (sichtbaren) Mitglieder.' };
    },
  },

  // ── Kalender ──
  {
    name: 'ct_list_calendars',
    stufe: 'lesen',
    description: 'Die Kalender, die der Login-Token sieht – je Zeile id, Name und Art (church, group, personal).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LESEND,
    async run(_args, ctx) {
      const result = await ct(ctx, 'get', '/calendars');
      if (!result.ok) return fehler(result);
      const kalender = (Array.isArray(result.data) ? result.data : [])
        .sort((a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0))
        .map((k) => ohneLeeres({ id: k.id, name: k.nameTranslated || k.name, type: k.type, campus_id: k.campusId, event_template_id: k.eventTemplateId }));
      return { text: kalender.length ? `${kalender.length} Kalender:\n${zeilen(kalender)}` : 'Kein Kalender sichtbar.' };
    },
  },
  {
    name: 'ct_list_appointments',
    stufe: 'lesen',
    description:
      'Kalendereinträge in einem Zeitraum, aufsteigend nach Beginn – je Zeile id, Titel, Beginn und Ende (Ortszeit), Kalender, Ort und, '
      + 'wenn es dazu einen Termin in der Dienstplanung gibt, dessen event_id. Ohne Kalender: alle sichtbaren. Ohne Zeitraum: ab heute, 31 Tage.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_ids: { type: 'array', items: { type: 'integer' }, description: 'Nur diese Kalender (ids aus ct_list_calendars)' },
        from: { type: 'string', description: `Frühester ${DATUM} (Vorgabe: heute)` },
        to: { type: 'string', description: `Spätester ${DATUM} (Vorgabe: 31 Tage nach from)` },
        query: { type: 'string', description: 'Suchwort im Titel' },
        limit: { type: 'integer', description: 'Höchstens so viele (Vorgabe 100, höchstens 1000)' },
      },
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const falsch = falschesDatum(args, 'from', 'to');
      if (falsch) return { text: `${falsch} als JJJJ-MM-TT angeben.`, isError: true };
      const zone = ctx.config.zeitzone;
      let ids = args.calendar_ids;
      if (!ids?.length) {
        const kalender = await ct(ctx, 'get', '/calendars');
        if (!kalender.ok) return fehler(kalender, 'Kalender nicht lesbar.');
        ids = (Array.isArray(kalender.data) ? kalender.data : []).map((k) => k.id);
        if (!ids.length) return { text: 'Kein Kalender sichtbar.' };
      }
      const from = args.from ?? tag(zone);
      const result = await ct(ctx, 'get', '/calendars/appointments', {
        query: { 'calendar_ids[]': ids, from, to: args.to ?? plusTage(from, 31), query: args.query, 'include[]': ['event'] },
      });
      if (!result.ok) return fehler(result);
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 1000);
      const alle = (Array.isArray(result.data) ? result.data : []).map((t) => {
        const basis = t.appointment?.base ?? t.base ?? t;
        const berechnet = t.appointment?.calculated ?? t.calculated ?? {};
        const start = berechnet.startDate ?? basis.startDate;
        const a = basis.address;
        const wann = basis.allDay
          ? ganztaegig(basis, berechnet, zone)
          : { start_local: ortszeit(start, zone), end_local: ortszeit(berechnet.endDate ?? basis.endDate, zone) };
        return ohneLeeres({
          id: basis.id,
          title: basis.title ?? basis.caption,
          subtitle: basis.subtitle ?? basis.note,
          start,
          ...wann,
          all_day: basis.allDay || undefined,
          calendar: basis.calendar?.nameTranslated || basis.calendar?.name,
          calendar_id: basis.calendar?.id,
          place: a ? [a.meetingAt ?? a.name, a.street, [a.zip, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') : undefined,
          internal: basis.isInternal || undefined,
          repeats: basis.repeatId ? true : undefined,
          link: basis.link,
          description: kurz(basis.description ?? basis.information, 200),
          event_id: zahl(t.event?.domainIdentifier),
        });
      }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const kopf = alle.length > limit ? `${alle.length} Einträge, die ersten ${limit}:` : `${alle.length} Kalendereintrag/-einträge:`;
      return { text: alle.length ? `${kopf}\n${zeilen(alle.slice(0, limit))}` : 'Keine Kalendereinträge in diesem Zeitraum.' };
    },
  },
  {
    name: 'ct_create_appointment',
    stufe: 'schreiben',
    description:
      'Einen einmaligen Kalendereintrag anlegen. Zeiten als Ortszeit (2026-10-04T10:00) oder mit Versatz bzw. Z; ganztägig mit reinem Datum '
      + '(start und end als JJJJ-MM-TT, end ist der letzte Tag). Mit create_event entsteht dazu der Termin in der Dienstplanung (für Dienste '
      + 'und Ablaufplan), auf Wunsch aus einer Terminvorlage. Serientermine und Raumbuchungen: über ct_api_describe und ct_api_write.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'integer', description: 'Kalender (id aus ct_list_calendars)' },
        title: { type: 'string', description: 'Titel' },
        start: { type: 'string', description: 'Beginn: 2026-10-04T10:00 (Ortszeit), mit Versatz/Z, oder 2026-10-04 für ganztägig' },
        end: { type: 'string', description: 'Ende, in derselben Form wie start (ganztägig: letzter Tag; Vorgabe: derselbe Tag)' },
        subtitle: { type: 'string', description: 'Untertitel' },
        description: { type: 'string', description: 'Beschreibung' },
        link: { type: 'string', description: 'Link, https://…' },
        is_internal: { type: 'boolean', description: 'Nur für Angemeldete sichtbar (Vorgabe false: ein gewöhnlicher Eintrag)' },
        place: {
          type: 'object',
          description: 'Ort des Eintrags',
          properties: {
            name: { type: 'string', description: 'Bezeichnung, z. B. Gemeindehaus' },
            street: { type: 'string' },
            zip: { type: 'string' },
            city: { type: 'string' },
          },
          additionalProperties: false,
        },
        create_event: { type: 'boolean', description: 'Auch den Termin in der Dienstplanung anlegen (nicht bei ganztägig)' },
        event_template_id: { type: 'integer', description: 'Mit create_event: Terminvorlage, aus der Dienste und Vorgaben kommen' },
      },
      required: ['calendar_id', 'title', 'start'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    async run(args, ctx) {
      const zone = ctx.config.zeitzone;
      const ganztags = NUR_DATUM.test(args.start);
      let startDate;
      let endDate;
      if (ganztags) {
        if (args.end !== undefined && !NUR_DATUM.test(args.end)) return { text: 'Ganztägig: end ebenfalls als JJJJ-MM-TT.', isError: true };
        startDate = args.start;
        endDate = args.end ?? args.start;
        if (endDate < startDate) return { text: 'end liegt vor start.', isError: true };
        if (args.create_event) return { text: 'create_event braucht einen Beginn mit Uhrzeit, keinen ganztägigen Eintrag.', isError: true };
      } else {
        if (args.end === undefined) return { text: 'end fehlt (bei einem Eintrag mit Uhrzeit Pflicht).', isError: true };
        startDate = zuZulu(args.start, zone);
        endDate = zuZulu(args.end, zone);
        if (!startDate || !endDate) return { text: 'start und end als 2026-10-04T10:00 (Ortszeit), mit Versatz wie +02:00 oder Z – oder beide als reines Datum.', isError: true };
        if (endDate <= startDate) return { text: 'end muss nach start liegen.', isError: true };
      }
      if (args.event_template_id !== undefined && !args.create_event) return { text: 'event_template_id gilt nur zusammen mit create_event.', isError: true };
      const ort = args.place ? ohneUndefined({ meetingAt: args.place.name, street: args.place.street, zip: args.place.zip, city: args.place.city }) : undefined;

      const result = await ct(ctx, 'post', `/calendars/${args.calendar_id}/appointments`, {
        body: ohneUndefined({
          calendarId: args.calendar_id,
          title: args.title,
          startDate,
          endDate,
          isInternal: args.is_internal ?? false,
          subtitle: args.subtitle,
          description: args.description,
          link: args.link,
          address: ort && Object.keys(ort).length ? ort : undefined,
          events: args.create_event ? [ohneUndefined({ startDate, eventTemplateId: args.event_template_id })] : undefined,
        }),
      });
      if (!result.ok) return fehler(result, 'Kalendereintrag nicht angelegt.');
      const d = result.data ?? {};
      const basis = d.appointment?.base ?? d.base ?? d;
      const wann = ganztags ? `${ortszeit(startDate, zone)}${endDate !== startDate ? ` bis ${ortszeit(endDate, zone)}` : ''}, ganztägig` : `${ortszeit(startDate, zone)} bis ${ortszeit(endDate, zone)}`;
      const dazu = args.create_event ? ' Der Termin in der Dienstplanung ist mit angelegt – seine id zeigt ct_list_events.' : '';
      return { text: `Kalendereintrag „${args.title}“ angelegt (id ${basis.id ?? '?'}), ${wann}.${dazu}` };
    },
  },

  // ── Alles Übrige: die API selbst ──
  {
    name: 'ct_api_search',
    stufe: 'lesen',
    description:
      'In der API-Beschreibung dieses ChurchTools nach Wegen suchen – für alles, wofür es kein eigenes Werkzeug gibt (Abwesenheiten, '
      + 'Raumbuchungen, Wiki, Beiträge, Gruppentreffen, Lieder anlegen …). Die Beschreibung ist englisch: mit englischen Wörtern suchen '
      + '(absence, booking, wiki, meeting). Liefert je Zeile Methode, Pfad und Titel; Einzelheiten dann mit ct_api_describe.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Ein oder mehrere englische Stichwörter; alle müssen vorkommen' } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const spec = await beschreibung(ctx);
      if (!spec) return { text: ctx.zustand.beschreibungFehler ?? 'Die API-Beschreibung ist nicht abrufbar.', isError: true };
      const treffer = doku.suche(spec, args.query, { modus: ctx.config.modus });
      if (!treffer.length) return { text: `Nichts gefunden zu „${args.query}“. Die Beschreibung ist englisch – andere oder weniger Wörter versuchen.` };
      return { text: `${treffer.length} Weg(e) (Pfade relativ zu /api):\n${treffer.map((t) => `${t.methode} ${t.pfad} — ${t.titel}`).join('\n')}` };
    },
  },
  {
    name: 'ct_api_describe',
    stufe: 'lesen',
    description:
      'Einen Weg der ChurchTools-API nachlesen: Parameter, Aufbau des Körpers, Antworten – aus der Beschreibung dieses ChurchTools. Vor '
      + 'ct_api_get und ct_api_write aufrufen, statt Felder zu raten.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Pfad wie in ct_api_search (/persons/{personId}/absences) oder ausgefüllt (/persons/12/absences)' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      // Vorlagen wie /events/{eventId} tragen geschweifte Klammern – für die Prüfung zählen sie als ein Segment
      const geprueft = pfadPruefen(args.path.replace(/\{[^}/]*\}/g, '0'));
      if (geprueft.fehler) return { text: geprueft.fehler, isError: true };
      const grund = verboten('GET', geprueft.segmente, ctx.config.modus);
      if (grund) return { text: grund, isError: true };
      const spec = await beschreibung(ctx);
      if (!spec) return { text: ctx.zustand.beschreibungFehler ?? 'Die API-Beschreibung ist nicht abrufbar.', isError: true };
      const pfad = args.path.trim().replace(/^\/api(?=\/)/, '').replace(/\/+$/, '');
      const text = doku.beschreibe(spec, args.method, pfad.startsWith('/') ? pfad : `/${pfad}`);
      if (!text) return { text: `Den Pfad ${args.path} kennt dieses ChurchTools nicht – mit ct_api_search suchen.`, isError: true };
      return { text: begrenzt(text, 24000, 'Der Körper ist sehr groß; die wichtigsten Felder stehen oben.') };
    },
  },
  {
    name: 'ct_api_get',
    stufe: 'lesen',
    description:
      'Einen beliebigen Weg der ChurchTools-API lesen (GET) – für alles ohne eigenes Werkzeug. path relativ zu /api (z. B. '
      + '/persons/12/absences), Abfragewerte in query (Listen als Liste: {"ids[]": [1, 2]}). Mit fields nur bestimmte Felder je Eintrag – '
      + 'die Antworten von ChurchTools sind sonst sehr lang. Anmeldung, Zugangsdaten, Finanzen und das Systemprotokoll sind gesperrt.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Pfad relativ zu /api, ohne ? – z. B. /wiki/categories' },
        query: { type: 'object', description: 'Abfragewerte, so benannt wie in ct_api_describe (from, to, limit, page, "ids[]" …)' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Nur diese Felder je Eintrag zurückgeben (oberste Ebene), z. B. ["id", "name"]' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: LESEND,
    async run(args, ctx) {
      const geprueft = pfadPruefen(args.path);
      if (geprueft.fehler) return { text: geprueft.fehler, isError: true };
      const grund = verboten('GET', geprueft.segmente, ctx.config.modus);
      if (grund) return { text: grund, isError: true };
      const result = await ct(ctx, 'get', geprueft.pfad, { query: args.query });
      if (!result.ok) return fehler(result);
      const nur = (eintrag) => (args.fields?.length && eintrag && typeof eintrag === 'object' && !Array.isArray(eintrag)
        ? Object.fromEntries(args.fields.filter((f) => f in eintrag).map((f) => [f, eintrag[f]]))
        : eintrag);
      const data = Array.isArray(result.data) ? result.data.map(nur) : nur(result.data);
      const text = json(result.meta ? { data, meta: result.meta } : data ?? null);
      return { text: begrenzt(text, 60000, 'Enger fassen: fields angeben, limit und page nutzen oder genauer filtern.') };
    },
  },
  {
    name: 'ct_api_write',
    stufe: 'schreiben',
    description:
      'Einen beliebigen Weg der ChurchTools-API schreibend aufrufen (POST, PUT, PATCH; DELETE nur, wenn der Server mit --allow-delete läuft) – '
      + 'für alles ohne eigenes Werkzeug. Vorher mit ct_api_describe nachlesen, was der Weg erwartet, und nur auf ausdrückliche Bitte '
      + 'schreiben. Gesperrt bleiben Anmeldung und Zugangsdaten, Finanzen, Rechte, Systemeinstellungen, Automatisierungen und Massenversand.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Pfad relativ zu /api, ohne ? – z. B. /persons/12/absences' },
        query: { type: 'object', description: 'Abfragewerte (selten nötig)' },
        body: { description: 'Der Körper als JSON, so aufgebaut wie in ct_api_describe' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    async run(args, ctx) {
      const geprueft = pfadPruefen(args.path);
      if (geprueft.fehler) return { text: geprueft.fehler, isError: true };
      const grund = verboten(args.method, geprueft.segmente, ctx.config.modus);
      if (grund) return { text: grund, isError: true };
      const result = await ct(ctx, args.method, geprueft.pfad, { query: args.query, body: args.body });
      if (!result.ok) return fehler(result);
      const antwort = result.data === null || result.data === undefined ? '' : `\n${begrenzt(json(result.data), 20000, 'Die Antwort ist lang; das Wesentliche steht oben.')}`;
      return { text: `${args.method} ${geprueft.pfad}: erledigt (HTTP ${result.status}).${antwort}` };
    },
  },
];

/** Die Werkzeuge, die zu einem Modus gehören – was der Server nicht darf, bietet er gar nicht erst an. */
function werkzeugeFuer(modus) {
  return WERKZEUGE.filter((w) => STUFEN[w.stufe] <= STUFEN[modus]);
}

module.exports = { WERKZEUGE, werkzeugeFuer, zuZulu, ortszeit };
