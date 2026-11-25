'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Motor, sonefarge } = require('../lib/motor');
const { kravVed } = require('../lib/program');
const { Lastprofil } = require('../lib/profil');
const { ferdigLaert } = require('../lib/rommodell');
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
  for (let n = 0; n < 12; n++) p.laer(mandag12 + n * 300000, 1.0);
  // Rett fram veier avviket fra mønsteret tungt; lenger fram dør det ut mot mønsteret.
  const kort = p.prognose(mandag12, 2.0, 15);
  const lang = p.prognose(mandag12, 2.0, 45);
  assert.ok(kort > 1.5 && kort < 2.0, `kort: ${kort}`);
  assert.ok(lang < kort && lang >= 1.0, `lang: ${lang}`);
  // Tirsdag samme time er ikke lært som ukedag, men «hverdag kl. 12» er: mønsteret brukes.
  naer(p.monster(mandag12 + 24 * TIME).kw, 1.0, 1e-9);
  assert.equal(p.monster(oslo(2026, 11, 28, 3)), null);         // lørdag natt: ingenting lært
});

test('forbruksprognosen måler sine egne bom, og reserven følger dem', () => {
  const jevn = new Lastprofil({});
  const ujevn = new Lastprofil({});
  assert.equal(jevn.reserve(0.35), 0.35);                       // til nok er lært gjelder standarden
  let ms = oslo(2026, 11, 23, 0);
  for (let n = 0; n < 7 * 288; n++) {
    jevn.laer(ms, 1.0 + 0.05 * Math.sin(n));
    // Et hus der store laster slår inn og ut uten mønster
    ujevn.laer(ms, 1.0 + ((n * 7919) % 13 < 3 ? 2.5 : 0));
    ms += 300000;
  }
  assert.ok(jevn.reserve() <= 0.2, `jevn: ${jevn.reserve()}`);
  assert.ok(ujevn.reserve() >= 0.8, `ujevn: ${ujevn.reserve()}`);
  assert.ok(jevn.treffsikkerhet().feil_kw < 0.1);
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
  const m = new Motor({ modeller: { rom: { stue: ferdigLaert({ r: 2.0, k: 0.05 }) } } }, { soner: [SONER[0]], skygge: false });
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
  for (let n = 0; n < 12 * 30; n++) {
    tick(m, ms, { stue: maaling(Math.round(temp * 2) / 2, 0) }, { uteMaalt: 0, vaer: flattVaer(ms - TIME, 0) });
    temp -= 0.01 * (temp / 21); ms += 60000;
  }
  // Ovnen står og rommet faller 0,6 °C/t ved ~20 °C over ute: k ≈ 0,029
  const lagret = tilstand.modeller.rom.stue;
  assert.ok(lagret.n >= 5, `vinduer: ${lagret.n}`);
  naer(m.modeller.modell('stue').k, 0.6 / 21, 0.006);
  assert.ok(Object.keys(tilstand.profil).length >= 6);
});

// ----------------------------------------------------------------------
//  Korrigering, treffsikkerhet, lufting og kapasitet i planen
// ----------------------------------------------------------------------
/** Kjør motoren minutt for minutt med en termostat som gjør det den blir bedt om. */
function forlop(m, start, minutter, hver) {
  if (!m.testSp) m.testSp = {};          // termostatenes settpunkt lever videre mellom kallene
  const sp = m.testSp;
  let siste;
  for (let n = 0; n < minutter; n++) {
    const ms = start + n * 60000;
    const inn = hver(ms, n, sp) || {};
    const maalinger = {};
    // Noen stiller på veggen: termostaten står der til vi ber om noe annet
    for (const [key, v] of Object.entries(inn.maalinger || {})) if (v.settpunkt !== undefined) sp[key] = v.settpunkt;
    for (const s of m.soner()) maalinger[s.key] = { temp: 21, effektW: 0, levende: true, ...(inn.maalinger || {})[s.key], settpunkt: ((inn.maalinger || {})[s.key] || {}).settpunkt ?? sp[s.key] ?? 20 };
    siste = m.tick({ ms, kalk: null, spot: new Spotpriser(), vaer: flattVaer(ms - TIME, 0), uteMaalt: 0, totalW: 800, timeKwh: 0.3, ...inn, maalinger });
    for (const p of siste.soner) if (p.settpunkt !== null && !(inn.laas || {})[p.key]) sp[p.key] = p.settpunkt;
    m.testHendelser = (m.testHendelser || []).concat(siste.hendelser.map((h) => h.type));
  }
  return siste;
}

