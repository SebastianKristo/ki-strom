'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Hus } = require('../lib/hus');
const { Vaner } = require('../lib/vaner');
const { kravVed } = require('../lib/program');
const { skalPaa } = require('../lib/hanklevarmer');
const { Motor } = require('../lib/motor');
const { Spotpriser } = require('../lib/spotpris');
const { Vaer } = require('../lib/vaer');

const TIME = 3600000;
const MIN = 60000;
const oslo = (...a) => kal.osloTilUtc(...a);
const PERSONER = [
  { key: 'cybele', navn: 'Cybele', type: 'barn', natt: '19:00', dag: '05:30', borteFra: '08:00', borteTil: '15:00' },
  { key: 'sebastian', navn: 'Sebastian', type: 'ungdom', natt: '23:00', vekking: '07:00', vekkingHelg: '09:30' },
  { key: 'rune', navn: 'Rune', type: 'voksen' },
];
const alle = (v) => ({ cybele: v, sebastian: v, rune: v });
const INNST = { dagStart: '06:00', nattStart: '23:00' };

// ----------------------------------------------------------------------
//  Bortemodus og hjemkomst
// ----------------------------------------------------------------------
test('bortemodus slår seg på etter tre timer uten noen hjemme, og av når noen kommer', () => {
  const h = new Hus({}, { personer: PERSONER });
  let ms = oslo(2026, 11, 20, 15);                      // fredag
  assert.deepEqual(h.tick(ms, alle(true)), []);
  h.tick(ms += 10 * MIN, { cybele: false, sebastian: false, rune: true });
  assert.equal(h.alleBorte(), false);
  h.tick(ms += 10 * MIN, alle(false));
  assert.equal(h.t.borte, false);
  h.tick(ms += 2 * TIME, alle(false));
  assert.equal(h.t.borte, false);
  const paa = h.tick(ms += 61 * MIN, alle(false));
  assert.deepEqual(paa.map((x) => x.type), ['borte_paa']);
  assert.equal(h.bilde(ms).modus, 'Borte');
  const hjem = h.tick(ms += 40 * TIME, { cybele: false, sebastian: true, rune: false });
  assert.deepEqual(hjem.map((x) => x.type), ['kom_hjem']);
  assert.equal(h.t.borte, false);
});

test('bortemodus satt for hånd mens noen er hjemme står til dere har dratt og kommet tilbake', () => {
  const h = new Hus({}, { personer: PERSONER });
  let ms = oslo(2026, 11, 20, 15);
  h.tick(ms, alle(true));
  h.settBorte(true, ms);
  assert.deepEqual(h.tick(ms += MIN, alle(true)), []);
  assert.equal(h.t.borte, true);
  h.tick(ms += TIME, alle(false));
  assert.deepEqual(h.tick(ms += 20 * TIME, alle(true)).map((x) => x.type), ['kom_hjem']);
});

test('ukjent tilstedeværelse rører ikke bortemodus, og «helg» slår bare inn torsdag og fredag', () => {
  const h = new Hus({}, { personer: PERSONER, borteAutoDager: 'helg' });
  let ms = oslo(2026, 11, 23, 8);                       // mandag
  h.tick(ms, alle(false));
  assert.deepEqual(h.tick(ms += 5 * TIME, alle(false)), []);
  assert.equal(h.t.borte, false);
  h.settBorte(true, ms);
  assert.deepEqual(h.tick(ms += TIME, alle(null)), []);
  assert.equal(h.t.borte, true);
  assert.equal(new Hus({}, { personer: [] }).alleBorte(), null);
});

