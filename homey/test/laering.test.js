'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kal = require('../lib/kalender');
const { Simrom, MIN, LAT, LON } = require('./simhus');
const { Rommodeller, innsikt } = require('../lib/rommodell');
const { solposisjon, solmot } = require('../lib/sol');
const { simuler, simulerTreg, forvarmingMinutter } = require('../lib/termisk');
const { planlegg, settpunktNaa } = require('../lib/varmeplan');
const { Motor } = require('../lib/motor');
const { Vaer } = require('../lib/vaer');
const { Spotpriser } = require('../lib/spotpris');
const { kravVed } = require('../lib/program');

const TIME = 3600000;
const naer = (a, b, slakk, hva = '') => assert.ok(Math.abs(a - b) <= slakk, `${hva} ${a} ≠ ${b} (±${slakk})`);

/** La en vanlig termostat (22 °C dag, 18 °C natt) styre et simulert rom, og la modellen se på. */
function laer(sann, dager, valg = {}) {
  const rom = new Simrom(sann, valg);
  const m = new Rommodeller(valg.tilstand || {});
  let ms = Date.UTC(2026, 10, 1);
  for (let n = 0; n < dager * 1440; n++) {
    ms += MIN;
    if (valg.endring && n === valg.endring.etterDager * 1440) Object.assign(rom.sann, valg.endring.sann);
    const v = Simrom.vaer(ms);
    const time = new Date(ms).getUTCHours();
    const aapen = Boolean(valg.lufting) && time === 7 && new Date(ms).getUTCMinutes() < 20;
    const s = rom.steg(ms, time >= 5 && time < 22 ? 22 : 18, v, aapen);
    let temp = rom.maalt();
    if (valg.feilmaalinger && n % 997 === 0) temp += 4;          // en måling helt på jordet i ny og ne
    m.observer('rom', { ms, temp, ute: v.ute, u: valg.utenEffekt ? null : s.u, vind: v.vind, sol: s.sol, aapen, effektKw: s.effektW / 1000 });
    if (valg.hverDag && n % 1440 === 1439) valg.hverDag((n + 1) / 1440, m.modell('rom'));
  }
  return m;
}

// ----------------------------------------------------------------------
//  Sola
// ----------------------------------------------------------------------
test('sola står der den skal over Oslo, og varmer riktig fasade', () => {
  naer(solposisjon(Date.UTC(2026, 5, 21, 11, 17), LAT, LON).hoyde, 53.5, 0.5, 'sommersolverv');
  naer(solposisjon(Date.UTC(2026, 11, 21, 11, 15), LAT, LON).hoyde, 6.7, 0.5, 'vintersolverv');
  naer(solposisjon(Date.UTC(2026, 11, 21, 11, 15), LAT, LON).asimut, 180, 2, 'sør midt på dagen');
  const morgen = solmot(Date.UTC(2026, 2, 21, 6, 0), LAT, LON, 0);
  assert.ok(morgen.ost > 0.3 && morgen.ost > 4 * morgen.vest, JSON.stringify(morgen));
  const kveld = solmot(Date.UTC(2026, 5, 21, 17, 0), LAT, LON, 0);
  assert.ok(kveld.vest > kveld.ost && kveld.vest > kveld.sor);
  assert.deepEqual(solmot(Date.UTC(2026, 11, 21, 0, 0), LAT, LON, 0), { ost: 0, sor: 0, vest: 0 });
  // Overskyet demper, og uten sted regnes det ikke sol
  assert.ok(solmot(Date.UTC(2026, 5, 21, 11, 0), LAT, LON, 100).sor < 0.4 * solmot(Date.UTC(2026, 5, 21, 11, 0), LAT, LON, 0).sor);
  assert.deepEqual(solmot(Date.UTC(2026, 5, 21, 11, 0), undefined, undefined, 0), { ost: 0, sor: 0, vest: 0 });
});

