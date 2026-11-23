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
  s.b = new Bereder({ siste_syklus: start - 86400000 }, { bryter: { enhet: 'vvb', kap: 'onoff' }, effekt: { enhet: 'vvb', kap: 'measure_power' }, ...innst });
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

test('utenfor vinduet uten oppvarming slås releet av', () => {
  const s = oppsett(oslo(2026, 11, 23, 12));
  s.bryter = true;
  s.minutter(2);
  assert.equal(s.bryter, false);
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

test('allerede varm, dødt relé, manuell og alltid på', () => {
  const s = oppsett(oslo(2026, 11, 23, 22, 30));
  s.b.m.siste_syklus = s.ms - 5 * 86400000;
  s.tick();
  s.minutter(12);                        // på, men trekker ingenting
  assert.ok(s.hendelser.includes('allerede_varm'));
  assert.ok(s.b.dagerSiden(s.ms) < 0.01);
  assert.equal(s.bryter, false);
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