test('fast hjemkomst søndag kl. 13: gjelder i bortemodus, også etter at tiden er passert', () => {
  const h = new Hus({ borte: true }, { personer: PERSONER });
  const fredag = oslo(2026, 11, 20, 20);
  assert.equal(h.hjemkomstMs(fredag), oslo(2026, 11, 22, 13));
  assert.equal(h.hjemkomstMs(oslo(2026, 11, 22, 15)), oslo(2026, 11, 22, 13));
  assert.equal(h.bilde(oslo(2026, 11, 22, 15)).modus, 'Venter på dere');
  assert.equal(h.bilde(oslo(2026, 11, 22, 6)).modus, 'Borte — varmer til hjemkomst');
  assert.equal(h.hjemkomstMs(oslo(2026, 11, 23, 9)), oslo(2026, 11, 29, 13));     // mandag: neste søndag
  assert.equal(new Hus({ borte: false }, {}).hjemkomstMs(fredag), null);
  assert.equal(new Hus({ borte: true }, { forvarmHjemkomst: false }).hjemkomstMs(fredag), null);
  // «Forleng»: søndagen hoppes over
  h.forleng(oslo(2026, 11, 22, 8));
  assert.equal(h.hjemkomstMs(oslo(2026, 11, 22, 9)), null);
  assert.equal(h.hjemkomstMs(oslo(2026, 11, 23, 9)), oslo(2026, 11, 29, 13));
});

test('satt hjemkomst: klokkeslett blir neste gang det inntreffer, og ingen ankomst gir bortetemperatur igjen', () => {
  const h = new Hus({}, { personer: PERSONER });
  const naa = oslo(2026, 11, 24, 18);
  assert.equal(h.settHjemkomst('17:00', naa), oslo(2026, 11, 25, 17));
  assert.equal(h.t.borte, true);
  h.tick(naa, alle(false));
  assert.deepEqual(h.tick(oslo(2026, 11, 25, 22), alle(false)), []);
  assert.deepEqual(h.tick(oslo(2026, 11, 25, 23, 1), alle(false)).map((x) => x.type), ['kom_ikke']);
  assert.equal(h.t.hjemkomst, null);
  assert.equal(h.t.borte, true);
});

// ----------------------------------------------------------------------
//  Programmet med personer og bortemodus
// ----------------------------------------------------------------------
test('Cybele: natt fra 19, borte på dagtid, og hjemme når hun faktisk er det', () => {
  const sone = { profil: 'person:cybele', dag: 22, natt: 20 };
  const p = (hjemme) => ({ personer: { cybele: { ...PERSONER[0], hjemme } } });
  const krav = (t, m, hjemme, naa = null) => kravVed(sone, oslo(2026, 11, 24, t, m), INNST, null, { ...p(hjemme), naaMs: naa ?? oslo(2026, 11, 24, t, m) });
  assert.equal(krav(20, 0, true).min, 20);
  assert.equal(krav(5, 0, true).min, 20);
  assert.equal(krav(5, 30, true).min, 22);
  assert.equal(krav(10, 0, false).min, 20);                         // på skolen
  assert.equal(krav(10, 0, true).min, 22);                          // hjemme en tirsdag
  // Framover i tid gjelder klokka: kl. 10 sett fra kl. 06 er «borte», kl. 16 er «hjemme»
  assert.equal(krav(10, 0, true, oslo(2026, 11, 24, 6)).min, 20);
  assert.equal(krav(16, 0, false, oslo(2026, 11, 24, 6)).min, 22);
  // Lørdag er hun hjemme på dagtid etter klokka
  assert.equal(kravVed(sone, oslo(2026, 11, 28, 10), INNST, null, { ...p(null), naaMs: oslo(2026, 11, 28, 4) }).min, 22);
});

test('Sebastian: sover til kl. 07 på hverdager og 09:30 i helgen', () => {
  const sone = { profil: 'person:sebastian', dag: 21, natt: 18 };
  const kx = { personer: { sebastian: { ...PERSONER[1], hjemme: true } } };
  const krav = (dag, t, m) => kravVed(sone, oslo(2026, 11, dag, t, m), INNST, null, kx).min;
  assert.equal(krav(24, 6, 30), 18);          // tirsdag morgen
  assert.equal(krav(24, 7, 0), 21);
  assert.equal(krav(28, 8, 0), 18);           // lørdag morgen
  assert.equal(krav(28, 9, 30), 21);
  assert.equal(krav(27, 23, 30), 18);         // fredag kveld: natt
  assert.equal(krav(27, 22, 0), 21);
});

