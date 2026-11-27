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
  const m = new Motor({ modeller: { rom: { stue: require('../lib/rommodell').ferdigLaert({ r: 2.0, k: 0.05 }) } } }, { soner: [{ key: 'stue', navn: 'Stue', type: 'panel', prio: 3, nominell: 2, profil: 'fellesrom', dag: 22, natt: 19 }], skygge: false, forvarmingMaksTimer: 12 });
  const flattVaer = (fra, temp) => new Vaer(Array.from({ length: 60 }, (_, n) => ({ ms: fra + n * TIME, temp })), fra);
  // −5 ute: fra T til 22 må ta høyst 12 t / 1,3 = 9,2 t. Planen regner forsiktig (litt svakere ovn og
  // litt større tap enn lært), så den lander en halv grad over det nøyaktige svaret på 14,5 °C.
  assert.equal(m.bortetemp(m.soner()[0], Array(36).fill(-5)), 15);
  assert.equal(m.bortetemp(m.soner()[0], Array(36).fill(8)), 12);
  assert.ok(m.bortetemp(m.soner()[0], Array(36).fill(-12)) > 15, 'kaldere vær gir høyere bortetemperatur');
  // −18: ovnen når ikke 22 °C uansett — da gjelder den faste bortetemperaturen
  assert.equal(m.bortetemp(m.soner()[0], Array(36).fill(-18)), null);

  const hjem = oslo(2026, 11, 22, 13);
  const kjor = (ms, temp) => m.tick({
    ms, kalk: null, spot: new Spotpriser(), vaer: flattVaer(ms - TIME, -5), uteMaalt: -5, totalW: 400, timeKwh: 0.2,
    maalinger: { stue: { temp, settpunkt: 16, effektW: 0, levende: true } },
    kontekst: { naaMs: ms, borte: true, hjemkomstMs: hjem, personer: {} },
  }).soner[0];
  const lordag = kjor(oslo(2026, 11, 21, 15), 15.6);
  assert.equal(lordag.krav, 15);
  // Bortetemperaturen er den laveste som akkurat rekker: planen holder seg på eller like over den.
  assert.ok(lordag.mal >= 15 && lordag.mal <= 15.5, `mål: ${lordag.mal}`);
  // Søndag kl. 01: tolv timer før — fortsatt bortetemperatur
  assert.ok(kjor(oslo(2026, 11, 22, 1, 5), 15.6).mal <= 16);
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
  assert.equal(skalPaa(kl(6, 30), {}, { trangt: true }).paa, true, 'timebudsjettet styrer ikke 100 W');
  assert.equal(skalPaa(kl(5, 30), { morgenStart: '05:00' }).paa, true);
});

test('håndklevarmeren settes ved skiftene, følges opp et kvarter, og det du gjør selv får stå', () => {
  const { skriv } = require('../lib/hanklevarmer');
  const MIN = 60000;
  const t = {};
  const kl6 = oslo(2026, 11, 23, 6, 0);
  // Vinduet åpner: slås på. Releet svarer ikke med en gang — det prøves igjen.
  assert.equal(skriv(t, kl6, true, false), true);
  assert.equal(skriv(t, kl6 + 4 * MIN, true, false), true);
  assert.equal(skriv(t, kl6 + 5 * MIN, true, true), null);
  // Kl. 07 slår du den av selv: den får stå av
  assert.equal(skriv(t, kl6 + 60 * MIN, true, false), null);
  // Kl. 08 stenger vinduet: den er alt av, ingenting å gjøre
  assert.equal(skriv(t, kl6 + 120 * MIN, false, false), null);
  // Kl. 12 slår du den på selv: den får stå på til kveldsvinduet stenger
  assert.equal(skriv(t, kl6 + 360 * MIN, false, true), null);
  assert.equal(skriv(t, oslo(2026, 11, 23, 19, 0), true, true), null);
  assert.equal(skriv(t, oslo(2026, 11, 23, 22, 0), false, true), false);
  // Releet svarer ikke: ingenting skrives
  assert.equal(skriv(t, oslo(2026, 11, 23, 22, 1), false, null), null);
  // Første kjøring etter omstart: tilstanden settes
  assert.equal(skriv({}, kl6, true, false), true);
});

