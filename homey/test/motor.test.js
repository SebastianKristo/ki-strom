'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Motor, sonefarge } = require('../lib/motor');
const { kravVed } = require('../lib/program');
const { Lastprofil } = require('../lib/profil');
const { Stromkalkulator } = require('../lib/stromkalkulator');
const { Spotpriser } = require('../lib/spotpris');
const { Vaer } = require('../lib/vaer');
const tariffer = require('../lib/tariffer.json');

const TIME = 3600000;
const oslo = (...a) => kal.osloTilUtc(...a);
const naer = (a, b, slakk) => assert.ok(Math.abs(a - b) <= slakk, `${a} ≠ ${b}`);

const SONER = [
  { key: 'stue', navn: 'Stue', type: 'panel', prio: 2, nominell: 2.0, profil: 'fellesrom', dag: 22, natt: 19 },
  { key: 'gang', navn: 'Gang', type: 'panel', prio: 4, nominell: 1.0, profil: 'fellesrom', dag: 20, natt: 17 },
  { key: 'bad', navn: 'Bad', type: 'gulv', prio: 1, nominell: 0.7, profil: 'konstant', dag: 24 },
];

function flatSpot(fra, timer, pris) {
  const s = new Spotpriser();
  for (let n = 0; n < timer; n++) s.leggTil([{ start: kal.timestart(fra) + n * TIME, slutt: kal.timestart(fra) + (n + 1) * TIME, pris }]);
  return s;
}

const flattVaer = (fra, temp) => new Vaer(Array.from({ length: 48 }, (_, n) => ({ ms: fra + n * TIME, temp })), fra);

const maaling = (temp, effektW = 0, settpunkt = 20) => ({ temp, settpunkt, effektW, levende: true });

// ----------------------------------------------------------------------
//  Program og profil
// ----------------------------------------------------------------------
test('programmet: dag, natt, konstant, sjelden og overstyring', () => {
  const innst = { dagStart: '06:00', nattStart: '23:00' };
  assert.equal(kravVed(SONER[0], oslo(2026, 11, 23, 12), innst).min, 22);
  assert.equal(kravVed(SONER[0], oslo(2026, 11, 23, 23, 30), innst).min, 19);
  assert.equal(kravVed(SONER[0], oslo(2026, 11, 23, 5, 59), innst).min, 19);
  assert.equal(kravVed(SONER[2], oslo(2026, 11, 23, 3), innst).min, 24);
  assert.equal(kravVed({ profil: 'sjelden', dag: 20 }, oslo(2026, 11, 23, 3), innst).min, 18);
  const o = { temp: 25, tilMs: oslo(2026, 11, 23, 14) };
  assert.deepEqual(kravVed(SONER[0], oslo(2026, 11, 23, 13), innst, o), { min: 25, grunn: 'Manuell overstyring til kl. 14:00', fast: true });
  assert.equal(kravVed(SONER[0], oslo(2026, 11, 23, 14, 1), innst, o).min, 22);
});

test('lastprofilen læres per ukedag og time og brukes lenger fram', () => {
  const p = new Lastprofil({});
  const mandag12 = oslo(2026, 11, 23, 12);
  assert.equal(p.prognose(mandag12, 2.0, 15), 2.0);             // ulært: lasten nå
  for (let n = 0; n < 6; n++) p.laer(mandag12 + n * 300000, 1.0);
  naer(p.prognose(mandag12, 2.0, 15), 2.0 * (2 / 3) + 1.0 / 3, 1e-9);
  naer(p.prognose(mandag12, 2.0, 45), 1.0, 1e-9);
  assert.equal(p.prognose(mandag12 + 24 * TIME, 2.0, 15), 2.0); // tirsdag er ikke lært
});

test('fargene følger andelen av tillatt effekt', () => {
  assert.equal(sonefarge(1, 4), 'gronn');
  assert.equal(sonefarge(3.2, 4), 'gul');
  assert.equal(sonefarge(3.6, 4), 'oransje');
  assert.equal(sonefarge(3.9, 4), 'rod');
  assert.equal(sonefarge(4.5, 4), 'kritisk');
  assert.equal(sonefarge(1, 0), 'kritisk');
});

