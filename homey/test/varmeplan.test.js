'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simuler, forvarmingMinutter, holdepaadrag, Laering } = require('../lib/termisk');
const { planlegg, settpunktNaa } = require('../lib/varmeplan');
const { Vaer, tolk, hent, adresse } = require('../lib/vaer');

const MODELL = { k: 0.05, r: 2.0 };           // tidskonstant 20 t, ovnen gir 2 °C/t
const naer = (a, b, slakk) => assert.ok(Math.abs(a - b) <= slakk, `${a} ≠ ${b}`);
const timer = (n, f) => Array.from({ length: n }, (_, h) => f(h));

// ----------------------------------------------------------------------
//  Modell og læring
// ----------------------------------------------------------------------
test('simulering og forvarmingstid følger samme modell', () => {
  naer(simuler(20, 0, 0, MODELL, 1), 20 * Math.exp(-0.05), 1e-9);            // kjøles mot ute
  naer(simuler(20, 0, 0.5, MODELL, 1000), 20, 1e-6);                         // likevekt: ute + r·u/k
  naer(holdepaadrag(20, 0, MODELL), 0.5, 1e-9);
  const min = forvarmingMinutter(MODELL, 14.5, 22, -5);
  naer(simuler(14.5, -5, 1, MODELL, min / 60), 22, 1e-6);
  assert.equal(forvarmingMinutter(MODELL, 20, 22, -30), null);              // ovnen når ikke målet
  assert.equal(forvarmingMinutter(MODELL, 22, 21, 0), 0);
});

test('læringen finner k og oppvarmingsevne fra termostat i halve grader', () => {
  const l = new Laering({});
  const sann = { k: 0.04, r: 1.6 };
  const halv = (T) => Math.round(T * 2) / 2;
  let T = 22;
  let ms = 0;
  for (let dogn = 0; dogn < 14; dogn++) {
    for (let n = 0; n < 12 * 8; n++) {            // åtte timer av: rommet faller
      l.observer('stue', { ms, temp: halv(T), ute: 0, tilstand: 'av' });
      T = simuler(T, 0, 0, sann, 1 / 12); ms += 300000;
    }
    for (let n = 0; n < 12 * 4; n++) {            // fire timer på: rommet stiger
      l.observer('stue', { ms, temp: halv(T), ute: 0, tilstand: 'varmer' });
      T = simuler(T, 0, 1, sann, 1 / 12); ms += 300000;
    }
  }
  const m = l.modell('stue');
  assert.equal(m.laert, true);
  naer(m.k, 0.04, 0.012);
  naer(m.r, 1.6, 0.35);
});

test('ukjent tilstand og for korte vinduer lærer ingenting', () => {
  const l = new Laering({});
  assert.equal(l.observer('a', { ms: 0, temp: 20, ute: 0, tilstand: 'av' }), false);
  assert.equal(l.observer('a', { ms: 600000, temp: 19.5, ute: 0, tilstand: 'av' }), false);     // 10 min
  assert.equal(l.observer('a', { ms: 1200000, temp: 19.5, ute: 0, tilstand: null }), false);
  assert.equal(l.observer('a', { ms: 3600000, temp: 19, ute: 0, tilstand: 'av' }), false);      // nytt vindu
  assert.equal(l.modell('a').laert, false);
});

// ----------------------------------------------------------------------
//  Varmeplanen
// ----------------------------------------------------------------------
test('flat pris og fast krav: planen holder kravet, ikke mer', () => {
  const plan = planlegg({ start: 21, modell: MODELL, effektKw: 2, timer: timer(24, () => ({ ute: 0, pris: 1, min: 21, maks: 22 })) });
  for (const t of plan.timer) assert.ok(t.til >= 20.6 && t.til <= 22.01, `${t.til}`);
  naer(plan.timer.reduce((s, t) => s + t.kwh, 0) / 24, holdepaadrag(21, 0, MODELL) * 2, 0.15);
  assert.equal(settpunktNaa(plan) >= 21, true);
});

test('dyre timer: planen varmer på forhånd og lar rommet gli', () => {
  // kl. 6–9 koster fem ganger så mye
  const t = timer(24, (h) => ({ ute: 0, pris: h >= 6 && h < 9 ? 5 : 1, min: 21, maks: 23 }));
  const plan = planlegg({ start: 21, modell: MODELL, effektKw: 2, timer: t });
  const dyrt = plan.timer.slice(6, 9).reduce((s, x) => s + x.kwh, 0);
  const foer = plan.timer.slice(3, 6).reduce((s, x) => s + x.kwh, 0);
  assert.ok(dyrt < foer * 0.5, `dyre timer ${dyrt} kWh mot ${foer} kWh før`);
  assert.ok(plan.timer[5].til > 21.8, 'rommet skal være forvarmet før de dyre timene');
  assert.ok(plan.timer.every((x) => x.til >= 20.6), 'komforten holdes');
  assert.ok(plan.spart > 0.5, `spart ${plan.spart}`);
});

