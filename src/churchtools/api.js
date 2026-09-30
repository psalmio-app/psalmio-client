/**
 * Die Aufrufe gegen die REST-API eines ChurchTools (`https://<gemeinde>.church.tools/api`).
 *
 * Wie bei den Aufrufen gegen Psalmio gilt: NICHTS wirft. Jeder Aufruf sagt
 * ehrlich, ob es geklappt hat (`ok`), und wenn nicht, mit der Meldung von
 * ChurchTools selbst – ein Assistent soll darauf reagieren können, statt zu
 * raten.
 *
 * Angemeldet wird mit dem Login-Token einer Person (`Authorization: Login <token>`).
 * Alles geschieht mit den Rechten genau dieser Person – was sie in ChurchTools
 * nicht darf, darf auch kein Aufruf hier. Der Token reist bei jedem Aufruf als
 * Header mit; die Adresse entscheidet also, bei wem er ankommt. Deshalb nur
 * https, keine Umleitung, und nie ein anderer Host als der eingerichtete.
 */

const TIMEOUT_MS = 30000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Bremst ChurchTools (429), lohnt ein zweiter Versuch – die Anfrage wurde nicht bearbeitet
const VERSUCHE_BEI_429 = 3;
const WARTEN_HOECHSTENS_MS = 15000;

/**
 * Ist das eine Adresse, an die der Login-Token gehen darf?
 *
 * Nur https (http allein für ein ChurchTools auf demselben Rechner), kein
 * benutzer:passwort@, kein ? oder #. Ein Pfad ist erlaubt: Selbst betriebene
 * ChurchTools liegen manchmal unter `https://gemeinde.de/churchtools`.
 *
 * @returns {string|null} eine Fehlermeldung, oder null, wenn alles stimmt
 */
function pruefeAdresse(url) {
  if (!url) return 'Die Adresse des ChurchTools fehlt (https://gemeinde.church.tools)';
  if (/[?#]/.test(url)) return 'Nur die Adresse des ChurchTools eintragen, ohne ? oder #';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Adresse sieht nicht wie https://gemeinde.church.tools aus';
  }
  if (parsed.username || parsed.password) return 'Die Adresse darf keinen Benutzernamen oder kein Passwort enthalten';
  if (/\/api\/?$/.test(parsed.pathname)) return 'Die Adresse ohne /api am Ende eintragen (https://gemeinde.church.tools)';
  if (parsed.protocol === 'https:') {
    return parsed.hostname.includes('.') || LOCAL_HOSTS.has(parsed.hostname) ? null : 'Adresse sieht nicht wie https://gemeinde.church.tools aus';
  }
  if (parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)) return null;
  return 'Nur https-Adressen – sonst ginge der Login-Token unverschlüsselt über die Leitung';
}

/** Adresse und Token da? Eine Hälfte allein nützt nichts. */
function istEingerichtet(config) {
  return Boolean(config?.baseUrl && config?.token);
}

/**
 * Die Abfrage hinter dem `?`. Listen werden wiederholt (`ids[]=1&ids[]=2`), so
 * wie ChurchTools sie liest; der Name bleibt, wie er angegeben ist – mit oder
 * ohne `[]`, je nachdem, wie die API-Beschreibung den Parameter nennt. Leeres
 * (undefined, null, '') fällt weg.
 */
function abfrageText(query) {
  const teile = [];
  for (const [name, wert] of Object.entries(query ?? {})) {
    for (const einzel of Array.isArray(wert) ? wert : [wert]) {
      if (einzel === undefined || einzel === null || einzel === '') continue;
      const text = typeof einzel === 'object' ? JSON.stringify(einzel) : String(einzel);
      teile.push(`${encodeURIComponent(name)}=${encodeURIComponent(text)}`);
    }
  }
  return teile.length ? `?${teile.join('&')}` : '';
}