// ----------------------------------------------------------------------
//  Budsjett
// ----------------------------------------------------------------------
function kalkMedTopper(topper) {
  const k = new Stromkalkulator({}, { nettselskap: 'elvia' }, tariffer);
  k.t.maaned = '2026-11';
  topper.forEach((kw, n) => { k.t.doegnmaks[`2026-11-0${n + 1}`] = { kw, time: 17 }; });
  return k;
}

test('grensen forsvarer kapasitetstrinnet, mellom laveste og absolutte grense', () => {
  const m = new Motor({}, { soner: SONER });
  const naa = oslo(2026, 11, 23, 17);
  // topper 4,8 / 4,1 / 3,9: snitt 4,27, neste grense 5 → i dag tåler 3·5 − 4,8 − 4,1 = 6,1, minus 0,3 i reserve
  naer(m.grense(naa, kalkMedTopper([4.8, 4.1, 3.9])).kwh, 5.8, 1e-9);
  // lave topper: trinnet tåler mer enn den absolutte grensen
  assert.equal(m.grense(naa, kalkMedTopper([4.0, 3.0, 2.5])).kwh, 6.0);
  // topper 4,9 / 4,9 / 4,8: tåler 15 − 9,8 = 5,2 → minus 0,3 reserve = 4,9
  naer(m.grense(naa, kalkMedTopper([4.9, 4.9, 4.8])).kwh, 4.9, 1e-9);
  // ingen kalkulator: absolutt grense
  assert.equal(m.grense(naa, null).kwh, 6.0);
  // ønsket trinn under 5 kW med lave topper: 3·5 − 3 − 3 = 9 → absolutt grense
  const medMaal = new Motor({}, { soner: SONER, maalTrinnKw: 5 });
  assert.equal(medMaal.grense(naa, kalkMedTopper([3, 3, 3])).kwh, 6.0);
  // snittet er 1,9 (trinn 0–2): uten mål forsvares 2 kW → 3·2 − 1,9 − 1,9 = 2,2 → laveste grense 3,0
  assert.equal(m.grense(naa, kalkMedTopper([1.9, 1.9, 1.9])).kwh, 3.0);
  assert.equal(medMaal.grense(naa, kalkMedTopper([1.9, 1.9, 1.9])).kwh, 6.0);   // med mål 5 kW er det god plass
});

test('budsjettet: det som er igjen av timen fordeles på tiden som er igjen', () => {
  const m = new Motor({}, { soner: SONER });
  const b = m.budsjett(oslo(2026, 11, 23, 17, 30), null, 2.0, 4.0);
  assert.equal(b.grense, 6);
  assert.equal(b.igjen, 4);
  assert.equal(b.minutter_igjen, 30);
  assert.equal(b.tillatt_kw, 6);                       // 4 kWh på en halv time = 8 kW, men aldri over grensen
  const sent = m.budsjett(oslo(2026, 11, 23, 17, 55), null, 5.5, 4.0);
  naer(sent.tillatt_kw, 0.5 / 0.25, 1e-9);            // siste kvarter regnes som et kvarter
  const uten = m.budsjett(oslo(2026, 11, 23, 17, 30), null, null, 4.0);
  assert.equal(uten.usikker, true);
  assert.equal(uten.forbrukt, 2);
});

// ----------------------------------------------------------------------
//  Fordeling
// ----------------------------------------------------------------------
function tick(m, ms, maalinger, ekstra = {}) {
  return m.tick({ ms, kalk: null, spot: new Spotpriser(), vaer: flattVaer(ms - TIME, -5), uteMaalt: -5, totalW: 3000, timeKwh: 1.0, maalinger, ...ekstra });
}

test('god plass: alle rom får målet sitt', () => {
  const m = new Motor({}, { soner: SONER, skygge: false });
  const b = tick(m, oslo(2026, 11, 23, 12, 10), { stue: maaling(21, 1800), gang: maaling(19, 900), bad: maaling(24.2, 0) });
  assert.equal(b.status, 'gronn');
  const s = Object.fromEntries(b.soner.map((p) => [p.key, p]));
  assert.equal(s.stue.settpunkt, 22);
  assert.equal(s.gang.settpunkt, 20);
  assert.equal(s.bad.settpunkt, 24);
  assert.equal(s.bad.trenger, false);
  assert.equal(b.styrt_w, 2700);
  naer(b.uregulert_kw, 0.3, 1e-9);
  // gangen står alt på 20 °C, så bare stue og bad skrives
  assert.deepEqual(Motor.skriveliste(b).map((x) => x.key).sort(), ['bad', 'stue']);
});

