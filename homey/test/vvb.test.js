'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Bereder } = require('../lib/vvb');
const { Spotpriser } = require('../lib/spotpris');

const MIN = 60000;
const TIME = 3600000;
const oslo = (...a) => kal.osloTilUtc(...a);

/** En bereder med relé som gjør det styringen ber om. */
function oppsett(start, innst = {}) {
  const s = { ms: start, bryter: false, effekt: 0, kall: [], hendelser: [], kontekst: {}, spot: new Spotpriser() };
  s.b = new Bereder({ siste_syklus: start - 86400000 }, { bryter: { enhet: 'vvb', kap: 'onoff' }, effekt: { enhet: 'vvb', kap: 'measure_power' }, metningMinutter: 8, ...innst });
  s.tick = () => {
    const r = s.b.tick({ ms: s.ms, bryter: s.bryter, effektW: s.effekt, spot: s.spot, kontekst: s.kontekst });
    if (r.paa !== null) { s.kall.push(r.paa ? 'paa' : 'av'); s.bryter = r.paa; }
    s.hendelser.push(...r.hendelser.map((h) => h.type));
    return r;
  };
  s.minutter = (n) => { let r; for (let i = 0; i < n; i++) { s.ms += MIN; r = s.tick(); } return r; };
  return s;
}

test('varmer i vinduet, slår av når termostaten kobler ut, og er ferdig for natta', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 30));
  s.tick();
  assert.equal(s.bryter, true);
  s.effekt = 2000;
  s.minutter(90);
  assert.equal(s.b.m.var_aktiv, true);
  s.effekt = 3;
  const r = s.minutter(9);
  assert.equal(s.bryter, false);
  assert.ok(s.hendelser.includes('mettet'));
  assert.equal(r.bilde.legionella_ok, true);
  s.minutter(120);
  assert.deepEqual(s.kall, ['paa', 'av'], 'skal ikke slå på igjen samme natt');
  assert.equal(s.b.bilde(s.ms, false, 0, {}).status, 'Ferdig for i natt');
});

test('slås ikke av midt i oppvarmingen selv om vinduet stenger og måleren glipper', () => {
  const s = oppsett(oslo(2026, 11, 24, 4, 40));
  s.tick();
  s.effekt = 2000;
  s.minutter(30);                       // forbi kl. 05
  for (const glipp of [0, null]) {
    s.effekt = glipp; s.minutter(1);
    s.effekt = 2000; s.minutter(1);
  }
  assert.deepEqual(s.kall, ['paa']);
  s.effekt = 3;
  s.minutter(10);
  assert.equal(s.bryter, false);
  assert.ok(s.b.dagerSiden(s.ms) < 0.01, 'metning etter vinduet skal bekrefte legionella');
});

test('utenfor vinduet uten strømtrekk slås releet av etter en stund', () => {
  const s = oppsett(oslo(2026, 11, 23, 12));
  s.bryter = true;
  s.minutter(5);
  assert.equal(s.bryter, true, 'får først en sjanse til å vise at den varmer');
  s.minutter(8);
  assert.equal(s.bryter, false);
});

test('noen slår den på midt på dagen: den får varme ferdig', () => {
  const s = oppsett(oslo(2026, 11, 23, 12));
  s.bryter = true; s.effekt = 2000;
  s.minutter(90);
  assert.deepEqual(s.kall, []);
  s.effekt = 3; s.minutter(9);
  assert.deepEqual(s.kall, ['av']);
  assert.ok(s.hendelser.includes('mettet'));
});

test('tvungen syklus og boost går til vannet er varmt, og releet klikker ikke', () => {
  const s = oppsett(oslo(2026, 11, 23, 13));
  s.b.m.siste_syklus = s.ms - 10 * TIME;
  s.b.tvingSyklus();
  s.tick();
  assert.equal(s.bryter, true);
  s.effekt = 2000; s.minutter(5);
  s.effekt = 3; s.minutter(10);
  assert.equal(s.bryter, false);
  assert.equal(s.b.m.tvungen, false);
  s.b.boost(s.ms, 120);
  s.minutter(1);
  s.effekt = 2000; s.minutter(20);
  s.effekt = 3; s.minutter(60);
  assert.deepEqual(s.kall, ['paa', 'av', 'paa', 'av']);
  assert.equal(s.b.boostAktiv(s.ms), false);
});

