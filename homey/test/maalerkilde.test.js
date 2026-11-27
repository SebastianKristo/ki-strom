'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { velgKilde, rangerRegister } = require('../lib/maalerkilde');
const { Stromkalkulator } = require('../lib/stromkalkulator');
const tariffer = require('../lib/tariffer.json');

const TIME = 3600000;

test('registeret brukes når det rører seg; står det stille mens huset bruker strøm, regnes det fra effekten', () => {
  const naa = 100 * TIME;
  assert.deepEqual(velgKilde({ harRegister: true, energi: 1234, energiEndretMs: naa - 10 * 60000, effekt: 2000, naa }), { kilde: 'register', stille: false });
  assert.deepEqual(velgKilde({ harRegister: true, energi: 1234, energiEndretMs: naa - 3 * TIME, effekt: 2000, naa }), { kilde: 'effekt', stille: true });
  // Stille register og nesten ikke forbruk (bortreist): registeret har rett
  assert.equal(velgKilde({ harRegister: true, energi: 1234, energiEndretMs: naa - 30 * TIME, effekt: 40, naa }).kilde, 'register');
  // Uten effektmåling er registeret alt vi har
  assert.equal(velgKilde({ harRegister: true, energi: 1234, energiEndretMs: naa - 30 * TIME, effekt: null, naa }).kilde, 'register');
  // Ikke noe register valgt, eller ingen verdi fra det
  assert.equal(velgKilde({ harRegister: false, energi: null, energiEndretMs: null, effekt: 900, naa }).kilde, 'effekt');
  assert.equal(velgKilde({ harRegister: true, energi: null, energiEndretMs: null, effekt: 900, naa }).kilde, 'effekt');
  assert.equal(velgKilde({ harRegister: true, energi: null, energiEndretMs: null, effekt: null, naa }).kilde, 'ingen');
});

test('importert energi foreslås før eksport og delregistre', () => {
  const sortert = ['meter_power.exported', 'meter_power.peak', 'meter_power', 'meter_power.imported'].sort((a, b) => rangerRegister(a) - rangerRegister(b));
  assert.deepEqual(sortert, ['meter_power.imported', 'meter_power', 'meter_power.peak', 'meter_power.exported']);
});

test('bytte av kilde gir ikke falskt forbruk: nytt nullpunkt, og timen byttet skjer i får ingen topp', () => {
  const k = new Stromkalkulator({}, { nettselskap: 'elvia' }, tariffer);
  const start = kal.osloTilUtc(2026, 11, 26, 10, 0);
  // Et register på 0 som står stille (eksport valgt ved en feil)
  for (let n = 0; n <= 150; n++) k.energi(start + n * 60000, 0, null);
  assert.equal(k.snapshot(start + 150 * 60000, null).maaned.kwh, 0);
  // Appen oppdager det og regner fra effekten: 3 kW
  k.byttKilde(start + 150 * 60000);
  for (let n = 151; n <= 300; n++) k.effekt(start + n * 60000, 3000, null);
  const s = k.snapshot(start + 300 * 60000, null);
  assert.ok(Math.abs(s.maaned.kwh - 3 * (149 / 60)) < 0.06, `kWh: ${s.maaned.kwh}`);
  // Timen 12–13 (byttet skjedde 12:30) gir ingen topp; timen 13–14 gir 3 kW
  assert.deepEqual(s.nettleie.topper.map((t) => t.kw), [3]);
  // Så velger du riktig register (12 345 kWh): tilbake til registeret uten at 12 345 kWh bokføres
  k.byttKilde(start + 300 * 60000);
  for (let n = 301; n <= 360; n++) k.energi(start + n * 60000, 12345 + (n - 301) * 0.05, null);
  const s2 = k.snapshot(start + 360 * 60000, null);
  assert.ok(s2.maaned.kwh < 12 && s2.maaned.kwh > 9, `kWh etter bytte tilbake: ${s2.maaned.kwh}`);
  assert.ok(Math.max(...s2.nettleie.topper.map((t) => t.kw)) < 4);
});