test('trang time: lavest prioritet senkes, prioritet 1 røres aldri', () => {
  const m = new Motor({}, { soner: SONER, skygge: false });
  // 5,6 kWh brukt kl. :40 → 0,4 kWh igjen på 20 min = 1,2 kW tillatt
  const b = tick(m, oslo(2026, 11, 23, 17, 40), { stue: maaling(20, 1900), gang: maaling(18, 950), bad: maaling(23, 700) }, { totalW: 5200, timeKwh: 5.6 });
  const s = Object.fromEntries(b.soner.map((p) => [p.key, p]));
  assert.equal(s.bad.handling, 'normal');
  assert.equal(s.bad.settpunkt, 24);
  assert.equal(s.stue.handling, 'senket');
  assert.equal(s.gang.handling, 'senket');
  assert.ok(s.gang.settpunkt < 20 && s.gang.settpunkt >= 18);
  assert.ok(s.stue.settpunkt >= 20, 'panelovner senkes høyst 2 °C');
  assert.match(b.forklaring, /er senket/);
  assert.ok(['rod', 'kritisk', 'oransje'].includes(b.status), b.status);
});

test('gradvis gjenoppvarming: senkede rom slippes ett om gangen', () => {
  const m = new Motor({}, { soner: SONER, skygge: false });
  const maal = { stue: maaling(20, 0), gang: maaling(18, 0), bad: maaling(24.5, 0) };
  tick(m, oslo(2026, 11, 23, 17, 55), maal, { totalW: 5000, timeKwh: 5.8 });
  assert.deepEqual(Object.keys(m.t.senket).sort(), ['gang', 'stue']);
  // ny time: 1,4 kW tillatt etter annet forbruk og reserve — rom til begge (1,0 + 0,5), men ikke romslig
  const foer = tick(m, oslo(2026, 11, 23, 18, 1), maal, { totalW: 1000, timeKwh: 3.25 });
  const s1 = Object.fromEntries(foer.soner.map((p) => [p.key, p.handling]));
  assert.equal(s1.stue, 'normal');
  assert.equal(s1.gang, 'senket');
  const etter = tick(m, oslo(2026, 11, 23, 18, 5), maal, { totalW: 1000, timeKwh: 3.25 });
  assert.equal(Object.fromEntries(etter.soner.map((p) => [p.key, p.handling])).gang, 'normal');
});

test('skyggemodus og avslått motor skriver ingenting', () => {
  const maal = { stue: maaling(20, 0), gang: maaling(18, 0), bad: maaling(23, 0) };
  const skygge = tick(new Motor({}, { soner: SONER }), oslo(2026, 11, 23, 12), maal);
  assert.equal(skygge.skygge, true);
  assert.deepEqual(Motor.skriveliste(skygge), []);
  assert.match(skygge.forklaring, /Skyggemodus/);
  const av = tick(new Motor({}, { soner: SONER, aktiv: false, skygge: false }), oslo(2026, 11, 23, 12), maal);
  assert.equal(av.status, 'av');
  assert.deepEqual(Motor.skriveliste(av), []);
});

test('død termostat og manuelt rom røres ikke; settpunkt som alt stemmer skrives ikke', () => {
  const soner = [SONER[0], { ...SONER[1], styrt: false }, SONER[2]];
  const m = new Motor({}, { soner, skygge: false });
  const b = tick(m, oslo(2026, 11, 23, 12), { stue: maaling(21, 0, 22), gang: maaling(18, 0), bad: { temp: null, settpunkt: null, effektW: null, levende: false } });
  const s = Object.fromEntries(b.soner.map((p) => [p.key, p]));
  assert.equal(s.gang.handling, 'manuell');
  assert.equal(s.bad.handling, 'utilgjengelig');
  assert.deepEqual(Motor.skriveliste(b), []);          // stua står alt på 22
});