test('bortemodus går foran programmet, og fra hjemkomsten gjelder dagtemperatur', () => {
  const stue = { profil: 'fellesrom', type: 'panel', dag: 22, natt: 19 };
  const bad = { profil: 'konstant', type: 'gulv', dag: 24 };
  const hjem = oslo(2026, 11, 22, 13);
  const kx = { borte: true, hjemkomstMs: hjem, naaMs: oslo(2026, 11, 21, 12) };
  assert.equal(kravVed(stue, oslo(2026, 11, 21, 12), INNST, null, kx).min, 16);
  assert.equal(kravVed(bad, oslo(2026, 11, 21, 12), INNST, null, kx).min, 22);
  assert.equal(kravVed({ ...stue, type: 'gulv' }, oslo(2026, 11, 21, 12), INNST, null, kx).min, 18);
  assert.equal(kravVed(stue, hjem, INNST, null, kx).min, 22);
  assert.equal(kravVed(stue, hjem + 12 * TIME, INNST, null, kx).min, 22);          // natt, men dere ventes
  assert.equal(kravVed(stue, oslo(2026, 11, 21, 12), INNST, null, { ...kx, bortetemp: 13.5 }).min, 13.5);
  assert.equal(kravVed(stue, oslo(2026, 11, 21, 12), INNST, { temp: 20, tilMs: hjem }, kx).min, 20);   // overstyring vinner
});

// ----------------------------------------------------------------------
//  Motoren i bortemodus
// ----------------------------------------------------------------------
test('lært rom i bortemodus: laveste temperatur som rekker, og oppvarming i tide til hjemkomst', () => {
  const laering = { soner: { stue: { k: 0.05, varme_rate: 1.5, rate_max: 2.0, n: 20 } } };
  const m = new Motor({ laering }, { soner: [{ key: 'stue', navn: 'Stue', type: 'panel', prio: 3, nominell: 2, profil: 'fellesrom', dag: 22, natt: 19 }], skygge: false, forvarmingMaksTimer: 12 });
  const flattVaer = (fra, temp) => new Vaer(Array.from({ length: 60 }, (_, n) => ({ ms: fra + n * TIME, temp })), fra);
  // −5 ute: fra T til 22 må ta høyst 12 t / 1,3 = 9,2 t → 14,5 °C (samme tall som i Home Assistant-versjonen)
  assert.equal(m.bortetemp(m.soner()[0], Array(36).fill(-5)), 14.5);
  assert.equal(m.bortetemp(m.soner()[0], Array(36).fill(8)), 12);
  assert.ok(m.bortetemp(m.soner()[0], Array(36).fill(-12)) > 14.5, 'kaldere vær gir høyere bortetemperatur');
  // −18: ovnen når ikke 22 °C uansett — da gjelder den faste bortetemperaturen
  assert.equal(m.bortetemp(m.soner()[0], Array(36).fill(-18)), null);

  const hjem = oslo(2026, 11, 22, 13);
  const kjor = (ms, temp) => m.tick({
    ms, kalk: null, spot: new Spotpriser(), vaer: flattVaer(ms - TIME, -5), uteMaalt: -5, totalW: 400, timeKwh: 0.2,
    maalinger: { stue: { temp, settpunkt: 16, effektW: 0, levende: true } },
    kontekst: { naaMs: ms, borte: true, hjemkomstMs: hjem, personer: {} },
  }).soner[0];
  const lordag = kjor(oslo(2026, 11, 21, 15), 15.0);
  assert.equal(lordag.krav, 14.5);
  assert.equal(lordag.mal, 14.5);
  assert.match(lordag.grunn, /Bortemodus/);
  // Søndag kl. 01: tolv timer før — fortsatt bortetemperatur
  assert.equal(kjor(oslo(2026, 11, 22, 1, 5), 14.6).mal, 14.5);
  // Søndag kl. 07: seks timer før — oppvarmingen er i gang
  const morgen = kjor(oslo(2026, 11, 22, 7, 5), 16.0);
  assert.ok(morgen.mal >= 17, `mål kl. 07: ${morgen.mal}`);
  assert.match(morgen.grunn, /Forvarming/);
  // Etter kl. 13 uten at noen er kommet: dagtemperatur
  const etter = kjor(oslo(2026, 11, 22, 14), 21.8);
  assert.equal(etter.krav, 22);
});

