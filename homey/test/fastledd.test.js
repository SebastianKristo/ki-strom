'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fl = require('../lib/fastledd');
const avg = require('../lib/avgifter');
const tariffer = require('../lib/tariffer.json');

const dso = (id) => tariffer.nettselskap[id];

test('alle nettselskap i katalogen kan slås opp', () => {
  assert.equal(Object.keys(tariffer.nettselskap).length, 76);
  for (const [id, d] of Object.entries(tariffer.nettselskap)) {
    const tariff = fl.lagTariff(d, { mvaSats: avg.mvaSats(avg.avgiftssoneFor(d)) });
    assert.ok(Object.values(fl.METODE).includes(tariff.metode), id);
    if (fl.TRINNBASERTE.has(tariff.metode) && d.supported && id !== 'custom') {
      assert.ok(tariff.trinn.length > 0, `${id} mangler trinn`);
      const stiger = tariff.trinn.every(([kw], i) => i === 0 || kw > tariff.trinn[i - 1][0]);
      assert.ok(stiger, `${id}: grensene stiger ikke`);
    }
  }
});

test('Elvia: snitt av tre døgnmakser, grensetreff hører til trinnet over', () => {
  const t = fl.lagTariff(dso('elvia'));
  assert.equal(fl.fastleddGrunnlag(t, [5.5, 4.8, 4.1, 3.0]), (5.5 + 4.8 + 4.1) / 3);
  assert.deepEqual(fl.fastleddForGrunnlag(t, 4.8), { pris: 250, nummer: 2, tekst: '2-5 kW' });
  assert.deepEqual(fl.fastleddForGrunnlag(t, 5.0), { pris: 420, nummer: 3, tekst: '5-10 kW' });
  assert.deepEqual(fl.fastleddForGrunnlag(t, 150), { pris: 6800, nummer: 10, tekst: '>100 kW' });
  assert.deepEqual(fl.nesteTrinn(t, 4.8, 250), { marginKw: 0.2, nestePris: 420 });
  assert.equal(fl.fastleddGrunnlag(t, [6]), 6);          // færre enn tre dager: snitt av dem som finnes
  assert.equal(fl.fastleddGrunnlag(t, []), 0);
});

test('Sør Aurdal: månedsmaks, og «til og med»-grenser', () => {
  const t = fl.lagTariff(dso('sor_aurdal_energi'));
  assert.equal(t.metode, fl.METODE.MND_MAX);
  assert.equal(fl.fastleddGrunnlag(t, [3, 7.5, 5]), 7.5);
  assert.equal(fl.fastleddForGrunnlag(t, 5).pris, 563);    // eksakt 5 → lavere trinn
  assert.equal(fl.fastleddForGrunnlag(t, 5.01).pris, 650);
});

test('Alut: fastledd etter sikring — ukjent til raden er valgt', () => {
  const uten = fl.lagTariff(dso('alut'));
  assert.equal(fl.fastleddBelopUkjent(uten, 3), true);
  assert.equal(fl.fastleddForGrunnlag(uten, 3).tekst, fl.SIKRING_MANGLER_TEKST);
  const med = fl.lagTariff(dso('alut'), { sikringstrinn: 'over_3x125a' });
  assert.deepEqual(fl.fastleddForGrunnlag(med, 3), { pris: 375, nummer: 2, tekst: 'Over 3 x 125 A' });
});

test('Fjellnett: fem sesongvektede ukestopper, grunnbeløp + sats per kW', () => {
  const t = fl.lagTariff(dso('fjellnett'), { mvaSats: 0.25 });
  // Uka som begynner mandag 29. juni vektes med juni (0,25), også for en topp 1. juli.
  assert.equal(fl.vektetKw(8, '2026-07-01', t.sesongfaktor), 2);
  const uker = [{ kw: 6, dato: '2026-01-07' }, { kw: 8, dato: '2026-06-10' }];
  assert.equal(fl.fastleddGrunnlag(t, [], uker), 4);       // (6·1,0 + 8·0,25) / 2
  assert.equal(fl.lineaertFastledd(t, 4), Math.floor(((2000 + 589 * 4) / 12) * 1.25 + 0.5));
  assert.equal(fl.fastleddForGrunnlag(t, 4).nummer, null);
});

test('utenfor kildens tabell er fastleddet ukjent, ikke gjettet', () => {
  const t = fl.lagTariff(dso('nettselskapet'));
  assert.equal(fl.fastleddUkjent(t, 80), true);
  assert.equal(fl.fastleddForGrunnlag(t, 80).tekst, fl.UKJENT_TEKST);
  assert.equal(fl.fastleddUkjent(t, 10), false);
});

test('fritidsbolig har egen tabell hos Midtnett', () => {
  assert.equal(fl.fastleddForGrunnlag(fl.lagTariff(dso('midtnett'), { boligtype: 'bolig' }), 4).pris, 275);
  assert.equal(fl.fastleddForGrunnlag(fl.lagTariff(dso('midtnett'), { boligtype: 'fritidsbolig_fast' }), 4).pris, 330);
});

test('egne trinn leses, også med desimalkomma', () => {
  assert.deepEqual(fl.parseKapasitetstrinn('2:155,5:250,10:415'), [[2, 155], [5, 250], [10, 415]]);
  assert.deepEqual(fl.parseKapasitetstrinn('2:155,5,5:250'), [[2, 155.5], [5, 250]]);
  assert.deepEqual(fl.parseKapasitetstrinn('  '), []);
  assert.throws(() => fl.parseKapasitetstrinn('5:250,2:155'), /stige/);
  assert.throws(() => fl.parseKapasitetstrinn('abc'), /kolon/);
});

test('sesongperioder kan krysse nyttår', () => {
  const p = dso('sor_aurdal_energi').energiledd_perioder;
  assert.equal(fl.finnAktivPeriode(p, '01-15').dag_eks_mva, 0.2952);
  assert.equal(fl.finnAktivPeriode(p, '07-01').dag_eks_mva, 0.2552);
  assert.equal(fl.finnAktivPeriode([], '07-01'), null);
});

test('avgifter og soner', () => {
  assert.equal(avg.avgiftssoneFor(dso('elvia')), 'standard');
  assert.equal(avg.avgiftssoneFor(dso('alut')), 'tiltakssone');
  assert.equal(avg.avgiftssoneFor(dso('bindal_kraftnett')), 'nord_norge');
  assert.ok(Math.abs(avg.energileddInklMva(0.2899, 'standard') - (0.2899 + 0.0813) * 1.25) < 1e-12);
  assert.ok(Math.abs(avg.energileddInklMva(0.121, 'tiltakssone') - 0.131) < 1e-12);
  assert.ok(Math.abs(avg.stromstotteTerskel('standard') - 0.9625) < 1e-12);
  assert.equal(avg.stromstotteTerskel('nord_norge'), 0.77);
  assert.equal(avg.stromstotteMaksKwh('fritidsbolig'), 0);
  assert.equal(avg.norgesprisMaksKwh('fritidsbolig'), 1000);
  assert.equal(avg.norgesprisInklMva('standard'), 0.5);
});
