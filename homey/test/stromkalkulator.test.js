'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const kost = require('../lib/kostnad');
const { Stromkalkulator } = require('../lib/stromkalkulator');
const { Spotpriser } = require('../lib/spotpris');
const { Timemaler } = require('../lib/timemaler');
const tariffer = require('../lib/tariffer.json');

const TIME = 3600000;
const oslo = (aar, mnd, dag, time = 0, min = 0) => kal.osloTilUtc(aar, mnd, dag, time, min);
const naer = (a, b, slakk = 1e-6) => assert.ok(Math.abs(a - b) <= slakk, `${a} ≠ ${b}`);

/** Flat spotpris (eks. mva) for hele perioden. */
function flatSpot(fra, til, pris) {
  const s = new Spotpriser();
  for (let t = kal.timestart(fra); t < til; t += TIME) s.leggTil([{ start: t, slutt: t + TIME, pris }]);
  return s;
}

/** Mat kalkulatoren med en jevn last (kW) fra og til, én prøve i minuttet. */
function kjor(k, spot, fra, til, kw, startKwh = 1000) {
  let kwh = startKwh;
  for (let t = fra; t <= til; t += 60000) {
    k.energi(t, kwh, spot);
    kwh += kw / 60;
  }
  return kwh - kw / 60;
}

const ny = (innst = {}) => new Stromkalkulator({}, { nettselskap: 'elvia', ...innst }, tariffer);

// ----------------------------------------------------------------------
//  Kostnadskjernen
// ----------------------------------------------------------------------
const SATSER = {
  energileddInklMva: 0.464, avgifterInklMva: 0.101625, mvaSats: 0.25, norgesprisInklMva: 0.5,
  stromstotteTerskel: 0.9625, stromstotteMaksKwh: 5000, norgesprisMaksKwh: 5000, harNorgespris: false,
};

test('strømstøtte: 90 % av spot over terskelen', () => {
  // spot 2,00 eks. mva = 2,50 inkl. → støtte (2,50 − 0,9625)·0,9 = 1,38375 kr/kWh
  const k = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: 2.0 }, SATSER, 0);
  naer(k.stromstotte_kr, 13.8375);
  naer(k.strom_kr, 25 - 13.8375);
  naer(k.energiledd_dag_kr, (0.464 - 0.101625) * 10);
  naer(k.avgifter_kr, 1.01625);
  assert.equal(k.energiledd_natt_kr, 0);
  // alternativet er Norgespris: 0,50·10 = 5,00 → 6,1625 kr billigere enn spot med støtte
  naer(k.norgespris_differanse_kr, 5 - (25 - 13.8375));
});

test('under terskelen gis ingen støtte', () => {
  const k = kost.kronerForIntervall({ kwh: 10, dag: false, prisEksMva: 0.5 }, SATSER, 0);
  assert.equal(k.stromstotte_kr, 0);
  naer(k.strom_kr, 6.25);
  naer(k.energiledd_natt_kr, 3.62375);
});

test('intervallet deles ved månedstaket for støtte', () => {
  // 4995 kWh brukt: 5 av 10 kWh får støtte
  const k = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: 2.0 }, SATSER, 4995);
  naer(k.stromstotte_kr, 1.38375 * 5);
});

test('Norgespris: fast pris under taket, spot over, ingen støtte', () => {
  const s = { ...SATSER, harNorgespris: true };
  const under = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: 2.0 }, s, 0);
  naer(under.strom_kr, 5);
  assert.equal(under.stromstotte_kr, 0);
  naer(under.norgespris_kompensasjon_kr, (0.5 - 2.5) * 10);
  const over = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: 2.0 }, s, 4996);
  naer(over.strom_kr, 0.5 * 4 + 2.5 * 6);
});

test('uten spotpris bokføres nettleie og kjent Norgespris, resten står som «uten pris»', () => {
  const spot = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: null }, SATSER, 0);
  assert.equal(spot.strom_kr, 0);
  assert.equal(spot.kwh_uten_pris, 10);
  naer(spot.avgifter_kr, 1.01625);
  const np = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: null }, { ...SATSER, harNorgespris: true }, 0);
  naer(np.strom_kr, 5);
});

test('fritidsbolig får ingen strømstøtte', () => {
  const k = kost.kronerForIntervall({ kwh: 10, dag: true, prisEksMva: 2.0 }, { ...SATSER, stromstotteMaksKwh: 0 }, 0);
  assert.equal(k.stromstotte_kr, 0);
  naer(k.strom_kr, 25);
});

