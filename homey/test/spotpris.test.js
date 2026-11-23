'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Spotpriser, adresse, tolk, hentManglende } = require('../lib/spotpris');

const TIME = 3600000;

/** Et døgn slik API-et leverer det, med `per` intervaller per time. */
function doegn(dato, per = 1, pris = (t) => 0.5 + t / 100) {
  const [aar, mnd, dag] = dato.split('-').map(Number);
  const start = kal.osloTilUtc(aar, mnd, dag);
  const ut = [];
  for (let n = 0; n < 24 * per; n++) {
    const a = start + (n * TIME) / per;
    ut.push({ NOK_per_kWh: pris(n / per), EUR_per_kWh: 0.05, EXR: 11.5, time_start: new Date(a).toISOString(), time_end: new Date(a + TIME / per).toISOString() });
  }
  return ut;
}

test('adressen følger API-ets format', () => {
  assert.equal(adresse('2026-11-23', 'NO1'), 'https://www.hvakosterstrommen.no/api/v1/prices/2026/11-23_NO1.json');
});

test('timepriser og kvarterspriser tolkes likt, og søppel hoppes over', () => {
  assert.equal(tolk(doegn('2026-11-23')).length, 24);
  assert.equal(tolk(doegn('2026-11-23', 4)).length, 96);
  assert.deepEqual(tolk([{ NOK_per_kWh: 'x', time_start: 'tull' }, null]), []);
  assert.deepEqual(tolk({ feil: true }), []);
});

test('pris på et tidspunkt, og snitt over en time med kvarterspriser', () => {
  const s = new Spotpriser();
  s.leggTil(tolk(doegn('2026-11-23', 4, (t) => (t % 1 === 0 ? 0.1 : 1.0))));   // billig første kvarter
  const kl12 = kal.osloTilUtc(2026, 11, 23, 12);
  assert.equal(s.prisVed(kl12), 0.1);
  assert.equal(s.prisVed(kl12 + 20 * 60000), 1.0);
  assert.ok(Math.abs(s.snitt(kl12, kl12 + TIME) - 0.775) < 1e-9);
  assert.equal(s.snitt(kl12 + 24 * TIME, kl12 + 25 * TIME), null);          // ingen priser der
  assert.equal(s.prisVed(kl12 + 24 * TIME), null);
  assert.equal(s.timepriser(kl12, 48).length, 12);
});

test('henter i dag, og i morgen først etter kl. 13 — og ikke det vi alt har', async () => {
  const hentet = [];
  const hent = async (url) => {
    hentet.push(url);
    const dato = `2026-${url.match(/(\d\d-\d\d)_/)[1]}`;
    if (dato === '2026-11-25') return { ok: false, status: 404 };
    return { ok: true, json: async () => doegn(dato) };
  };
  const s = new Spotpriser();
  assert.equal(await hentManglende(s, 'NO1', kal.osloTilUtc(2026, 11, 23, 9), hent), 24);
  assert.equal(hentet.length, 1);
  assert.equal(await hentManglende(s, 'NO1', kal.osloTilUtc(2026, 11, 23, 14), hent), 24);
  assert.deepEqual(hentet.map((u) => u.slice(-14, -9)), ['11-23', '11-24']);
  assert.equal(await hentManglende(s, 'NO1', kal.osloTilUtc(2026, 11, 23, 15), hent), 0);
  assert.equal(hentet.length, 2);
  // morgendagen er ikke publisert ennå: ingen feil, ingen priser
  assert.equal(await hentManglende(s, 'NO1', kal.osloTilUtc(2026, 11, 24, 14), hent), 0);
});

test('gamle priser ryddes, nye erstatter samme tidspunkt', () => {
  const s = new Spotpriser();
  s.leggTil([{ start: 0, slutt: TIME, pris: 1 }, { start: TIME, slutt: 2 * TIME, pris: 2 }]);
  s.leggTil([{ start: TIME, slutt: 2 * TIME, pris: 3 }]);
  assert.equal(s.intervaller.length, 2);
  assert.equal(s.prisVed(TIME), 3);
  s.rydd(TIME + 1);
  assert.equal(s.intervaller.length, 1);
});