test('skrur du på termostaten selv, holdes det — og vårt eget settpunkt regnes ikke som en justering', () => {
  const m = new Motor({}, { soner: [SONER[0]], skygge: false, korreksjonTimer: 3 });
  const start = oslo(2026, 11, 23, 12);
  // Ti minutter der termostaten følger oss: ingen justering oppdaget
  let b = forlop(m, start, 10, () => ({}));
  assert.equal(b.soner[0].settpunkt, 22);
  assert.deepEqual(m.t.overstyringer, {});
  // Så setter noen 24 °C på veggen
  b = forlop(m, start + 10 * 60000, 3, () => ({ maalinger: { stue: { settpunkt: 24 } }, laas: { stue: true } }));
  assert.equal(b.soner[0].settpunkt, 24);
  assert.match(b.soner[0].grunn, /Manuell overstyring til kl\. 15:1\d/);
  assert.equal(m.t.justering.stue.logg.length, 1);
  assert.deepEqual([m.t.justering.stue.logg[0].delta, m.t.justering.stue.logg[0].periode], [2, 'dag']);
  // Etter tre timer er programmet tilbake
  b = forlop(m, start + 4 * TIME, 2, () => ({}));
  assert.equal(b.soner[0].settpunkt, 22);
});

test('gjentatte justeringer læres: tre like på to dager blir en fast justering, som kan glemmes', () => {
  const m = new Motor({}, { soner: [SONER[0]], skygge: false, korreksjonTimer: 1 });
  for (const [dag, time] of [[23, 12], [23, 18], [24, 12]]) {
    const start = oslo(2026, 11, dag, time);
    forlop(m, start, 6, () => ({}));
    forlop(m, start + 6 * 60000, 2, () => ({ maalinger: { stue: { settpunkt: 23 } }, laas: { stue: true } }));
    forlop(m, start + 90 * 60000, 5, () => ({}));
  }
  assert.deepEqual(m.testHendelser.filter((h) => h !== 'manuell'), ['laert_justering']);
  assert.equal(m.testHendelser.filter((h) => h === 'manuell').length, 3);
  assert.equal(m.t.justering.stue.dag, 1);
  assert.equal(m.t.justering.stue.natt, 0);
  const b = forlop(m, oslo(2026, 11, 25, 12), 3, () => ({}));
  assert.equal(b.soner[0].krav, 23);
  assert.match(b.soner[0].grunn, /lært av dine justeringer/);
  assert.equal(b.soner[0].justering, 1);
  // Om natten gjelder den ikke, og den kan slås av eller glemmes
  assert.equal(forlop(m, oslo(2026, 11, 26, 2), 2, () => ({})).soner[0].krav, 19);
  m.glemJusteringer('stue');
  assert.equal(forlop(m, oslo(2026, 11, 26, 12), 2, () => ({})).soner[0].krav, 22);
});

test('i skyggemodus regnes ingenting som en justering', () => {
  const m = new Motor({}, { soner: [SONER[0]], skygge: true });
  const start = oslo(2026, 11, 23, 12);
  forlop(m, start, 6, () => ({ maalinger: { stue: { settpunkt: 20 } }, laas: { stue: true } }));
  forlop(m, start + 6 * 60000, 3, () => ({ maalinger: { stue: { settpunkt: 24 } }, laas: { stue: true } }));
  assert.deepEqual(m.t.overstyringer, {});
  assert.deepEqual(m.t.justering, {});
});

test('lærer av å komme for sent: neste gang regnes ovnen som svakere, men ikke når noen kom uventet hjem', () => {
  const sone = { key: 'stue', navn: 'Stue', type: 'panel', prio: 3, nominell: 2, profil: 'fellesrom', dag: 22, natt: 19 };
  const m = new Motor({ modeller: { rom: { stue: ferdigLaert({ r: 3.0, k: 0.05 }) } } }, { soner: [sone], skygge: false });
  // Kl. 05:58–06:02 med rommet på 20 °C: kravet stiger til 22 på et tidspunkt klokka kunne forutsi
  const b = forlop(m, oslo(2026, 11, 24, 5, 58), 5, () => ({ maalinger: { stue: { temp: 20 } } }));
  assert.ok(m.t.treff.stue.faktor < 0.9, `faktor: ${m.t.treff.stue.faktor}`);
  assert.equal(m.t.treff.stue.sene, 1);
  assert.ok(m.planmodell('stue').r < 0.9 * 3.0);
  assert.equal(b.soner[0].modell.treff_faktor, m.t.treff.stue.faktor);
  // Neste morgen er rommet varmt i tide: straffen trappes ned
  forlop(m, oslo(2026, 11, 25, 5, 58), 5, () => ({ maalinger: { stue: { temp: 22 } } }));
  assert.ok(m.t.treff.stue.faktor > 0.87);

  // Et rom som følger en person: hen kommer uventet hjem midt på dagen. Det er ikke modellens feil.
  const rom = { ...sone, key: 'soverom', profil: 'person:sebastian' };
  const m2 = new Motor({ modeller: { rom: { soverom: ferdigLaert({ r: 3.0, k: 0.05 }) } } }, { soner: [rom], skygge: false });
  const person = (hjemme) => ({ naaMs: 0, personer: { sebastian: { navn: 'Sebastian', type: 'voksen', hjemme } } });
  const t0 = oslo(2026, 11, 24, 13);
  forlop(m2, t0, 4, (ms) => ({ maalinger: { soverom: { temp: 20 } }, kontekst: { ...person(false), naaMs: ms } }));
  forlop(m2, t0 + 4 * 60000, 4, (ms) => ({ maalinger: { soverom: { temp: 20 } }, kontekst: { ...person(true), naaMs: ms } }));
  assert.equal(m2.t.treff.soverom.faktor, 1);
  assert.equal(m2.t.treff.soverom.sene, 0);
});

