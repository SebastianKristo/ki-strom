'use strict';

/**
 * Sensorene på Strømkalkulator-enheten: én tabell som både app.json (kapabilitetene) og
 * enheten (verdiene) bygges fra, så de ikke kan komme i utakt.
 *
 * hent(s) får øyeblikksbildet fra Stromkalkulator.snapshot().
 */

const topp = (n) => (s) => (s.nettleie.topper[n] ? s.nettleie.topper[n].kw : null);

const SENSORER = [
  // --- Nettleie ---
  { id: 'ki_tariff', type: 'string', no: 'Tariff', en: 'Tariff', ikon: 'tariff', hent: (s) => s.nettleie.tariff },
  { id: 'ki_energiledd', type: 'number', no: 'Energiledd', en: 'Energy charge', enhet: 'kr/kWh', desimaler: 4, hent: (s) => s.nettleie.energiledd },
  { id: 'ki_kapasitetsledd', type: 'number', no: 'Kapasitetsledd', en: 'Capacity charge', enhet: 'kr/mnd', desimaler: 0, hent: (s) => s.nettleie.kapasitetsledd },
  { id: 'ki_kapasitetstrinn', type: 'string', no: 'Kapasitetstrinn', en: 'Capacity step', hent: (s) => s.nettleie.kapasitetstrinn },
  { id: 'ki_snitt_topp', type: 'number', no: 'Snitt toppforbruk', en: 'Average peak', enhet: 'kW', desimaler: 2, hent: (s) => s.nettleie.snitt_topp_kw },
  { id: 'ki_topp_1', type: 'number', no: 'Toppforbruk 1', en: 'Peak 1', enhet: 'kW', desimaler: 2, hent: topp(0) },
  { id: 'ki_topp_2', type: 'number', no: 'Toppforbruk 2', en: 'Peak 2', enhet: 'kW', desimaler: 2, hent: topp(1) },
  { id: 'ki_topp_3', type: 'number', no: 'Toppforbruk 3', en: 'Peak 3', enhet: 'kW', desimaler: 2, hent: topp(2) },
  { id: 'ki_margin_trinn', type: 'number', no: 'Margin til neste trinn', en: 'Margin to next step', enhet: 'kW', desimaler: 2, hent: (s) => s.nettleie.margin_kw },
  { id: 'ki_tak_idag', type: 'number', no: 'Høyeste time i dag uten nytt trinn', en: 'Max hour today within step', enhet: 'kWh', desimaler: 2, hent: (s) => s.nettleie.tak_idag_kwh },
  { id: 'ki_kapasitetsvarsel', type: 'boolean', no: 'Kapasitetsvarsel', en: 'Capacity warning', hent: (s) => s.nettleie.kapasitetsvarsel },
  // --- Pris nå ---
  { id: 'ki_spotpris', type: 'number', no: 'Spotpris inkl. mva', en: 'Spot price incl. VAT', enhet: 'kr/kWh', desimaler: 4, hent: (s) => s.pris.spot },
  { id: 'ki_stromstotte', type: 'number', no: 'Strømstøtte', en: 'Electricity subsidy', enhet: 'kr/kWh', desimaler: 4, hent: (s) => s.pris.stromstotte },
  { id: 'ki_spot_etter_stotte', type: 'number', no: 'Spotpris etter støtte', en: 'Spot price after subsidy', enhet: 'kr/kWh', desimaler: 4, hent: (s) => s.pris.spot_etter_stotte },
  { id: 'ki_totalpris', type: 'number', no: 'Total strømpris', en: 'Total electricity price', enhet: 'kr/kWh', desimaler: 4, hent: (s) => s.pris.total },
  { id: 'ki_prisforskjell_norgespris', type: 'number', no: 'Prisforskjell Norgespris', en: 'Norgespris difference', enhet: 'kr/kWh', desimaler: 4, hent: (s) => s.pris.prisforskjell_norgespris },
  { id: 'ki_norgespris_aktiv', type: 'boolean', no: 'Norgespris aktiv nå', en: 'Norgespris active', hent: (s) => s.pris.norgespris_aktiv },
  // --- Denne måneden ---
  { id: 'ki_mnd_forbruk', type: 'number', no: 'Forbruk denne måneden', en: 'Consumption this month', enhet: 'kWh', desimaler: 1, hent: (s) => s.maaned.kwh },
  { id: 'ki_mnd_forbruk_dag', type: 'number', no: 'Forbruk dagtariff', en: 'Consumption day tariff', enhet: 'kWh', desimaler: 1, hent: (s) => s.maaned.kwh_dag },
  { id: 'ki_mnd_forbruk_natt', type: 'number', no: 'Forbruk natt/helg', en: 'Consumption night/weekend', enhet: 'kWh', desimaler: 1, hent: (s) => s.maaned.kwh_natt },
  { id: 'ki_mnd_nettleie', type: 'number', no: 'Nettleie denne måneden', en: 'Grid rent this month', enhet: 'kr', desimaler: 2, hent: (s) => s.maaned.nettleie_kr },
  { id: 'ki_mnd_stromstotte', type: 'number', no: 'Strømstøtte denne måneden', en: 'Subsidy this month', enhet: 'kr', desimaler: 2, hent: (s) => s.maaned.stromstotte_kr },
  { id: 'ki_mnd_kostnad', type: 'number', no: 'Strømkostnad denne måneden', en: 'Electricity cost this month', enhet: 'kr', desimaler: 2, hent: (s) => s.maaned.kostnad_kr },
  { id: 'ki_mnd_estimert', type: 'number', no: 'Estimert månedskostnad', en: 'Estimated monthly cost', enhet: 'kr', desimaler: 0, hent: (s) => s.maaned.estimert_kr },
  { id: 'ki_mnd_norgespris_besparelse', type: 'number', no: 'Norgespris besparelse', en: 'Norgespris savings', enhet: 'kr', desimaler: 2, hent: (s) => s.maaned.norgespris_besparelse_kr },
  // --- I dag og denne timen ---
  { id: 'ki_dag_forbruk', type: 'number', no: 'Forbruk i dag', en: 'Consumption today', enhet: 'kWh', desimaler: 2, hent: (s) => s.idag.kwh },
  { id: 'ki_dag_kostnad', type: 'number', no: 'Dagens kostnad', en: 'Cost today', enhet: 'kr', desimaler: 2, hent: (s) => s.idag.kostnad_kr },
  { id: 'ki_time_forbruk', type: 'number', no: 'Forbruk denne timen', en: 'Consumption this hour', enhet: 'kWh', desimaler: 3, hent: (s) => s.time.kwh },
  // --- Forrige måned (til å sjekke fakturaen mot) ---
  { id: 'ki_forrige_forbruk', type: 'number', no: 'Forrige måned forbruk', en: 'Last month consumption', enhet: 'kWh', desimaler: 1, hent: (s) => (s.forrige_maaned ? s.forrige_maaned.kwh : null) },
  { id: 'ki_forrige_nettleie', type: 'number', no: 'Forrige måned nettleie', en: 'Last month grid rent', enhet: 'kr', desimaler: 2, hent: (s) => (s.forrige_maaned ? s.forrige_maaned.nettleie_kr : null) },
  { id: 'ki_forrige_kostnad', type: 'number', no: 'Forrige måned strømkostnad', en: 'Last month cost', enhet: 'kr', desimaler: 2, hent: (s) => (s.forrige_maaned ? s.forrige_maaned.kostnad_kr : null) },
  { id: 'ki_forrige_topp', type: 'number', no: 'Forrige måned toppforbruk', en: 'Last month peak', enhet: 'kW', desimaler: 2, hent: (s) => (s.forrige_maaned ? s.forrige_maaned.snitt_topp_kw : null) },
  // --- Tilstand ---
  { id: 'ki_maleproblem', type: 'boolean', no: 'Måledata-problem', en: 'Measurement problem', hent: (s) => s.problemer.length > 0 },
];

module.exports = { SENSORER };