/** Die Meldung von ChurchTools – am liebsten die übersetzte, mit den Einzelfehlern je Feld. */
function fehlertext(antwort, status) {
  const haupt = antwort?.translatedMessage || antwort?.message || (typeof antwort?.error === 'string' ? antwort.error : '') || `HTTP ${status}`;
  const einzeln = (Array.isArray(antwort?.errors) ? antwort.errors : [])
    .map((e) => [e?.fieldId, e?.translatedMessage || e?.message].filter(Boolean).join(': '))
    .filter(Boolean);
  return einzeln.length ? `${haupt} (${einzeln.join('; ')})` : haupt;
}

const schlafen = (ms) => new Promise((fertig) => { setTimeout(fertig, ms); });

/**
 * Ein Aufruf gegen die ChurchTools-API. `path` beginnt mit `/` und steht
 * relativ zu `/api` (`/events/12/agenda`).
 *
 * @param {{baseUrl: string, token: string}} config
 * @param {string} method
 * @param {string} path
 * @param {{query?: object, body?: any}} [anfrage]
 * @param {{fetch?: typeof fetch, timeoutMs?: number, sleep?: (ms: number) => Promise<void>}} [deps]
 * @returns {Promise<{ok: boolean, status?: number, data?: any, meta?: object, error?: string, messageKey?: string}>}
 */
async function request(config, method, path, { query, body } = {}, deps = {}) {
  if (!istEingerichtet(config)) return { ok: false, error: 'ChurchTools ist nicht eingerichtet (Adresse oder Login-Token fehlt).' };
  // Schützt auch Adressen, die jemand an der Prüfung beim Start vorbei in die Konfiguration gesetzt hat
  const ungueltig = pruefeAdresse(config.baseUrl);
  if (ungueltig) return { ok: false, error: ungueltig };

  const doFetch = deps.fetch || fetch;
  const warten = deps.sleep || schlafen;
  const url = `${config.baseUrl}/api${path}${abfrageText(query)}`;
  try {
    for (let versuch = 1; ; versuch += 1) {
      const response = await doFetch(url, {
        method: method.toUpperCase(),
        headers: {
          Authorization: `Login ${config.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Eine API leitet nicht um. Einer Umleitung zu folgen trüge den Token
        // zum neuen Host – ein 3xx ist deshalb eine Antwort, die wir melden.
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs || TIMEOUT_MS),
      });

      if (response.status === 429 && versuch < VERSUCHE_BEI_429) {
        const sekunden = Number(response.headers.get('retry-after'));
        await warten(Math.min(Number.isFinite(sekunden) && sekunden > 0 ? sekunden * 1000 : 2000 * versuch, WARTEN_HOECHSTENS_MS));
        continue;
      }

      const roh = await response.text();
      let antwort = null;
      let lesbar = true;
      if (roh) {
        try {
          antwort = JSON.parse(roh);
        } catch {
          lesbar = false; // HTML-Seite einer falschen Adresse oder eines Proxys
        }
      }

      if (response.status >= 200 && response.status < 300) {
        if (!lesbar) return { ok: false, status: response.status, error: 'Die Antwort ist kein JSON – zeigt die Adresse wirklich auf ein ChurchTools?' };
        const mitHuelle = antwort !== null && typeof antwort === 'object' && !Array.isArray(antwort) && 'data' in antwort;
        return { ok: true, status: response.status, data: mitHuelle ? antwort.data : antwort, meta: mitHuelle ? antwort.meta : undefined };
      }
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, status: response.status, error: `ChurchTools leitet um (HTTP ${response.status}) – der Umleitung wird nicht gefolgt. Adresse prüfen.` };
      }
      return { ok: false, status: response.status, error: fehlertext(antwort, response.status), messageKey: antwort?.messageKey };
    }
  } catch (err) {
    // Netz, Zeitlimit, ChurchTools nicht erreichbar. Die Adresse enthält kein
    // Geheimnis (der Token ist ein Header), err.message darf also weitergegeben werden.
    return { ok: false, error: `ChurchTools nicht erreichbar: ${err.message}` };
  }
}

module.exports = { pruefeAdresse, istEingerichtet, abfrageText, request, TIMEOUT_MS };