test('legionellafristen tvinger oppvarming uansett tid, pris og bortemodus', () => {
  const s = oppsett(oslo(2026, 11, 23, 13));
  s.b.m.siste_syklus = s.ms - 8 * 86400000;
  s.kontekst = { borte: true, trangt: true };
  const r = s.tick();
  assert.equal(s.bryter, true);
  assert.ok(s.hendelser.includes('legionella'));
  assert.equal(r.bilde.status, 'Tvungen kjøring');
  assert.deepEqual(s.b.reservasjon(s.ms, true, 0, s.kontekst), { kw: 2, maa: true });
});

test('bortemodus: berederen hviler, men varmer før dere kommer og når fristen nærmer seg', () => {
  const s = oppsett(oslo(2026, 11, 21, 23));           // lørdag kveld, i vinduet
  s.kontekst = { borte: true, hjemkomstMs: oslo(2026, 11, 22, 13) };
  s.tick();
  assert.equal(s.bryter, false);
  assert.equal(s.b.bilde(s.ms, false, 0, s.kontekst).status, 'Hviler (borte)');
  s.ms = oslo(2026, 11, 22, 3);                         // ti timer før: fortsatt hvile
  s.tick();
  assert.equal(s.bryter, false);
  s.ms = oslo(2026, 11, 22, 4, 30);                     // i vinduet, men mer enn 3 t før
  s.tick();
  assert.equal(s.bryter, false);
  // Nær legionellafristen varmes det i vinduet selv om huset er tomt
  s.b.m.siste_syklus = s.ms - 6.2 * 86400000;
  s.tick();
  assert.equal(s.bryter, true);
});

test('spotpris: bare de billigste timene fram til fristen, og vinduet når prisene mangler', () => {
  const start = oslo(2026, 11, 23, 22);
  const s = oppsett(start, { folgSpotpris: true, billigsteTimer: 2 });
  // 22: 1,0  23: 0,9  00: 0,3  01: 0,2  02: 0,8  03: 0,7  04: 0,6
  [1.0, 0.9, 0.3, 0.2, 0.8, 0.7, 0.6, 2, 2].forEach((p, n) => s.spot.leggTil([{ start: start + n * TIME, slutt: start + (n + 1) * TIME, pris: p }]));
  s.tick();
  assert.equal(s.bryter, false, 'kl. 22 er ikke blant de billigste');
  assert.deepEqual(s.b.m.billige.map((t) => kal.osloDeler(t).time), [0, 1]);
  s.ms = oslo(2026, 11, 24, 0, 5);
  s.tick();
  assert.equal(s.bryter, true);
  // Norgespris: prisen er lik hele natta, vinduet gjelder
  const n = oppsett(start, { folgSpotpris: true, billigsteTimer: 2 });
  n.spot = s.spot; n.kontekst = { norgespris: true };
  n.tick();
  assert.equal(n.bryter, true);
  // Priskilden nede: vinduet gjelder
  const u = oppsett(start, { folgSpotpris: true });
  u.tick();
  assert.equal(u.bryter, true);
});

test('trang time utsetter starten, men stopper ikke en oppvarming som går', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 30));
  s.kontekst = { trangt: true };
  s.tick();
  assert.equal(s.bryter, false);
  s.kontekst = {};
  s.tick();
  s.effekt = 2000; s.minutter(3);
  s.kontekst = { trangt: true };
  s.minutter(5);
  assert.equal(s.bryter, true);
  assert.deepEqual(s.b.reservasjon(s.ms, true, 2000, s.kontekst), { kw: 2, maa: true });
});