// ----------------------------------------------------------------------
//  Rommodellen
// ----------------------------------------------------------------------
test('lærer oppvarmingsevne og varmetap på ett døgn, fra en termostat som melder i halve grader', () => {
  const etter = {};
  laer({ r: 3.0, k: 0.10 }, 3, { hverDag: (dag, modell) => { etter[dag] = modell; } });
  assert.equal(etter[1].laert, true);
  naer(etter[1].r, 3.0, 0.3, 'r dag 1');
  naer(etter[1].k, 0.10, 0.012, 'k dag 1');
  naer(etter[3].r, 3.0, 0.12, 'r dag 3');
  naer(etter[3].k, 0.10, 0.005, 'k dag 3');
  // Den forsiktige utgaven er alltid på den sikre siden, og marginen krymper når modellen blir sikker
  assert.ok(etter[1].rSikker < etter[1].r && etter[1].kSikker > etter[1].k);
  assert.ok(etter[1].r - etter[1].rSikker > etter[3].r - etter[3].rSikker);
  assert.ok(etter[3].sikkerhet > 0.9 && etter[3].sikkerhet >= etter[1].sikkerhet);
});

test('lærer vind, hvilken vei vinduene vender, gratisvarme og tapet når det luftes', () => {
  const sann = { r: 2.2, k: 0.07, kv: 0.006, sol: { ost: 0, sor: 1.5, vest: 0.3 }, g: 0.15, d: 0.5, effektKw: 1.2 };
  const m = laer(sann, 21, { lufting: true }).modell('rom');
  naer(m.r, 2.2, 0.15, 'r');
  naer(m.k, 0.07, 0.006, 'k');
  naer(m.kv, 0.006, 0.0015, 'vind');
  naer(m.sol.sor, 1.5, 0.3, 'sol fra sør');
  assert.ok(m.sol.sor > 2.5 * m.sol.vest && m.sol.sor > 5 * m.sol.ost, JSON.stringify(m.sol));
  naer(m.d, 0.5, 0.1, 'lufting');
  const i = innsikt(m, sann.effektKw);
  assert.equal(i.sol_fra, 'sør');
  naer(i.vind_pst_ved_5ms, 43, 12, 'vind i prosent');
  naer(i.tidskonstant_t, 14, 2, 'tidskonstant');
  naer(i.tap_w_per_grad, 1000 * 0.07 * (1.2 / 2.2), 6, 'tap W/°C');
  naer(m.pmaks, 1.2, 0.01, 'ovnens virkelige effekt');
});

test('trege anlegg: finner tregheten i gulvvarme, og lar panelovner være uten', () => {
  const gulv = laer({ r: 1.2, k: 0.04, treghet: 2.5 }, 6).modell('rom');
  assert.equal(gulv.treghet, 2.5);
  naer(gulv.r, 1.2, 0.12, 'r');
  naer(gulv.k, 0.04, 0.004, 'k');
  assert.equal(laer({ r: 3.0, k: 0.10 }, 3).modell('rom').treghet, 0);
});

test('lærer av feil: når rommet endrer seg, oppdages det og læres om på få døgn', () => {
  const forlop = {};
  // Etter ti døgn dobles varmetapet (et vindu byttes mot et dårligere, en dør blir stående åpen mot gangen)
  const m = laer({ r: 3.0, k: 0.08 }, 14, { endring: { etterDager: 10, sann: { k: 0.14 } }, hverDag: (dag, modell) => { forlop[dag] = modell; } });
  naer(forlop[10].k, 0.08, 0.006, 'før endringen');
  assert.equal(forlop[10].omlaeringer, 0);
  assert.ok(m.modell('rom').omlaeringer >= 1, 'endringen skal oppdages');
  naer(forlop[12].k, 0.14, 0.02, 'to døgn etter');
  naer(forlop[14].k, 0.14, 0.01, 'fire døgn etter');
});

test('tåler dårlige data: enkeltmålinger på jordet ødelegger ikke modellen', () => {
  const m = laer({ r: 3.0, k: 0.10 }, 6, { feilmaalinger: true }).modell('rom');
  naer(m.r, 3.0, 0.35, 'r');
  naer(m.k, 0.10, 0.015, 'k');
  assert.equal(m.laert, true);
});

test('uten kjent pådrag læres ingenting, og hull i målingene bryter vinduet', () => {
  const m = laer({ r: 3.0, k: 0.10 }, 2, { utenEffekt: true });
  assert.equal(m.modell('rom').n, 0);
  assert.equal(m.modell('rom').laert, false);
  const hull = new Rommodeller({});
  for (let n = 0; n < 40; n++) hull.observer('rom', { ms: n * 20 * MIN, temp: 20 - n * 0.2, ute: 0, u: 0 });      // måling hvert 20. minutt
  assert.equal(hull.modell('rom').n, 0);
});