test('berederen holder av effekt, og annet styrt forbruk regnes ikke som uregulert', () => {
  const m = new Motor({}, { soner: [{ key: 'stue', navn: 'Stue', prio: 3, nominell: 2, dag: 22, natt: 19 }], skygge: false });
  const ms = oslo(2026, 11, 23, 23, 30);
  const inn = { ms, kalk: null, spot: new Spotpriser(), vaer: new Vaer(), uteMaalt: 0, totalW: 3500, timeKwh: 1.0, maalinger: { stue: { temp: 18, settpunkt: 19, effektW: 1500, levende: true } } };
  const uten = m.tick(inn);
  const med = m.tick({ ...inn, reservertKw: 2.0, annetStyrtW: 2000 });
  assert.equal(uten.uregulert_kw, 2);
  assert.equal(med.uregulert_kw, 0);
  assert.equal(med.reservert_kw, 2);
  assert.ok(med.forventet_kw > uten.forventet_kw - 2 + 1.9);
});

// ----------------------------------------------------------------------
//  Vaner og håndklevarmer
// ----------------------------------------------------------------------
test('vanene lærer hjemkomst etter turer, og foreslår ny tid', () => {
  const v = new Vaner({});
  for (const uke of [1, 8, 15, 22]) v.ankomst(oslo(2026, 11, uke, 14, 0), 40 * TIME);      // søndager kl. 14
  v.ankomst(oslo(2026, 11, 3, 16, 0), 2 * TIME);                                           // en kort tur teller ikke
  assert.equal(v.hjemkomstMinutter(6), 14 * 60);
  assert.equal(v.hjemkomstMinutter(1), null);
  const forslag = v.forslag({ dagStart: '06:00', hjemkomstUkedag: 6, hjemkomstTid: '13:00' });
  assert.equal(forslag.length, 1);
  assert.equal(forslag[0].verdi, '14:00');
  assert.match(forslag[0].tekst, /søndag kl\. 14:00/);
  // Huset bruker lært tid når det er slått på
  const h = new Hus({ borte: true }, { vanerStyrer: true });
  assert.equal(h.hjemkomstMs(oslo(2026, 11, 28, 12), v), oslo(2026, 11, 29, 14));
  assert.equal(h.hjemkomstMs(oslo(2026, 11, 28, 12), new Vaner({})), oslo(2026, 11, 29, 13));
});

test('vanene finner når huset våkner', () => {
  const v = new Vaner({});
  for (let dag = 23; dag <= 27; dag++) {                 // mandag–fredag
    for (let min = 60; min < 11 * 60; min += 5) {
      const kw = min < 7 * 60 + 10 ? 0.4 : 1.5;         // våkner 07:10
      v.last(oslo(2026, 11, dag, Math.floor(min / 60), min % 60), kw);
    }
  }
  assert.equal(v.m.morgen.hverdag.n, 5);
  assert.equal(v.m.morgen.hverdag.min, 7 * 60 + 10);
  const f = v.forslag({ dagStart: '06:00', hjemkomstUkedag: null });
  assert.equal(f[0].type, 'dagstart');
  assert.equal(f[0].verdi, '06:40');
});

test('håndklevarmeren følger vinduene og hviler når huset er tomt eller timen er trang', () => {
  const kl = (t, m = 0) => oslo(2026, 11, 24, t, m);
  assert.equal(skalPaa(kl(6, 30), {}).paa, true);
  assert.equal(skalPaa(kl(8, 0), {}).paa, false);
  assert.equal(skalPaa(kl(20, 0), {}).paa, true);
  assert.equal(skalPaa(kl(12, 0), {}).paa, false);
  assert.equal(skalPaa(kl(6, 30), {}, { borte: true }).paa, false);
  assert.equal(skalPaa(kl(6, 30), {}, { trangt: true }).paa, false);
  assert.equal(skalPaa(kl(5, 30), { morgenStart: '05:00' }).paa, true);
});
