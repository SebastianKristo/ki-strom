'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Lading, trinnKw, velgTrinn } = require('../lib/lading');
const { Lys } = require('../lib/lys');

const MIN = 60000;
const NAA = kal.osloTilUtc(2026, 11, 23, 20, 0);
const KOBLET = { bryter: { enhet: 'lader', kap: 'onoff' }, strom: { enhet: 'lader', kap: 'target_current' }, trinn: [5, 10, 16, 18] };
const lag = (innst = {}, tilstand = {}) => new Lading(tilstand, { ...KOBLET, ...innst });

// ----------------------------------------------------------------------
//  Lading
// ----------------------------------------------------------------------
test('trinnets effekt: enfase, trefase på 230 V og 400 V, og målt verdi', () => {
  assert.equal(trinnKw(16), 3.68);
  assert.equal(trinnKw(16, 3, 230), 6.37);
  assert.equal(trinnKw(16, 3, 400), 11.09);
  assert.equal(trinnKw(16, 1, 230, { 16: 3.5 }), 3.5);
  assert.equal(velgTrinn(4.0, [5, 10, 16, 18], 1, 230), 16);
  assert.equal(velgTrinn(1.0, [5, 10, 16, 18], 1, 230), null);
});

test('starter på høyeste trinn som får plass, og lader ikke uten plass', () => {
  const l = lag();
  const v = l.vurder({ ms: NAA, ledigKw: 4.0, pa: false });
  assert.deepEqual([v.handling, v.trinn, v.kw], ['start', 16, 3.68]);
  assert.equal(l.vurder({ ms: NAA, ledigKw: 1.0, pa: false }).handling, 'av');
  assert.equal(lag({ strom: null }).vurder({ ms: NAA, ledigKw: 9, pa: false }).handling, 'ingen');
  assert.equal(lag({ automatikk: false }).vurder({ ms: NAA, ledigKw: 9, pa: true, maaltKw: 3 }).handling, 'manuell');
  assert.equal(l.vurder({ ms: NAA, ledigKw: 9, pa: null }).handling, 'utilgjengelig');
  assert.equal(l.vurder({ ms: NAA, ledigKw: 9, pa: false, tilkoblet: false }).handling, 'borte');
});

test('holder trinnet mens plassen er der, går ned når huset trenger effekten, og stopper til slutt', () => {
  const l = lag({}, { satt_trinn: 16, sist_endret: NAA - 20 * MIN });
  // «ledig» er hele plassen bilen kan bruke. 4,0 kW: 16 A (3,68) får fortsatt plass
  assert.equal(l.vurder({ ms: NAA, ledigKw: 4.0, pa: true, maaltKw: 3.68 }).handling, 'hold');
  const ned = l.vurder({ ms: NAA, ledigKw: 2.5, pa: true, maaltKw: 3.68 });
  assert.deepEqual([ned.handling, ned.trinn], ['endre', 10]);
  // ikke engang 5 A (1,15 kW) får plass → stopp
  assert.equal(l.vurder({ ms: NAA, ledigKw: 0.7, pa: true, maaltKw: 3.68 }).handling, 'stopp');
});

test('ned går straks, opp venter på dødbånd og minsteavstand', () => {
  const nylig = lag({}, { satt_trinn: 18, sist_endret: NAA - MIN });
  assert.deepEqual([nylig.vurder({ ms: NAA, ledigKw: 3.9, pa: true, maaltKw: 4.14 }).trinn], [16]);     // rett etter forrige endring
  const l = lag({}, { satt_trinn: 16, sist_endret: NAA - 20 * MIN });
  // 16 → 18 A er bare 0,46 kW: ikke verdt et avbrudd
  const lite = l.vurder({ ms: NAA, ledigKw: 4.2, pa: true, maaltKw: 3.68 });
  assert.deepEqual([lite.handling, lite.trinn], ['hold', 16]);
  const fem = lag({}, { satt_trinn: 5, sist_endret: NAA - 2 * MIN });
  assert.match(fem.vurder({ ms: NAA, ledigKw: 4.0, pa: true, maaltKw: 1.15 }).forklaring, /venter/);
  fem.m.sist_endret = NAA - 6 * MIN;
  assert.deepEqual([fem.vurder({ ms: NAA, ledigKw: 4.0, pa: true, maaltKw: 1.15 }).handling], ['endre']);
});

test('det er målt ladeeffekt som holdes utenfor husets forbruk: en nesten full bil holder ikke av mer', () => {
  const l = lag({}, { satt_trinn: 16, sist_endret: NAA - 20 * MIN });
  assert.equal(l.vurder({ ms: NAA, ledigKw: 4.0, pa: true, maaltKw: 1.1 }).kw, 1.1);
  assert.equal(l.styrtW(true, 1.1), 1100);
  assert.equal(l.styrtW(true, null), 3680);
  assert.equal(l.styrtW(false, null), 0);
});