// ----------------------------------------------------------------------
//  Varsler: helg, ferie og hjemkomst
// ----------------------------------------------------------------------
function husMedPerson(innst = {}) {
  const { Hus } = require('../lib/hus');
  const h = new Hus({}, { personer: [{ key: 'a', navn: 'A', type: 'voksen' }], borteAutoTimer: 3, ...innst });
  h.typer = [];
  h.tekster = [];
  h.gaa = (ms, hjemme, varme) => { const ut = h.tick(ms, { a: hjemme }, null, varme); h.typer.push(...ut.map((x) => x.type)); h.tekster.push(...ut.map((x) => x.tekst)); return ut; };
  return h;
}

test('helgespørsmålet: torsdag kl. 17, én påminnelse fredag hvis dere er hjemme og ikke har svart', () => {
  const h = husMedPerson();
  h.gaa(oslo(2026, 11, 26, 16, 59), true);                 // torsdag
  assert.deepEqual(h.typer, []);
  const ut = h.gaa(oslo(2026, 11, 26, 17, 0), true);
  assert.deepEqual(ut.map((x) => [x.type, x.varsle]), [['helg_sporsmaal', true]]);
  h.gaa(oslo(2026, 11, 26, 20, 0), true);
  h.gaa(oslo(2026, 11, 27, 12, 0), true);
  assert.equal(h.typer.length, 1, 'spør ikke på nytt før fredag kl. 17');
  h.gaa(oslo(2026, 11, 27, 17, 0), true);
  assert.match(h.tekster[1], /fortsatt hjemme/);
  h.gaa(oslo(2026, 11, 27, 19, 0), true);
  h.gaa(oslo(2026, 11, 28, 17, 0), true);
  assert.equal(h.typer.length, 2, 'aldri mer enn to ganger');
  // Uka etter spørres det på nytt
  h.gaa(oslo(2026, 12, 3, 17, 0), true);
  assert.equal(h.typer.length, 3);
  // Slått av: flow-kortet utløses fortsatt, men uten varsel
  const av = husMedPerson({ varsler: { helg: false } });
  assert.equal(av.gaa(oslo(2026, 11, 26, 17, 0), true)[0].varsle, false);
});

test('svaret «bort» senker huset i det siste person drar; «hjemme» hindrer automatisk bortemodus', () => {
  const bort = husMedPerson();
  bort.gaa(oslo(2026, 11, 26, 17, 0), true);
  assert.match(bort.svarHelg('bort', oslo(2026, 11, 26, 17, 5)), /søndag kl\. 13:00/);
  bort.gaa(oslo(2026, 11, 27, 15, 0), true);
  assert.equal(bort.t.borte, false);
  bort.gaa(oslo(2026, 11, 27, 15, 1), false);              // siste person drar fredag
  assert.equal(bort.t.borte, true, 'uten å vente tre timer');
  assert.match(bort.tekster[bort.tekster.length - 1], /varmt igjen søndag kl\. 13:00/);
  // Ingen påminnelse fredag kl. 17: det er svart
  bort.gaa(oslo(2026, 11, 27, 17, 0), false);
  assert.equal(bort.typer.filter((x) => x === 'helg_sporsmaal').length, 1);

  const hjemme = husMedPerson();
  hjemme.svarHelg('hjemme', oslo(2026, 11, 26, 17, 5));
  hjemme.gaa(oslo(2026, 11, 28, 10, 0), false);
  hjemme.gaa(oslo(2026, 11, 28, 16, 0), false);            // seks timer på tur
  assert.equal(hjemme.t.borte, false);
  // Uka etter gjelder ikke svaret lenger
  hjemme.gaa(oslo(2026, 12, 1, 10, 0), false);
  hjemme.gaa(oslo(2026, 12, 1, 14, 0), false);
  assert.equal(hjemme.t.borte, true);
});