// ----------------------------------------------------------------------
//  Timemåleren
// ----------------------------------------------------------------------
test('hel time måles ved grensene, og hull gir «mangler», ikke null', () => {
  const m = new Timemaler({});
  const start = Date.UTC(2026, 10, 23, 12) / 1000;
  for (let i = -30; i <= 3630; i += 10) m.prove(start + i, 500 + (2.4 * i) / 3600);
  const lukket = m.oppdater(start + 3630);
  assert.equal(lukket.length, 1);
  assert.equal(lukket[0].kvalitet, 'malt');
  naer(lukket[0].kwh, 2.4, 1e-3);
  assert.ok(m.m.prover.length < 120, 'prøvene skal tynnes midt i timen');
  // fire timer uten prøver: timene kan ikke lukkes med et tall
  m.prove(start + 5 * 3600 + 20, 512);
  const etter = m.oppdater(start + 5 * 3600 + 400);
  assert.ok(etter.length >= 3);
  assert.ok(etter.every((r) => r.kwh === null && r.kvalitet === 'mangler'));
});

test('målerbytte gir ikke negativt eller enormt forbruk', () => {
  const m = new Timemaler({});
  const start = Date.UTC(2026, 10, 23, 12) / 1000;
  m.prove(start, 90000);
  assert.equal(m.prove(start + 1800, 3), true);
  m.prove(start + 3600, 4);
  assert.equal(m.oppdater(start + 3700)[0].kwh, null);
});

// ----------------------------------------------------------------------
//  Kalkulatoren
// ----------------------------------------------------------------------
test('et døgn på Elvia: forbruk, tariff, kroner og døgnmaks', () => {
  const k = ny();
  const fra = oslo(2026, 11, 23, 0);          // mandag
  const til = oslo(2026, 11, 24, 0, 1);
  const spot = flatSpot(fra, til + TIME, 1.0);  // 1,25 inkl. mva → støtte 0,25875
  kjor(k, spot, fra, til, 3.0);
  const s = k.snapshot(til, spot);
  naer(s.maaned.kwh, 72.05, 0.01);
  naer(s.maaned.kwh_dag, 48, 0.01);            // 06–22
  naer(s.maaned.kwh_natt, 24.05, 0.01);
  const dag = (0.2899 + 0.0813) * 1.25;
  const natt = (0.1699 + 0.0813) * 1.25;
  naer(s.maaned.energiledd_kr, 48 * dag + 24.05 * natt, 0.02);
  naer(s.maaned.stromstotte_kr, 72.05 * (1.25 - 0.9625) * 0.9, 0.02);
  naer(s.maaned.strom_kr, 72.05 * 1.25 - 72.05 * 0.25875, 0.02);
  assert.equal(s.nettleie.topper.length, 1);
  assert.deepEqual(s.nettleie.topper[0].dato, '2026-11-23');
  naer(s.nettleie.topper[0].kw, 3.0, 0.01);
  assert.equal(s.nettleie.kapasitetsledd, 250);
  assert.equal(s.nettleie.kapasitetstrinn, '2-5 kW');
  naer(s.nettleie.margin_kw, 2.0, 0.01);
  assert.equal(s.problemer.length, 0);
});

test('prisene nå: tariff, støtte, totalpris og fastledd per kWh', () => {
  const k = ny();
  const naa = oslo(2026, 11, 23, 12);
  const spot = flatSpot(naa - TIME, naa + TIME, 2.0);
  k.energi(naa, 1000, spot);
  const s = k.snapshot(naa, spot);
  assert.equal(s.nettleie.tariff, 'dag');
  naer(s.nettleie.energiledd, 0.464, 1e-4);
  naer(s.pris.spot, 2.5);
  naer(s.pris.stromstotte, 1.3838, 1e-4);
  naer(s.pris.spot_etter_stotte, 1.1163, 1e-4);
  // uten topper er trinnet 0–2 kW: 150 kr / 30 dager / 24 t
  naer(s.pris.total, 2.5 - 1.38375 + 0.464 + 150 / 30 / 24, 1e-3);
  assert.equal(s.pris.norgespris_aktiv, false);
  naer(s.pris.prisforskjell_norgespris, 0.5 - 1.11625, 1e-3);
});

test('Norgespris: kraften koster 50 øre og gir ingen støtte', () => {
  const k = ny({ harNorgespris: true });
  const naa = oslo(2026, 11, 23, 12);
  const spot = flatSpot(naa - TIME, naa + TIME, 2.0);
  k.energi(naa, 1000, spot);
  const s = k.snapshot(naa, spot);
  assert.equal(s.pris.norgespris_aktiv, true);
  assert.equal(s.pris.stromstotte, 0);
  naer(s.pris.kraft, 0.5);
  naer(s.pris.prisforskjell_norgespris, 1.11625 - 0.5, 1e-3);
});

