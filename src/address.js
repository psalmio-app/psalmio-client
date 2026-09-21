/**
 * Wohin der API-Key gehen darf.
 *
 * Der Key reist bei jedem Aufruf als Header mit – die Adresse entscheidet also,
 * bei wem er ankommt. Alles hier dient dazu, dass er nur bei der Gemeinde
 * landet, für die er ausgestellt wurde.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Nimmt „gemeinde.psalmio.de" ebenso wie eine ganze Adresse und gibt sie ohne
 * Schrägstrich am Ende zurück. Was sich nicht lesen lässt, kommt zurück wie
 * eingegeben – damit `validateBaseUrl` sagen kann, was daran falsch ist.
 */
function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * Ist das eine Adresse, an die der API-Key gehen darf?
 *
 * Nur https – über http ginge er im Klartext über die Leitung –, mit einer
 * Ausnahme für ein Psalmio auf demselben Rechner während der Entwicklung. Kein
 * benutzer:passwort@, kein Pfad: Die Adresse ist der Host der Gemeinde.
 *
 * @returns {string|null} eine Fehlermeldung, oder null, wenn alles stimmt
 */
function validateBaseUrl(url) {
  if (!url) return null; // leer = „nicht eingerichtet", erlaubt
  // Ein einzelnes „?" oder „#" lässt parsed.search/hash leer – und trüge dann
  // den API-Pfad in die Abfrage. Deshalb am rohen Text prüfen.
  if (/[?#]/.test(url)) return 'Nur die Adresse der Gemeinde eintragen, ohne ? oder #';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Adresse sieht nicht wie https://gemeinde.psalmio.de aus';
  }
  if (parsed.username || parsed.password) return 'Die Adresse darf keinen Benutzernamen oder kein Passwort enthalten';
  if (parsed.pathname && parsed.pathname !== '/') return 'Nur die Adresse der Gemeinde eintragen, ohne weiteren Pfad (https://gemeinde.psalmio.de)';
  if (parsed.search || parsed.hash) return 'Nur die Adresse der Gemeinde eintragen, ohne ? oder #';
  if (parsed.protocol === 'https:') {
    return parsed.hostname.includes('.') || LOCAL_HOSTS.has(parsed.hostname)
      ? null
      : 'Adresse sieht nicht wie https://gemeinde.psalmio.de aus';
  }
  if (parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)) return null;
  return 'Nur https-Adressen — sonst ginge der API-Key unverschlüsselt über die Leitung';
}

/** Darf an diese (vom Server gelieferte) Upload-Adresse hochgeladen werden? */
function isAllowedUploadTarget(target) {
  return target.protocol === 'https:' || (target.protocol === 'http:' && LOCAL_HOSTS.has(target.hostname));
}

/**
 * Mit welcher Adresse und welchem Key ein Verbindungstest laufen darf.
 *
 * Für Oberflächen, in denen jemand Adresse und Key eintippt: Ein leeres
 * Key-Feld heißt „den gespeicherten nehmen". Das darf sich nie mit einer
 * ANDEREN Adresse verbinden – ein Tippfehler in der Adresse schickte den
 * gespeicherten Key sonst an den, dem der Tippfehler gehört. Eine neue Adresse
 * wird mit einem eigens eingegebenen Key getestet, oder gar nicht.
 *
 * @returns {{ config: { baseUrl: string, apiKey: string } } | { error: string }}
 */
function resolveTestConfig(stored, typed) {
  const typedUrl = normalizeBaseUrl(typed?.baseUrl);
  const typedKey = String(typed?.apiKey ?? '').trim();
  const baseUrl = typedUrl || stored?.baseUrl || '';
  const invalid = validateBaseUrl(baseUrl);
  if (invalid) return { error: invalid };
  if (typedKey) return { config: { baseUrl, apiKey: typedKey } };
  if (typedUrl && typedUrl !== stored?.baseUrl) {
    return { error: 'Für eine neue Adresse bitte den API-Key mit eingeben — der gespeicherte Key geht nur an die gespeicherte Adresse' };
  }
  return { config: { baseUrl, apiKey: stored?.apiKey || '' } };
}

module.exports = { normalizeBaseUrl, validateBaseUrl, isAllowedUploadTarget, resolveTestConfig };