test('på uten strømtrekk, dødt relé, manuell og alltid på', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 30));
  s.b.m.siste_syklus = s.ms - 5 * 86400000;
  s.tick();
  s.minutter(60);                        // på, men trekker ingenting: blir stående — termostaten bestemmer
  assert.equal(s.bryter, true);
  assert.equal(s.b.bilde(s.ms, true, 0, {}).status, 'På, trekker ikke strøm');
  s.ms = oslo(2026, 11, 24, 5, 0); s.minutter(2);
  assert.equal(s.bryter, false, 'slås av når vinduet er slutt');
  // Uten målt strømtrekk er ingenting bekreftet: legionellatelleren står
  assert.ok(s.b.dagerSiden(s.ms) > 5);
  assert.ok(!s.hendelser.includes('mettet'));
  // Gjentar det seg neste natt, sier vi fra: da måler trolig ikke releet berederen
  s.ms = oslo(2026, 11, 24, 22, 30); s.minutter(30);
  s.ms = oslo(2026, 11, 25, 5, 0); s.minutter(2);
  assert.equal(s.hendelser.filter((h) => h === 'ingen_effekt').length, 1);
  // releet svarer ikke: ingenting røres
  const r = s.b.tick({ ms: s.ms, bryter: null, effektW: null, spot: s.spot, kontekst: {} });
  assert.equal(r.paa, null);
  assert.equal(r.bilde.status, 'Svarer ikke');
  // automatikken av: berederen står som den står
  const m = oppsett(oslo(2026, 11, 23, 12), { prisstyring: false });
  m.bryter = true; m.minutter(5);
  assert.deepEqual(m.kall, []);
  // alltid på: slås på og blir stående, også etter metning
  const a = oppsett(oslo(2026, 11, 23, 12), { alltidPa: true });
  a.tick(); a.effekt = 2000; a.minutter(5); a.effekt = 3; a.minutter(15);
  assert.deepEqual(a.kall, ['paa']);
});

test('nyinstallert om kvelden: berederen varmer den første natta', () => {
  const b = new Bereder({}, { bryter: { enhet: 'vvb', kap: 'onoff' } });
  const r = b.tick({ ms: oslo(2026, 11, 23, 22, 30), bryter: false, effektW: 0, spot: new Spotpriser(), kontekst: {} });
  assert.equal(r.paa, true);
  assert.equal(r.bilde.dager_siden_varm, 1);
});

test('fristen går foran: varmer selv om timen er trang når det ellers ikke rekker', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 30));
  s.kontekst = { trangt: true };
  s.minutter(60);
  assert.equal(s.bryter, false, 'tidlig i vinduet venter den når timen er trang');
  s.ms = oslo(2026, 11, 24, 1, 59);        // standard behov 180 min før kl. 05
  s.minutter(2);
  assert.equal(s.bryter, true);
  assert.equal(s.b.bilde(s.ms, true, 0, s.kontekst).status, 'Må rekke fristen');
  assert.deepEqual(s.b.reservasjon(s.ms, true, 0, s.kontekst), { kw: 2, maa: true });
});

test('fristen går foran de billigste timene, og kan slås av', () => {
  const start = oslo(2026, 11, 23, 23, 0);
  const s = oppsett(start, { folgSpotpris: true, billigsteTimer: 1 });
  s.b.m.billige = [oslo(2026, 11, 23, 23, 0)]; s.b.m.billige_ms = Infinity;      // bare én billig time, alt passert kl. 03
  s.ms = oslo(2026, 11, 24, 3, 0);
  assert.equal(s.b.borVarme(s.ms, false, 0, {}), true);
  s.b.settInnstillinger({ ...s.b.i, fristSjekk: false });
  assert.equal(s.b.borVarme(s.ms, false, 0, {}), false);
});

test('behovet læres av berederens egne oppvarminger', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 30));
  assert.equal(s.b.behovMin(), 180);
  s.tick(); s.effekt = 2000; s.minutter(100); s.effekt = 3; s.minutter(9);
  assert.equal(s.b.m.varigheter.length, 1);
  assert.equal(s.b.behovMin(), Math.round(s.b.m.varigheter[0] * 1.2 + 15));
});

test('morgensjekken: varm til fristen gir ingen alarm, kald gir varsel én gang', () => {
  const varm = oppsett(oslo(2026, 11, 23, 22, 30));
  varm.tick(); varm.effekt = 2000; varm.minutter(90); varm.effekt = 3; varm.minutter(9);
  varm.ms = oslo(2026, 11, 24, 4, 59);
  const r = varm.minutter(2);
  assert.equal(r.bilde.klar_til_frist, true);
  assert.ok(!varm.hendelser.includes('ikke_klar'));
  assert.match(r.bilde.frist_tekst, /Vannet var varmt kl\. 00:0\d/);

  const kald = oppsett(oslo(2026, 11, 24, 4, 50));
  kald.tick(); kald.effekt = 2000;
  const r2 = kald.minutter(30);
  assert.equal(r2.bilde.klar_til_frist, false);
  assert.equal(kald.hendelser.filter((h) => h === 'ikke_klar').length, 1);
  assert.match(r2.bilde.frist_tekst, /varmer fortsatt/);
});