test('kapasitetstrinn: snittet av tre dager, og varsel nær neste trinn', () => {
  const k = ny();
  let kwh = 1000;
  const spot = flatSpot(oslo(2026, 11, 2), oslo(2026, 11, 6), 0.5);
  for (const [dag, kw] of [[2, 4.8], [3, 4.1], [4, 5.5]]) {
    const fra = oslo(2026, 11, dag, 17);
    kwh = kjor(k, spot, fra, fra + TIME + 60000, kw, kwh);
    k.energi(fra + 20 * TIME, kwh, spot);      // rolig resten av døgnet
  }
  const s = k.snapshot(oslo(2026, 11, 5, 12), spot);
  naer(s.nettleie.snitt_topp_kw, 4.8, 0.01);
  assert.equal(s.nettleie.kapasitetsledd, 250);
  naer(s.nettleie.margin_kw, 0.2, 0.01);
  assert.equal(s.nettleie.kapasitetsvarsel, true);
  assert.equal(s.nettleie.neste_trinn_pris, 420);
  // en ny dag kan nå 3·5,0 − 5,5 − 4,8 = 4,7 kWh før snittet når 5 kW
  naer(s.nettleie.tak_idag_kwh, 4.7, 0.01);
});

test('månedsskifte arkiverer måneden, og siste time teller på riktig måned', () => {
  const k = ny();
  const fra = oslo(2026, 11, 30, 20);
  const til = oslo(2026, 12, 1, 2, 1);
  const spot = flatSpot(fra, til + TIME, 0.5);
  kjor(k, spot, fra, til, 6.0);
  const s = k.snapshot(til, spot);
  assert.equal(s.maaned.maaned, '2026-12');
  naer(s.maaned.kwh, 12.1, 0.02);
  assert.equal(s.forrige_maaned.maaned, '2026-11');
  naer(s.forrige_maaned.kwh, 24, 0.02);
  // timen 23–00 den 30. lukkes etter midnatt, men hører til november
  assert.equal(s.forrige_maaned.topper[0].dato, '2026-11-30');
  naer(s.forrige_maaned.snitt_topp_kw, 6, 0.01);
  assert.equal(s.forrige_maaned.kapasitetsledd, 420);
  assert.equal(s.nettleie.topper[0].dato, '2026-12-01');
});

test('bare effektmåler: forbruket Riemann-summeres', () => {
  const k = ny();
  const fra = oslo(2026, 11, 23, 10);
  const spot = flatSpot(fra, fra + 3 * TIME, 0.5);
  for (let t = fra; t <= fra + 2 * TIME; t += 30000) k.effekt(t, 2000, spot);
  const s = k.snapshot(fra + 2 * TIME, spot);
  naer(s.maaned.kwh, 4.0, 0.02);
  // et hull på 20 minutter integreres ikke
  k.effekt(fra + 2 * TIME + 20 * 60000, 2000, spot);
  naer(k.snapshot(fra + 3 * TIME, spot).maaned.kwh, 4.0, 0.02);
});

test('et forsinket sprang fordeles over timene med hver sin pris', () => {
  const k = ny();
  const fra = oslo(2026, 11, 23, 4);
  const spot = new Spotpriser();
  spot.leggTil([{ start: fra, slutt: fra + TIME, pris: 0.4 }, { start: fra + TIME, slutt: fra + 2 * TIME, pris: 0.6 }]);
  k.energi(fra, 1000, spot);
  k.energi(fra + 2 * TIME, 1004, spot);      // to timer uten prøver, 4 kWh
  const s = k.snapshot(fra + 2 * TIME, spot);
  naer(s.maaned.strom_kr, 2 * 0.4 * 1.25 + 2 * 0.6 * 1.25, 0.01);   // begge under støtteterskelen
  naer(s.maaned.kwh_natt, 4, 1e-6);
});

test('urimelig sprang og målerbytte bokføres ikke', () => {
  const k = ny();
  const fra = oslo(2026, 11, 23, 10);
  const spot = flatSpot(fra, fra + 2 * TIME, 0.5);
  k.energi(fra, 1000, spot);
  k.energi(fra + 60000, 1500, spot);         // +500 kWh på ett minutt
  k.energi(fra + 120000, 2, spot);           // ny måler
  k.energi(fra + 180000, 2.05, spot);
  naer(k.snapshot(fra + 180000, spot).maaned.kwh, 0.05, 1e-6);
});

test('manglende spotpris vises som problem og kWh uten pris', () => {
  const k = ny();
  const fra = oslo(2026, 11, 23, 10);
  k.energi(fra, 1000, new Spotpriser());
  k.energi(fra + 60000, 1001, new Spotpriser());
  const s = k.snapshot(fra + 60000, new Spotpriser());
  assert.equal(s.pris.spot, null);
  assert.equal(s.pris.total, null);
  assert.ok(s.problemer.includes('spotpris mangler'));
  naer(s.maaned.kwh_uten_pris, 1, 1e-6);
  naer(s.maaned.energiledd_kr, 0.464, 0.006);   // vises i hele øre
});