test('overstyring gjelder til tiden er ute', () => {
  const m = new Motor({}, { soner: SONER, skygge: false });
  const naa = oslo(2026, 11, 23, 12);
  m.overstyr('stue', 24.5, 60, naa);
  const maal = { stue: maaling(22, 0), gang: maaling(20, 0), bad: maaling(24, 0) };
  assert.equal(tick(m, naa + 60000, maal).soner.find((p) => p.key === 'stue').settpunkt, 24.5);
  assert.equal(tick(m, naa + 61 * 60000, maal).soner.find((p) => p.key === 'stue').settpunkt, 22);
  assert.deepEqual(m.t.overstyringer, {});
});

// ----------------------------------------------------------------------
//  Mål: forvarming og varmeplan
// ----------------------------------------------------------------------
test('ulært rom: forvarmingen starter i tide før dagen begynner', () => {
  const m = new Motor({}, { soner: SONER, skygge: false });
  const maal = (temp) => ({ stue: maaling(temp, 0), gang: maaling(17, 0), bad: maaling(24, 0) });
  // Ulært rom regnes forsiktig (lekk standardmodell): fra 19 til 22 °C i −5 tar ca. fire timer.
  const kl1 = tick(m, oslo(2026, 11, 24, 1, 0), maal(19));
  assert.equal(kl1.soner.find((p) => p.key === 'stue').mal, 19);
  const kl5 = tick(m, oslo(2026, 11, 24, 5, 0), maal(19));
  const stue = kl5.soner.find((p) => p.key === 'stue');
  assert.equal(stue.mal, 22);
  assert.match(stue.grunn, /Forvarming/);
});

test('lært rom: varmeplanen lar rommet gli om natten og varmer til morgenen', () => {
  const m = new Motor({ laering: { soner: { stue: { k: 0.05, varme_rate: 1.5, rate_max: 2.0, n: 20 } } } }, { soner: [SONER[0]], skygge: false });
  const kveld = oslo(2026, 11, 23, 23, 5);
  const spot = flatSpot(kveld, 40, 0.8);
  const kalk = new Stromkalkulator({}, { nettselskap: 'elvia', harNorgespris: true }, tariffer);
  const b = m.tick({ ms: kveld, kalk, spot, vaer: flattVaer(kveld - TIME, -5), uteMaalt: -5, totalW: 500, timeKwh: 0.1, maalinger: { stue: maaling(22, 0) } });
  const stue = b.soner[0];
  assert.equal(stue.laert, true);
  assert.equal(stue.mal, 19);
  assert.match(stue.grunn, /gli/);
  assert.ok(stue.plan.length === 24);
  // planen: ingen varme først, og minst 21,5 °C ved timen som slutter kl. 06
  assert.equal(stue.plan[0].u, 0);
  assert.ok(stue.plan[6].til >= 21.5, `kl. 06: ${stue.plan[6].til}`);
  assert.ok(Math.min(...stue.plan.slice(0, 6).map((t) => t.til)) < 21, 'rommet skal falle om natten');
  assert.ok(b.plan_spart_kr > 0);
  // Natt-tariffen er billigere enn dag hos Elvia, så prisen i planen skifter kl. 06
  assert.ok(stue.plan[8].pris > stue.plan[2].pris);
});

test('læringen mates fra målingene og lagres i tilstanden', () => {
  const tilstand = {};
  const m = new Motor(tilstand, { soner: [SONER[0]] });
  let ms = oslo(2026, 11, 23, 1);
  let temp = 22;
  for (let n = 0; n < 12 * 6; n++) {
    tick(m, ms, { stue: maaling(Math.round(temp * 2) / 2, 0) }, { uteMaalt: 0, vaer: flattVaer(ms - TIME, 0) });
    temp -= 0.05; ms += 300000;
  }
  assert.ok(tilstand.laering.soner.stue.n >= 5);
  naer(tilstand.laering.soner.stue.k, 0.6 / 21, 0.01);
  assert.ok(Object.keys(tilstand.profil).length >= 6);
});
