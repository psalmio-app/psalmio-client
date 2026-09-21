/**
 * psalmio-client – Aufnahmen und Startzeitpunkte nach Psalmio bringen.
 *
 * Siehe README.md; die Schnittstelle selbst beschreibt docs/API.md.
 */
module.exports = {
  ...require('./address'),
  ...require('./api'),
  ...require('./put'),
  ...require('./recording'),
};