test('egne trinn og satser overstyrer katalogen; tilstanden overlever omstart', () => {
  const tilstand = {};
  const innst = { nettselskap: 'custom', energileddDagEksMva: 0.3, energileddNattEksMva: 0.1, egneTrinn: '2:100,5:200,10:300' };
  const k = new Stromkalkulator(tilstand, innst, tariffer);
  const fra = oslo(2026, 11, 23, 17);
  const spot = flatSpot(fra, fra + 3 * TIME, 0.5);
  const kwh = kjor(k, spot, fra, fra + TIME + 60000, 3.0);
  const k2 = new Stromkalkulator(JSON.parse(JSON.stringify(tilstand)), innst, tariffer);
  const s = k2.snapshot(fra + 2 * TIME, spot, kwh);
  assert.equal(s.nettleie.kapasitetsledd, 200);
  naer(s.nettleie.energiledd_dag, (0.3 + 0.0813) * 1.25, 1e-4);
  naer(s.maaned.kwh, 3.05, 0.01);
});

test('uten egne trinn er fastleddet ukjent hos «egendefinert»', () => {
  const k = new Stromkalkulator({}, { nettselskap: 'custom' }, tariffer);
  const s = k.snapshot(oslo(2026, 11, 23, 12), new Spotpriser());
  assert.equal(s.nettleie.kapasitetsledd, null);
  assert.ok(s.problemer.includes('fastledd ukjent'));
});

test('måler som oppdaterer registeret én gang i timen: riktig time, pris og tariff', () => {
  const k = ny();
  const start = oslo(2026, 11, 23, 20);           // mandag kveld: 20–22 er dag, 22–24 natt
  const spot = new Spotpriser();
  const priser = [0.2, 0.4, 0.6, 0.3, 0.3];
  priser.forEach((p, n) => spot.leggTil([{ start: start + n * TIME, slutt: start + (n + 1) * TIME, pris: p }]));
  const forbruk = [2, 3, 5, 1];                    // kWh i timene 20, 21, 22, 23
  let kwh = 1000;
  k.energi(start + 10000, kwh, spot);              // registeret kommer 10 s over hel time
  for (let n = 0; n < 4; n++) {
    for (let m = 1; m < 60; m++) k.tikk(start + n * TIME + m * 60000);   // klokka går, ingen ny måling
    kwh += forbruk[n];
    k.energi(start + (n + 1) * TIME + 10000, kwh, spot);
  }
  const s = k.snapshot(start + 4 * TIME + 60000, spot);
  naer(s.maaned.kwh_dag, 5, 0.02);
  naer(s.maaned.kwh_natt, 6, 0.02);
  naer(s.maaned.strom_kr, (2 * 0.2 + 3 * 0.4 + 5 * 0.6 + 1 * 0.3) * 1.25, 0.02);
  assert.equal(s.nettleie.topper[0].time, 22);
  naer(s.nettleie.topper[0].kw, 5, 0.02);
});

test('topper fra før appen begynte å måle gir riktig trinn, og gjelder bare sin måned', () => {
  const { Stromkalkulator: K } = require('../lib/stromkalkulator');
  const tariffer = require('../lib/tariffer.json');
  const start = kal.osloTilUtc(2026, 11, 24, 10, 0);
  const uten = new K({}, { nettselskap: 'elvia' }, tariffer);
  uten.energi(start, 1000, null);
  const s0 = uten.snapshot(start + 60000, null);
  assert.deepEqual(s0.nettleie.topper, []);
  assert.ok(s0.merknader.some((p) => p.includes('ingen topper ennå')));
  assert.ok(s0.merknader.some((p) => p.includes('bygger bare på målinger fra 24.11.')));

  const med = new K({}, { nettselskap: 'elvia', startTopper: [6.2, 5.8, 5.5], startMaaned: '2026-11' }, tariffer);
  med.energi(start, 1000, null);
  const s1 = med.snapshot(start + 60000, null);
  assert.deepEqual(s1.nettleie.topper.map((x) => [x.kw, x.start]), [[6.2, true], [5.8, true], [5.5, true]]);
  assert.equal(s1.nettleie.snitt_topp_kw, 5.83);
  assert.notEqual(s1.nettleie.kapasitetstrinn, s0.nettleie.kapasitetstrinn);
  assert.ok(!s1.merknader.some((p) => p.includes('bygger bare')));
  // En målt dag som er høyere, går foran den laveste startverdien
  med.t.doegnmaks['2026-11-25'] = { kw: 7, time: 18 };
  assert.deepEqual(med.snapshot(start + 60000, null).nettleie.topper.map((x) => x.kw), [7, 6.2, 5.8]);
  // Neste måned teller de ikke
  assert.deepEqual(med.topper('2026-12'), []);
});