test('åpent vindu: varmen pauses etter noen minutter og kommer tilbake når det lukkes', () => {
  const m = new Motor({}, { soner: [SONER[0]], skygge: false, vinduPauseMin: 3, vinduTemp: 7 });
  const start = oslo(2026, 11, 23, 12);
  const aapen = (er) => () => ({ maalinger: { stue: { temp: 20, aapen: er } } });
  assert.equal(forlop(m, start, 2, aapen(true)).soner[0].settpunkt, 22);          // kort lufting: ingenting skjer
  const b = forlop(m, start + 2 * 60000, 3, aapen(true));
  assert.equal(b.soner[0].handling, 'lufting');
  assert.equal(b.soner[0].settpunkt, 7);
  assert.match(b.soner[0].forklaring, /åpen/);
  assert.equal(forlop(m, start + 5 * 60000, 1, aapen(false)).soner[0].settpunkt, 22);
  // En sensor som henger på «åpen» får ikke la rommet stå kaldt
  const henger = forlop(m, start + 10 * 60000, 95, aapen(true));
  assert.equal(henger.soner[0].settpunkt, 22);
  assert.match(henger.soner[0].grunn, /sjekk sensoren/);
});

test('planen unngår timer der huset pleier å bruke mye', () => {
  const sone = { key: 'stue', navn: 'Stue', type: 'panel', prio: 3, nominell: 2, profil: 'fellesrom', dag: 22, natt: 19 };
  const lag = (kapasitetIPlan) => {
    const m = new Motor({ modeller: { rom: { stue: ferdigLaert({ r: 3.0, k: 0.06 }) } } }, { soner: [sone], skygge: false, kapasitetIPlan, maksTimeKwh: 5, planOppGrader: 1.5 });
    // Huset bruker 4 kW kl. 17 hver dag (middag), ellers lite
    for (let dag = 9; dag < 23; dag++) for (let n = 0; n < 288; n++) { const ms = oslo(2026, 11, dag, 0) + n * 300000; m.profil.laer(ms, kal.osloDeler(ms).time === 17 ? 4.0 : 0.6); }
    const ms = oslo(2026, 11, 23, 13, 0);
    const b = m.tick({ ms, kalk: null, spot: flatSpot(ms, 40, 1), vaer: flattVaer(ms - TIME, -8), uteMaalt: -8, totalW: 600, timeKwh: 0, maalinger: { stue: maaling(22.2, 0, 22) } });
    return b.soner[0].plan;
  };
  const med = lag(true);
  const uten = lag(false);
  // Time 4 i planen er kl. 17–18
  assert.ok(med[4].pris > uten[4].pris + 0.5, `påslag: ${med[4].pris} mot ${uten[4].pris}`);
  assert.ok(med[4].u < uten[4].u || med[4].u === 0, `pådrag kl. 17: ${med[4].u} mot ${uten[4].u}`);
  assert.ok(med[3].til > uten[3].til, 'rommet varmes litt ekstra før middagstimen');
  assert.ok(Math.min(...med.slice(0, 8).map((t) => t.til)) >= 21.5, 'uten at det blir kaldt');
});

test('en termostat som runder av eller melder sent, regnes ikke som en justering', () => {
  // Hele grader: vi ber om 21,5 og den melder 22 — fem minutter senere
  const m = new Motor({}, { soner: [{ ...SONER[0], dag: 21.5 }], skygge: false });
  const start = oslo(2026, 11, 23, 12);
  forlop(m, start, 8, () => ({ maalinger: { stue: { settpunkt: 20, steg: 1 } }, laas: { stue: true } }));
  forlop(m, start + 8 * 60000, 4, () => ({ maalinger: { stue: { settpunkt: 22, steg: 1 } }, laas: { stue: true } }));
  assert.deepEqual(m.t.overstyringer, {});
  // Men 24 °C er noe annet enn det vi ba om
  forlop(m, start + 12 * 60000, 2, () => ({ maalinger: { stue: { settpunkt: 24, steg: 1 } }, laas: { stue: true } }));
  assert.equal(m.t.overstyringer.stue.temp, 24);

  // Treg termostat: kl. 23 ber vi om 19, men den melder først dagens 22 (som den fikk tidligere) og så 19
  const m2 = new Motor({}, { soner: [SONER[0]], skygge: false });
  const kveld = oslo(2026, 11, 23, 22, 50);
  forlop(m2, kveld, 14, () => ({ maalinger: { stue: { settpunkt: 21 } }, laas: { stue: true } }));          // har ikke fått med seg noe ennå
  forlop(m2, kveld + 14 * 60000, 3, () => ({ maalinger: { stue: { settpunkt: 22 } }, laas: { stue: true } }));   // dagens, forsinket
  assert.deepEqual(m2.t.overstyringer, {});
});
