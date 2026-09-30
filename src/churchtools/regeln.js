/**
 * Was der ChurchTools-Server eines Assistenten darf – zusätzlich zu dem, was
 * ChurchTools der Person hinter dem Login-Token ohnehin erlaubt.
 *
 * ChurchTools prüft die Rechte der Person; das ist die eigentliche Grenze.
 * Hier steht der zweite Zaun für Dinge, die ein Assistent nie tun soll, auch
 * wenn der Token es könnte – ein Admin-Token ist schnell eingetragen:
 *
 *  - Zugangsdaten und Anmeldung: nie, in keinem Modus (Login-Tokens anderer
 *    Personen lesen, Passwörter setzen, sich als jemand ausgeben).
 *  - Finanzen und das Systemprotokoll: gar nicht.
 *  - Rechte, Systemeinstellungen, Automatisierungen, Massenversand: nur lesen.
 *  - Zustimmungen (Datenschutzerklärung, Verschwiegenheit): nie für jemanden schreiben.
 *  - Löschen – und was dem gleichkommt (Personen zusammenführen) – nur, wenn
 *    der Server ausdrücklich mit `--allow-delete` gestartet wurde.
 *
 * Geprüft wird der Pfad, nicht die Absicht: jedes Segment zählt, an jeder Stelle.
 */

/** Die drei Betriebsarten, aufsteigend: jede schließt die vorige ein. */
const STUFEN = { lesen: 0, schreiben: 1, loeschen: 2 };

// Segmente, die nie gehen – gleich mit welcher Methode und an welcher Stelle im Pfad
const ZUGANGSDATEN = new Set([
  'login', 'logout', 'logintoken', 'loginstring', 'password', 'reset-password', 'twofactor', 'totp',
  'oauthclients', 'externallogins', 'external-logins', 'saml', 'sso-logins', 'csrftoken', 'simulate', 'devices', 'captcha',
]);
// Bereiche (erstes Segment), die ganz außen vor bleiben
const GESPERRTE_BEREICHE = new Set(['finance', 'logs']);
// Bereiche (erstes Segment), in denen nur gelesen wird
const NUR_LESEN = new Set([
  'permissions', 'securitylevels', 'config', 'sync', 'license', 'dbfields', 'dbfieldtypes', 'routines',
  'queues', 'jobs', 'bulkjobs', 'bulkletters', 'registrationconfig', 'dynamicgroups', 'translations',
  'profiles', 'evangelischetermine',
]);
// Segmente, an denen nie geschrieben wird, gleich wo: Zustimmungen gibt eine Person selbst, kein Assistent für sie
const NIE_SCHREIBEN = new Set(['privacypolicy', 'confidentialityagreement']);
// Segmente, die wie Löschen zählen, obwohl die Methode POST ist
const WIE_LOESCHEN = new Set(['merge']);

/**
 * Einen Pfad aus der Eingabe eines Assistenten in die Form bringen, die an
 * `/api` gehängt wird – oder sagen, was daran nicht geht. Es ist immer ein
 * Pfad auf dem eingerichteten ChurchTools, nie eine ganze Adresse.
 *
 * @returns {{pfad: string, segmente: string[]} | {fehler: string}}
 */
function pfadPruefen(roh) {
  let pfad = String(roh ?? '').trim();
  if (!pfad) return { fehler: 'path fehlt' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(pfad) || pfad.startsWith('//')) return { fehler: 'path ist ein Pfad auf dem eingerichteten ChurchTools (z. B. /events/12), keine ganze Adresse' };
  if (/[?#]/.test(pfad)) return { fehler: 'path ohne ? und # – Abfragewerte gehören in query' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(pfad)) return { fehler: 'path enthält Leerzeichen, Steuerzeichen oder einen Rückstrich' };
  // Verschlüsselte Schrägstriche und Punkte könnten an der Prüfung der Segmente vorbeiführen
  if (/%(2e|2f|5c|25)/i.test(pfad)) return { fehler: 'path enthält einen verschlüsselten Punkt, Schrägstrich oder Rückstrich' };
  if (!pfad.startsWith('/')) pfad = `/${pfad}`;
  pfad = pfad.replace(/\/+$/, '');
  // Beide Schreibweisen gehen: /api/events und /events
  if (pfad === '/api' || pfad.startsWith('/api/')) pfad = pfad.slice(4);
  if (!pfad) return { fehler: 'path fehlt (z. B. /events)' };
  const roheSegmente = pfad.split('/').slice(1);
  if (roheSegmente.some((s) => s === '' || s === '.' || s === '..')) return { fehler: 'path enthält leere Segmente, „.“ oder „..“' };
  let segmente;
  try {
    segmente = roheSegmente.map((s) => decodeURIComponent(s).toLowerCase());
  } catch {
    return { fehler: 'path ist nicht sauber verschlüsselt' };
  }
  return { pfad, segmente };
}

/**
 * Darf diese Methode auf diesem Pfad in diesem Modus laufen?
 *
 * @param {string} methode   GET, POST, PUT, PATCH oder DELETE
 * @param {string[]} segmente die Segmente aus `pfadPruefen`
 * @param {'lesen'|'schreiben'|'loeschen'} modus
 * @returns {string|null} der Grund, warum nicht – oder null
 */
function verboten(methode, segmente, modus) {
  const m = methode.toUpperCase();
  const gesperrt = segmente.find((s) => ZUGANGSDATEN.has(s));
  if (gesperrt) return `„${gesperrt}“ gehört zu Anmeldung und Zugangsdaten – das bleibt für Assistenten gesperrt`;
  if (GESPERRTE_BEREICHE.has(segmente[0])) return `Der Bereich „${segmente[0]}“ bleibt für Assistenten gesperrt`;
  if (m === 'GET') return null;

  if (STUFEN[modus] < STUFEN.schreiben) return 'Der Server läuft nur lesend (--read-only)';
  if (NUR_LESEN.has(segmente[0])) return `Im Bereich „${segmente[0]}“ (Rechte, Einstellungen, Automatisierungen, Massenversand) wird nur gelesen`;
  const zustimmung = segmente.find((s) => NIE_SCHREIBEN.has(s));
  if (zustimmung) return `„${zustimmung}“ ist eine Zustimmung, die eine Person selbst gibt – ein Assistent schreibt sie nicht`;
  const wieLoeschen = m === 'DELETE' || segmente.some((s) => WIE_LOESCHEN.has(s));
  if (wieLoeschen && STUFEN[modus] < STUFEN.loeschen) return 'Löschen ist nur möglich, wenn der Server mit --allow-delete gestartet wurde';
  return null;
}

/** Darf ein Server in diesem Modus den Weg aufrufen? Für die Suche in der API-Beschreibung (Pfade als Vorlage, `/events/{eventId}`). */
function erreichbar(methode, pfad, modus = 'loeschen') {
  const geprueft = pfadPruefen(pfad.replace(/\{[^}/]*\}/g, '0'));
  return !geprueft.fehler && verboten(methode, geprueft.segmente, modus) === null;
}

module.exports = { STUFEN, pfadPruefen, verboten, erreichbar };