test('det forrige læringssystemet er utgangspunkt for rom som alt var lært', () => {
  const m = new Rommodeller({}, { soner: { stue: { k: 0.05, rate_max: 2.0, n: 30 } } });
  naer(m.modell('stue').k, 0.05, 1e-9);
  naer(m.modell('stue').r, 2.0, 1e-9);
  assert.equal(m.modell('stue').laert, false);       // men det må bekreftes av nye målinger
  m.glem('stue');
  assert.equal(m.modell('stue').n, 0);
});

// ----------------------------------------------------------------------
//  Planleggeren med vind, sol og treghet
// ----------------------------------------------------------------------
test('vind og sol flytter varmebehovet, og tregheten forsinker oppvarmingen', () => {
  const modell = { r: 2.0, k: 0.05 };
  const stille = forvarmingMinutter(modell, 18, 22, -5);
  const vind = forvarmingMinutter(modell, 18, 22, -5, { k: 0.05 + 0.004 * 5, gevinst: 0 });
  // I storm klarer ikke ovnen spranget i det hele tatt
  assert.equal(forvarmingMinutter(modell, 18, 22, -5, { k: 0.05 + 0.004 * 10, gevinst: 0 }), null);
  const sol = forvarmingMinutter(modell, 18, 22, -5, { k: 0.05, gevinst: 0.8 });
  assert.ok(vind > stille * 1.3 && sol < stille * 0.75, `${stille} ${vind} ${sol}`);
  assert.equal(forvarmingMinutter({ ...modell, treghet: 2.5 }, 18, 22, -5), stille + 150);
  // Tregt anlegg: etter én time med fullt pådrag fra kaldt gulv har lite av varmen nådd rommet
  const rask = simuler(20, 0, 1, modell);
  const treg = simulerTreg(20, 0, 1, 0, { ...modell, treghet: 2.5 });
  assert.ok(treg.T < rask - 0.8 && treg.ueff > 0.3 && treg.ueff < 0.35, JSON.stringify(treg));
  // Med varmt gulv (ueff = 1) er de like
  naer(simulerTreg(20, 0, 1, 1, { ...modell, treghet: 2.5 }).T, rask, 1e-9);
});

test('planen for et tregt rom starter i tide, og lar seg ikke lure av små endringer per time', () => {
  // 0,6 °C/t netto ved fullt pådrag: avrunding til nærmeste kvarte grad ville sett ut som stillstand
  const modell = { r: 1.3, k: 0.028, treghet: 2.5 };
  const timer = Array.from({ length: 24 }, (_, h) => ({ ute: -5, pris: 1, min: h >= 9 ? 22 : 18, maks: 23 }));
  const plan = planlegg({ start: 19, modell, effektKw: 1, timer, ueff: 0 });
  assert.ok(plan.timer[9].til >= 21.6, `ved kravet: ${plan.timer[9].til}`);
  assert.ok(plan.timer.slice(0, 9).filter((t) => t.u >= 0.75).length >= 6, 'må varme det meste av natta');
  // Planen vil varme: settpunktet må ligge over der rommet er, ellers slår termostaten av
  const kald = planlegg({ start: 20.4, modell: { r: 0.6, k: 0.03 }, effektKw: 1, timer: [{ ute: -10, pris: 1, min: 22, maks: 23 }] });
  assert.equal(kald.timer[0].u, 1);
  assert.ok(kald.timer[0].til < 20.4, 'modellen tror rommet faller selv med ovnen på');
  assert.ok(settpunktNaa(kald) >= 22);
});

