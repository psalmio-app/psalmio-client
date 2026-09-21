/**
 * Wohin der API-Key gehen darf.
 *
 * Übernommen aus der Workflow Engine der MBG Lemgo (Tim Fast), wo diese Regeln
 * entstanden sind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src');

// ─── Wohin der Schlüssel darf ───

test('Adresse: https der Gemeinde ist in Ordnung', () => {
  assert.equal(client.validateBaseUrl('https://gemeinde.psalmio.de'), null);
  assert.equal(client.validateBaseUrl(''), null, 'leer = nicht eingerichtet');
});

test('Adresse: http nur für localhost (Entwicklung), sonst nie', () => {
  assert.match(client.validateBaseUrl('http://gemeinde.psalmio.de'), /https/);
  assert.equal(client.validateBaseUrl('http://localhost:8000'), null);
  assert.equal(client.validateBaseUrl('http://127.0.0.1:8000'), null);
});

test('Adresse: ein einzelnes „?“ oder „#“ am Ende wird abgelehnt (der API-Pfad landete sonst in der Abfrage)', () => {
  assert.ok(client.validateBaseUrl('https://gemeinde.psalmio.de?'));
  assert.ok(client.validateBaseUrl('https://gemeinde.psalmio.de#'));
});


test('Adresse: kein Benutzername, kein Pfad, kein Kauderwelsch', () => {
  assert.match(client.validateBaseUrl('https://user:pass@gemeinde.psalmio.de'), /Benutzernamen/);
  assert.match(client.validateBaseUrl('https://gemeinde.psalmio.de/admin'), /Pfad/);
  assert.match(client.validateBaseUrl('https://gemeinde.psalmio.de/?x=1'), /\?/);
  assert.ok(client.validateBaseUrl('https://nurwort'));
  assert.ok(client.validateBaseUrl('ftp://gemeinde.psalmio.de'));
});

const STORED = { baseUrl: 'https://gemeinde.psalmio.de', apiKey: 'sk-gespeichert' };

test('Verbindungstest: leere Felder → gespeicherte Adresse mit gespeichertem Key', () => {
  assert.deepEqual(client.resolveTestConfig(STORED, {}), { config: { baseUrl: STORED.baseUrl, apiKey: 'sk-gespeichert' } });
});

test('Verbindungstest: dieselbe Adresse neu eingetippt → gespeicherter Key ist in Ordnung', () => {
  assert.equal(client.resolveTestConfig(STORED, { baseUrl: 'gemeinde.psalmio.de/' }).config.apiKey, 'sk-gespeichert');
});

test('Verbindungstest: NEUE Adresse ohne neuen Key → der gespeicherte Key geht NICHT dorthin', () => {
  // Ein Tippfehler reicht: „gemeinde.psalmlo.de“ gehört jemand anderem.
  const outcome = client.resolveTestConfig(STORED, { baseUrl: 'https://gemeinde.psalmlo.de' });
  assert.ok(outcome.error);
  assert.equal(outcome.config, undefined);
});

test('Verbindungstest: neue Adresse mit eigenem Key → erlaubt', () => {
  assert.deepEqual(
    client.resolveTestConfig(STORED, { baseUrl: 'https://andere.psalmio.de', apiKey: ' sk-neu ' }),
    { config: { baseUrl: 'https://andere.psalmio.de', apiKey: 'sk-neu' } },
  );
});

test('Verbindungstest: http-Adresse wird gar nicht erst gefragt', () => {
  assert.ok(client.resolveTestConfig(STORED, { baseUrl: 'http://gemeinde.psalmio.de', apiKey: 'sk-neu' }).error);
});