test('morgensjekken alarmerer ikke når huset står tomt eller releet mangler effektmåling', () => {
  const borte = oppsett(oslo(2026, 11, 24, 4, 50));
  borte.kontekst = { borte: true };
  assert.equal(borte.minutter(20).bilde.klar_til_frist, null);
  const uten = oppsett(oslo(2026, 11, 24, 4, 50));
  uten.effekt = null;
  const r = uten.minutter(20);
  assert.equal(r.bilde.klar_til_frist, null);
  assert.match(r.bilde.frist_tekst, /ingen effektmåling/);
  assert.ok(!borte.hendelser.includes('ikke_klar') && !uten.hendelser.includes('ikke_klar'));
});

test('legionella: status og ett varsel når ønsket intervall er passert', () => {
  const s = oppsett(oslo(2026, 11, 24, 12, 0));
  assert.equal(s.tick().bilde.legionella, 'sikret');
  s.b.m.siste_syklus = s.ms - 3.5 * 86400000;
  const r = s.minutter(3);
  assert.equal(r.bilde.legionella, 'bor_varmes');
  assert.equal(r.bilde.legionella_ok, false);
  assert.equal(s.hendelser.filter((h) => h === 'legionella_varsel').length, 1);
  s.b.m.siste_syklus = s.ms - 8 * 86400000;
  assert.equal(s.minutter(1).bilde.legionella, 'forfalt');
  assert.ok(s.hendelser.includes('legionella'));
});

test('en oppvarming som er startet, avsluttes bare av berederens egen termostat', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 0), { metningMinutter: 12 });
  s.tick();
  assert.equal(s.bryter, true);
  // Berederen gjør selv timen trang, og effektmålingen fra releet henger noen minutter etter.
  // Før førte det til av og på i ring; nå blir den stående.
  s.kontekst = { trangt: true };
  s.minutter(4);
  assert.deepEqual(s.kall, ['paa']);
  s.effekt = 2000;
  s.minutter(120);
  // Termostaten tar en kort pause, og måleren faller ut et øyeblikk: fortsatt på
  s.effekt = 0; s.minutter(6);
  s.effekt = null; s.minutter(3);
  s.effekt = 2000;
  // Vinduet stenger kl. 05 mens den fortsatt varmer
  s.ms = oslo(2026, 11, 24, 5, 0); s.minutter(11);
  assert.deepEqual(s.kall, ['paa']);
  assert.equal(s.b.bilde(s.ms, true, 2000, s.kontekst).status, 'Varmer');
  // Like etter kl. 05:11 kobler termostaten ut. Releet venter tolv minutter før det slår av.
  s.effekt = 0;
  s.minutter(11);
  assert.deepEqual(s.kall, ['paa']);
  assert.equal(s.b.bilde(s.ms, true, 0, s.kontekst).status, 'Venter på termostaten');
  const r = s.minutter(2);
  assert.deepEqual(s.kall, ['paa', 'av']);
  assert.equal(kal.osloDeler(s.ms).minutt, 24);          // 05:24 — tolv minutter etter første måling uten strømtrekk
  assert.equal(s.hendelser.filter((h) => h === 'mettet').length, 1);
  // Loggen viser hva som skjedde og hvorfor
  assert.deepEqual(r.bilde.logg.map((h) => [h.paa, h.grunn.replace(/\d+ min/, 'N min')]), [[true, 'i vinduet'], [false, 'termostaten koblet ut etter N min']]);
  // Og den slår seg ikke på igjen etterpå
  s.minutter(120);
  assert.deepEqual(s.kall, ['paa', 'av']);
});

test('trang time utsetter bare starten', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 0));
  s.kontekst = { trangt: true };
  s.minutter(20);
  assert.deepEqual(s.kall, []);
  assert.match(s.b.avgjor(s.ms, false, 0, s.kontekst).grunn, /venter med å starte/);
  s.kontekst = {};
  s.minutter(1);
  assert.deepEqual(s.kall, ['paa']);
});
