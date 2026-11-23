'use strict';

/**
 * Kostnadskjernen: kroner per komponent for ett avregnet intervall.
 *
 * Oversatt fra Strømkalkulator (kostnad.py). To regler styrer resten:
 *  - Kroner regnes per intervall, med intervallets egen pris — ikke prisen som gjaldt da vi spurte.
 *  - Fastledd er et periodebeløp (kr/mnd) og ganges aldri med energi.
 *
 * Krysser et intervall månedstaket for strømstøtte eller Norgespris, deles kilowattimene i
 * én del under og én over taket før prisen legges på.
 */

const { stromstottePerKwh } = require('./avgifter');

const FELT = ['strom_kr', 'stromstotte_kr', 'energiledd_dag_kr', 'energiledd_natt_kr', 'avgifter_kr',
  'norgespris_kompensasjon_kr', 'norgespris_differanse_kr', 'kwh', 'kwh_uten_pris'];

const ingenKroner = () => Object.fromEntries(FELT.map((f) => [f, 0]));

/** Summer to kronesett felt for felt. */
function pluss(a, b) {
  const ut = {};
  for (const f of FELT) ut[f] = (a[f] || 0) + (b[f] || 0);
  return ut;
}

/** Nettleiens energidel med offentlige avgifter. */
const energileddKr = (k) => k.energiledd_dag_kr + k.energiledd_natt_kr + k.avgifter_kr;

/** Alt som følger kilowattimene. Fastledd er ikke med. */
const energiKr = (k) => k.strom_kr + energileddKr(k);

/** Hvor mange av intervallets kWh som ligger under et månedstak. Tak 0 = ordningen gjelder ikke. */
function underTak(kwh, kwhFor, tak) {
  if (tak <= 0) return 0;
  return Math.min(kwh, Math.max(0, tak - kwhFor));
}

/**
 * Kronene ett intervall står for.
 *
 * @param {{kwh: number, dag: boolean, prisEksMva: number|null}} intervall
 * @param {object} satser energileddInklMva, avgifterInklMva, mvaSats, norgesprisInklMva,
 *   stromstotteTerskel, stromstotteMaksKwh, norgesprisMaksKwh, harNorgespris
 * @param {number} kwhFor månedens kWh før dette intervallet
 */
function kronerForIntervall(intervall, satser, kwhFor = 0) {
  const { kwh } = intervall;
  if (!(kwh > 0)) return ingenKroner();
  // En overstyring under avgiftsnivået ville gitt negativt nettledd; avgiftene betales uansett.
  const nettEnergiledd = Math.max(0, satser.energileddInklMva - satser.avgifterInklMva) * kwh;
  const grunn = {
    ...ingenKroner(),
    energiledd_dag_kr: intervall.dag ? nettEnergiledd : 0,
    energiledd_natt_kr: intervall.dag ? 0 : nettEnergiledd,
    avgifter_kr: satser.avgifterInklMva * kwh,
    kwh,
  };
  const kwhMedNorgespris = underTak(kwh, kwhFor, satser.norgesprisMaksKwh);
  if (intervall.prisEksMva === null || intervall.prisEksMva === undefined) {
    // Uten spotpris: kjent Norgespris under taket bokføres, resten står synlig som «uten pris».
    return { ...grunn, strom_kr: satser.harNorgespris ? satser.norgesprisInklMva * kwhMedNorgespris : 0, kwh_uten_pris: kwh };
  }
  const spot = intervall.prisEksMva * (1 + satser.mvaSats);
  const stotteSats = stromstottePerKwh(spot, satser.stromstotteTerskel);
  const kwhMedStotte = underTak(kwh, kwhFor, satser.stromstotteMaksKwh);
  const spotEtterStotte = spot * kwh - stotteSats * kwhMedStotte;
  const norgesprisLinje = satser.norgesprisInklMva * kwhMedNorgespris + spot * (kwh - kwhMedNorgespris);
  const stromKr = satser.harNorgespris ? norgesprisLinje : spotEtterStotte;
  const alternativ = satser.harNorgespris ? spotEtterStotte : norgesprisLinje;
  return {
    ...grunn,
    strom_kr: stromKr,
    stromstotte_kr: satser.harNorgespris ? 0 : stotteSats * kwhMedStotte,
    norgespris_kompensasjon_kr: (satser.norgesprisInklMva - spot) * kwhMedNorgespris,
    norgespris_differanse_kr: alternativ - stromKr,
  };
}

/** Fastleddet for en andel av måneden. `null` = ingen kjenner trinnet → 0 kr, ikke et gjettet beløp. */
function fastleddBelop(kapasitetsledd, andel) {
  if (kapasitetsledd === null || kapasitetsledd === undefined) return 0;
  return kapasitetsledd * Math.min(1, Math.max(0, andel));
}

module.exports = { FELT, ingenKroner, pluss, energileddKr, energiKr, underTak, kronerForIntervall, fastleddBelop };