// ----------------------------------------------------------------------
//  Hele motoren mot et simulert hus
// ----------------------------------------------------------------------
/** Motoren (eller en vanlig termostat med samme program) styrer et simulert rom i noen døgn. */
function lukketSloyfe({ sann, type, dager, styrt }) {
  const start = kal.osloTilUtc(2026, 11, 2, 0);
  const sone = { key: 'rom', navn: 'Rom', type, prio: 3, nominell: sann.effektKw, profil: 'fellesrom', dag: 22, natt: 18 };
  const innst = { soner: [sone], skygge: false, dagStart: '06:00', nattStart: '23:00' };
  const m = new Motor({}, innst);
  const rom = new Simrom(sann, { start: 21 });
  const spot = new Spotpriser();
  const pris = (ms) => { const h = kal.osloDeler(ms).time; return (h >= 7 && h < 10) || (h >= 17 && h < 21) ? 2.2 : h < 5 ? 0.3 : 0.9; };
  for (let h = 0; h < (dager + 3) * 24; h++) spot.leggTil([{ start: start + h * TIME, slutt: start + (h + 1) * TIME, pris: pris(start + h * TIME) }]);
  const kalk = { takForIdag: () => null, marginalpris: (ms, s) => s.snitt(ms, ms + TIME) + 0.5 };
  let sp = 22; let ms = start; let kroner = 0; let forKaldt = 0; let verst = 0; let sistKwh = 0;
  for (let n = 0; n < dager * 1440; n++) {
    ms += MIN;
    const v = Simrom.vaer(ms);
    const krav = kravVed(sone, ms, innst).min;
    if (!styrt) sp = krav;
    const s = rom.steg(ms, sp, v);
    kroner += (rom.kwh - sistKwh) * kalk.marginalpris(kal.timestart(ms), spot);
    sistKwh = rom.kwh;
    if (styrt) {
      // Varselet er ikke fasit: det bommer litt, mer jo lenger fram
      const punkter = Array.from({ length: 50 }, (_, h) => { const x = Simrom.vaer(ms + (h - 1) * TIME); return { ms: ms + (h - 1) * TIME, temp: x.ute + (h > 1 ? 0.8 * Math.sin(h) : 0), vind: x.vind, sky: x.sky }; });
      const b = m.tick({
        ms, kalk, spot, vaer: new Vaer(punkter, ms), uteMaalt: v.ute, totalW: 600 + s.effektW, timeKwh: 0.5, sted: { lat: LAT, lon: LON },
        maalinger: { rom: { temp: rom.maalt(), settpunkt: sp, effektW: s.effektW, levende: true } },
      });
      if (b.soner[0].settpunkt !== null) sp = b.soner[0].settpunkt;
    }
    // Første døgn er innkjøring; komforten måles på dagtid etterpå
    if (n >= 1440 && krav >= 22) { if (rom.T < krav - 0.7) forKaldt += 1; verst = Math.max(verst, krav - rom.T); }
  }
  return { kroner, forKaldt, verst, modell: styrt ? m.modeller.modell('rom') : null, treff: m.t.treff.rom };
}

test('panelovn i lukket sløyfe: varmt til morgenen hver dag, og billigere enn en vanlig termostat', () => {
  const sann = { r: 4.0, k: 0.08, kv: 0.003, sol: { ost: 0, sor: 1.0, vest: 0.2 }, g: 0.1, effektKw: 1.5 };
  const ki = lukketSloyfe({ sann, type: 'panel', dager: 5, styrt: true });
  const vanlig = lukketSloyfe({ sann, type: 'panel', dager: 5, styrt: false });
  assert.equal(ki.forKaldt, 0, `minutter for kaldt: ${ki.forKaldt}, verst ${ki.verst.toFixed(2)}`);
  assert.ok(vanlig.forKaldt > 200, 'en termostat uten forvarming er kald hver morgen');
  assert.ok(ki.kroner < vanlig.kroner, `${ki.kroner.toFixed(1)} mot ${vanlig.kroner.toFixed(1)}`);
  assert.equal(ki.modell.laert, true);
  naer(ki.modell.r, 4.0, 0.4, 'r');
  naer(ki.modell.k, 0.08, 0.01, 'k');
  assert.equal(ki.treff.sene, 0);
});

test('gulvvarme i lukket sløyfe: tregheten læres, rommet er varmt i tide, og det koster klart mindre', () => {
  const sann = { r: 1.6, k: 0.03, treghet: 2.5, effektKw: 1.0 };
  const ki = lukketSloyfe({ sann, type: 'gulv', dager: 5, styrt: true });
  const vanlig = lukketSloyfe({ sann, type: 'gulv', dager: 5, styrt: false });
  assert.ok(ki.forKaldt <= 90 && ki.verst < 1.5, `minutter for kaldt: ${ki.forKaldt}, verst ${ki.verst.toFixed(2)}`);
  assert.ok(vanlig.forKaldt > 1000, `vanlig: ${vanlig.forKaldt}`);
  assert.ok(ki.kroner < 0.92 * vanlig.kroner, `${ki.kroner.toFixed(1)} mot ${vanlig.kroner.toFixed(1)}`);
  assert.equal(ki.modell.treghet, 2.5);
});