test('nattsenking: rommet får falle om natten og er varmt til morgenen', () => {
  // natt (time 0–7) er kravet 18, deretter 22
  const t = timer(16, (h) => ({ ute: -5, pris: 1, min: h < 8 ? 18 : 22, maks: (h < 8 ? 18 : 22) + 4 }));
  const plan = planlegg({ start: 22, modell: MODELL, effektKw: 2, timer: t });
  assert.equal(plan.timer[0].u, 0, 'ingen varme i det kravet faller');
  assert.ok(Math.min(...plan.timer.slice(0, 8).map((x) => x.til)) < 20.5, 'rommet skal falle om natten');
  assert.ok(plan.timer[8].til >= 21.6, `morgenen: ${plan.timer[8].til}`);
  assert.ok(plan.timer.slice(4, 8).some((x) => x.u > 0), 'oppvarmingen starter før kravet stiger');
  assert.ok(plan.kostnad < plan.referanse + 1e-6);
});

test('kaldere vær gir tidligere start', () => {
  const lag = (ute) => planlegg({ start: 16, modell: MODELL, effektKw: 2, timer: timer(12, (h) => ({ ute, pris: 1, min: h < 8 ? 16 : 22, maks: 23 })) });
  const forste = (plan) => plan.timer.findIndex((x) => x.u >= 0.75);
  assert.ok(forste(lag(-15)) < forste(lag(8)), `${forste(lag(-15))} mot ${forste(lag(8))}`);
});

test('ovnen rekker ikke: planen gjør så godt den kan uten å gi opp', () => {
  const plan = planlegg({ start: 10, modell: MODELL, effektKw: 2, timer: timer(3, () => ({ ute: -10, pris: 1, min: 22, maks: 23 })) });
  assert.ok(plan.timer.every((x) => x.u === 1));
  assert.equal(settpunktNaa(plan), 22);
});

// ----------------------------------------------------------------------
//  Været
// ----------------------------------------------------------------------
const varsel = (start, temper) => ({ properties: { timeseries: temper.map((temp, n) => ({
  time: new Date(start + n * 3600000).toISOString(),
  data: { instant: { details: { air_temperature: temp, cloud_area_fraction: 50, wind_speed: 3 } } },
})) } });

test('varselet tolkes og interpoleres, og rettes mot målt temperatur nå', () => {
  const start = Date.UTC(2026, 10, 23, 12);
  const v = new Vaer();
  v.sett(tolk(varsel(start, [0, -2, -4, -6, -8, -10, -12, -14])), start);
  naer(v.tempVed(start + 1800000), -1, 1e-9);
  assert.equal(v.tempVed(start + 20 * 3600000), null);
  const t = v.timer(start, 8, 3);                 // måleren viser 3 °C der varselet sier 0
  naer(t[0], -1 + 3, 1e-9);                       // hele avviket nå
  naer(t[3], -7 + 1.5, 1e-9);                     // halve etter tre timer
  assert.equal(t[7], 3);                          // utenfor varselet: målt temperatur holdes
  assert.deepEqual(new Vaer().timer(start, 2, null, 5), [5, 5]);
  assert.deepEqual(tolk({ feil: 1 }), []);
});

test('henter høyst én gang i timen, med User-Agent', async () => {
  const start = Date.UTC(2026, 10, 23, 12);
  const kall = [];
  const hentFn = async (url, valg) => { kall.push([url, valg.headers['User-Agent']]); return { ok: true, json: async () => varsel(start, [1, 2, 3]) }; };
  const v = new Vaer();
  assert.equal(await hent(v, 59.9139, 10.7522, start, hentFn, 'ki-energi/1'), 3);
  assert.equal(await hent(v, 59.9139, 10.7522, start + 600000, hentFn, 'ki-energi/1'), 0);
  assert.equal(await hent(v, 59.9139, 10.7522, start + 3700000, hentFn, 'ki-energi/1'), 3);
  assert.deepEqual(kall[0], [adresse(59.9139, 10.7522), 'ki-energi/1']);
  assert.equal(await hent(new Vaer(), NaN, 10, start, hentFn, 'x'), 0);
});
