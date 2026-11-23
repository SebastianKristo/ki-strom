'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');

const oslo = (aar, mnd, dag, time = 0, min = 0) => kal.osloTilUtc(aar, mnd, dag, time, min);

test('lokale datodeler følger sommertid og vintertid', () => {
  assert.deepEqual(kal.osloDeler(Date.UTC(2026, 0, 15, 11, 0)), { aar: 2026, mnd: 1, dag: 15, time: 12, minutt: 0, sekund: 0, ukedag: 3 });
  assert.equal(kal.osloDeler(Date.UTC(2026, 6, 15, 11, 0)).time, 13);
  assert.equal(new Date(oslo(2026, 7, 1)).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.equal(new Date(oslo(2026, 1, 1)).toISOString(), '2025-12-31T23:00:00.000Z');
});

test('måneder med klokkestilling har 743 og 745 timer', () => {
  const timer = (aar, mnd) => { const [a, b] = kal.maanedsvindu(oslo(aar, mnd, 10)); return (b - a) / 3600000; };
  assert.equal(timer(2026, 3), 743);
  assert.equal(timer(2026, 10), 745);
  assert.equal(timer(2026, 11), 720);
  assert.equal(kal.forloptAndelAvMaaned(oslo(2026, 11, 16)), 0.5);
});

test('påske og bevegelige helligdager', () => {
  assert.deepEqual(kal.paaske(2026), [4, 5]);
  assert.deepEqual(kal.paaske(2027), [3, 28]);
  const h = kal.bevegeligeHelligdager(2026);
  for (const d of ['2026-04-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-05-14', '2026-05-24', '2026-05-25']) assert.ok(h.has(d), d);
  assert.ok(kal.erHelligdag('2026-05-17'));
  assert.ok(!kal.erHelligdag('2026-12-24'));
  assert.ok(kal.erHelligdag('2026-12-24', ['12-24']));
});

test('dagtariff: hverdager 06–22, ikke helg og helligdag', () => {
  assert.equal(kal.erDagtariff(oslo(2026, 11, 23, 5, 59)), false);   // mandag
  assert.equal(kal.erDagtariff(oslo(2026, 11, 23, 6, 0)), true);
  assert.equal(kal.erDagtariff(oslo(2026, 11, 23, 21, 59)), true);
  assert.equal(kal.erDagtariff(oslo(2026, 11, 23, 22, 0)), false);
  assert.equal(kal.erDagtariff(oslo(2026, 11, 21, 12, 0)), false);   // lørdag
  assert.equal(kal.erDagtariff(oslo(2026, 12, 25, 12, 0)), false);   // 1. juledag, fredag
  assert.equal(kal.erDagtariff(oslo(2026, 11, 21, 12, 0), { helg_som_natt: false }), true);
  assert.equal(kal.erDagtariff(oslo(2026, 12, 24, 12, 0), { helligdager_ekstra: ['12-24'] }), false);
});

test('ukestart er mandagen', () => {
  assert.equal(kal.ukestart('2026-11-23'), '2026-11-23');
  assert.equal(kal.ukestart('2026-11-29'), '2026-11-23');
  assert.equal(kal.ukestart('2026-12-01'), '2026-11-30');
});