test('hjemkomst: varsel når oppvarmingen starter og når huset er klart, én gang hver', () => {
  const h = husMedPerson();
  h.gaa(oslo(2026, 11, 27, 10, 0), false);
  h.gaa(oslo(2026, 11, 27, 13, 1), false);                 // bortemodus etter tre timer
  assert.deepEqual(h.typer, ['borte_paa']);
  h.gaa(oslo(2026, 11, 29, 6, 0), false, { forvarmer: false });
  h.gaa(oslo(2026, 11, 29, 7, 0), false, { forvarmer: true });
  h.gaa(oslo(2026, 11, 29, 8, 0), false, { forvarmer: true });
  assert.deepEqual(h.typer.slice(1), ['forvarmer']);
  assert.match(h.tekster[1], /søndag kl\. 13:00 har startet/);
  h.gaa(oslo(2026, 11, 29, 13, 0), false, { kalde: [{ navn: 'Stue', temp: 20.5, krav: 22 }] });
  h.gaa(oslo(2026, 11, 29, 13, 5), false, { kalde: [] });
  assert.deepEqual(h.typer.slice(2), ['hjemkomst_klar']);
  assert.match(h.tekster[2], /ikke helt varmt ennå: Stue 20,5 °C av 22/);
  // Noen kommer: velkommen hjem
  h.gaa(oslo(2026, 11, 29, 14, 0), true);
  assert.equal(h.typer[3], 'kom_hjem');
  // Alt varmt gir den hyggelige utgaven
  const varm = husMedPerson();
  varm.settHjemkomst('13:00', oslo(2026, 11, 29, 8, 0));
  assert.match(varm.gaa(oslo(2026, 11, 29, 13, 0), false, { kalde: [] })[0].tekst, /varmt og klart/);
});

test('ferie: ingen kom til planlagt tid, og den faste ukentlige oppvarmingen hoppes over til noen kommer', () => {
  const h = husMedPerson();
  h.gaa(oslo(2026, 11, 27, 10, 0), false);
  h.gaa(oslo(2026, 11, 27, 13, 1), false);
  h.gaa(oslo(2026, 11, 29, 13, 0), false);                 // søndag: ventet hjem
  h.gaa(oslo(2026, 11, 29, 19, 1), false);                 // seks timer senere: ingen kom
  assert.ok(h.typer.includes('kom_ikke'));
  assert.equal(h.bilde(oslo(2026, 11, 29, 20, 0)).modus, 'Ferie');
  // Neste søndag varmes det ikke opp
  assert.equal(h.hjemkomstMs(oslo(2026, 12, 6, 9, 0)), null);
  // Du sier fra: da er det varmt til dere kommer
  const til = h.settHjemkomst(oslo(2026, 12, 12, 15, 0), oslo(2026, 12, 10, 9, 0));
  assert.equal(h.hjemkomstMs(oslo(2026, 12, 12, 9, 0)), til);
  h.gaa(oslo(2026, 12, 12, 15, 30), true);
  assert.match(h.tekster[h.tekster.length - 1], /Velkommen hjem fra ferie/);
  assert.equal(h.t.ferie, false);
  // Og uka etter er den faste hjemkomsten tilbake
  h.gaa(oslo(2026, 12, 18, 10, 0), false);
  h.gaa(oslo(2026, 12, 18, 13, 1), false);
  assert.ok(h.hjemkomstMs(oslo(2026, 12, 19, 9, 0)) !== null);
});

test('ferie satt for hånd, med og uten hjemkomstdato', () => {
  const h = husMedPerson();
  const til = oslo(2026, 12, 27, 13, 0);
  h.settFerie(til, oslo(2026, 12, 20, 9, 0));
  const ut = h.gaa(oslo(2026, 12, 20, 9, 1), true);         // dere er fortsatt hjemme og pakker
  assert.deepEqual(ut.map((x) => x.type), ['ferie']);
  assert.match(ut[0].tekst, /varmt igjen søndag 27\.12\. kl\. 13:00/);
  assert.equal(h.hjemkomstMs(oslo(2026, 12, 21, 9, 0)), til);
  const uten = husMedPerson({ hjemkomstUkedag: null });
  uten.settFerie(null, oslo(2026, 12, 20, 9, 0));
  assert.match(uten.gaa(oslo(2026, 12, 20, 9, 1), false)[0].tekst, /Si fra når dere kommer/);
  // Uten fast hjemkomst blir et hus som står tomt i to døgn regnet som ferie av seg selv
  const auto = husMedPerson({ hjemkomstUkedag: null });
  auto.gaa(oslo(2026, 12, 20, 9, 0), false);
  auto.gaa(oslo(2026, 12, 20, 12, 1), false);
  auto.gaa(oslo(2026, 12, 21, 12, 0), false);
  assert.ok(!auto.typer.includes('ferie'));
  auto.gaa(oslo(2026, 12, 22, 9, 1), false);
  assert.ok(auto.typer.includes('ferie'));
});