test('batterinivå med hysterese, og bare om natten', () => {
  const l = lag();
  assert.equal(l.vurder({ ms: NAA, ledigKw: 9, pa: true, maaltKw: 3, soc: 81 }).handling, 'stopp');
  assert.equal(l.vurder({ ms: NAA, ledigKw: 9, pa: false, soc: 75 }).handling, 'av');        // full nok
  assert.equal(l.vurder({ ms: NAA, ledigKw: 9, pa: false, soc: 60 }).handling, 'start');
  assert.equal(l.vurder({ ms: NAA, ledigKw: 9, pa: false, soc: 75 }).handling, 'start');     // på vei opp
  const natt = lag({ kunNatt: true });
  assert.equal(natt.vurder({ ms: NAA, ledigKw: 9, pa: false }).handling, 'av');             // kl. 20
  assert.equal(natt.vurder({ ms: NAA + 3 * 60 * MIN, ledigKw: 9, pa: false }).handling, 'start');
  assert.equal(natt.vurder({ ms: kal.osloTilUtc(2026, 11, 24, 6, 5), ledigKw: 9, pa: true, maaltKw: 3 }).handling, 'stopp');
});

test('trinnets virkelige effekt læres, men ikke når bilen struper selv', () => {
  const l = lag({}, { satt_trinn: 16, sist_endret: NAA - 10 * MIN });
  l.vurder({ ms: NAA, ledigKw: 4, pa: true, maaltKw: 3.5 });
  assert.equal(l.m.kw_maalt[16], 3.5);
  l.vurder({ ms: NAA, ledigKw: 4, pa: true, maaltKw: 1.0 });
  assert.equal(l.m.kw_maalt[16], 3.5);
  l.utfort({ handling: 'endre', trinn: 10 }, NAA);
  assert.deepEqual([l.m.satt_trinn, l.m.sist_endret], [10, NAA]);
  l.utfort({ handling: 'stopp' }, NAA);
  assert.equal(l.m.satt_trinn, null);
});

// ----------------------------------------------------------------------
//  Lys
// ----------------------------------------------------------------------
const INNST = { dagStart: '06:00', nattStart: '23:00' };
const kl = (t, m = 0) => kal.osloTilUtc(2026, 11, 24, t, m);

test('glemt lys: av etter fravær, ikke mens noen er der, og ikke når sensoren har falt ut', () => {
  const regel = { key: 'sov', lys: 'l1', naervaer: { enhet: 's1', kap: 'alarm_motion' }, fravaerMin: 5 };
  const l = new Lys({}, [regel]);
  const kjor = (ms, naervaer, endret) => l.tick({ ms, innst: INNST, lys: { sov: { pa: true, naervaer, naervaerEndretMs: endret } } });
  assert.equal(kjor(kl(14, 0), true, kl(13, 50)).status.sov.status, 'i_bruk');
  assert.equal(kjor(kl(14, 3), false, kl(14, 1)).status.sov.status, 'venter');
  const av = kjor(kl(14, 7), false, kl(14, 1));
  assert.deepEqual(av.handlinger.map((h) => [h.key, h.type]), [['sov', 'av']]);
  assert.deepEqual(kjor(kl(14, 30), null, kl(14, 1)).handlinger, []);
  assert.equal(kjor(kl(14, 30), null, kl(14, 1)).status.sov.status, 'mangler');
  assert.deepEqual(kjor(kl(23, 30), false, kl(20, 0)).handlinger, []);          // utenfor 08–22
});

test('glemt lys uten sensor: av etter maks på-tid', () => {
  const l = new Lys({}, [{ key: 'vask', lys: 'l2', maksPaMin: 30 }]);
  const kjor = (ms, pa = true) => l.tick({ ms, innst: INNST, lys: { vask: { pa } } });
  assert.deepEqual(kjor(kl(10, 0)).handlinger, []);
  assert.deepEqual(kjor(kl(10, 29)).handlinger, []);
  assert.equal(kjor(kl(10, 31)).handlinger.length, 1);
  kjor(kl(10, 32), false);
  assert.deepEqual(kjor(kl(10, 40)).handlinger, [], 'klokka starter på nytt når lyset slås på igjen');
  assert.equal(new Lys({}, [{ key: 'x', lys: 'l', aktiv: false }]).tick({ ms: kl(10), innst: INNST, lys: { x: { pa: true } } }).status.x.status, 'av');
});

test('nattdemping: settes én gang ved skiftet, og manuell endring får stå', () => {
  const l = new Lys({}, [{ key: 'gang', lys: 'l3', type: 'demp', nattProsent: 25, dagProsent: 80 }]);
  const kjor = (ms, dim, pa = true, dimbar = true) => l.tick({ ms, innst: INNST, lys: { gang: { pa, dim, dimbar } } });
  assert.deepEqual(kjor(kl(22, 0), 0.5).handlinger, [{ key: 'gang', type: 'dim', verdi: 0.8, grunn: 'dag' }]);
  assert.deepEqual(kjor(kl(22, 5), 0.8).handlinger, []);
  assert.deepEqual(kjor(kl(23, 1), 0.8).handlinger, [{ key: 'gang', type: 'dim', verdi: 0.25, grunn: 'natt' }]);
  const manuell = kjor(kl(23, 30), 0.6);
  assert.deepEqual(manuell.handlinger, []);
  assert.equal(manuell.status.gang.status, 'manuell');
  assert.equal(kjor(kl(6, 1), 0.6).handlinger[0].verdi, 0.8);
  assert.equal(kjor(kl(7, 0), 0.8, true, false).status.gang.status, 'ikke_dimbar');
});
