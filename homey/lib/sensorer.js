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

const STATUSTEKST = { gronn: 'God margin', gul: 'Følger med', oransje: 'Nær grensen', rod: 'På grensen', kritisk: 'Over grensen', av: 'Av' };

/** Sensorene på Energimotor-enheten. hent(b) får bildet fra Motor.tick(). */
const MOTOR_SENSORER = [
  { id: 'ki_motor_status', type: 'string', no: 'Status', en: 'Status', hent: (b) => STATUSTEKST[b.status] || b.status },
  { id: 'ki_motor_forklaring', type: 'string', no: 'Forklaring', en: 'Explanation', hent: (b) => b.forklaring },
  { id: 'ki_time_grense', type: 'number', no: 'Timens grense', en: 'Hour limit', enhet: 'kWh', desimaler: 2, hent: (b) => b.budsjett.grense },
  { id: 'ki_time_forventet', type: 'number', no: 'Timen ligger an til', en: 'Hour forecast', enhet: 'kWh', desimaler: 2, hent: (b) => b.forventet_time_kwh },
  { id: 'ki_time_brukt', type: 'number', no: 'Brukt denne timen', en: 'Used this hour', enhet: 'kWh', desimaler: 2, hent: (b) => b.budsjett.forbrukt },
  { id: 'ki_ledig_effekt', type: 'number', no: 'Ledig effekt', en: 'Available power', enhet: 'kW', desimaler: 2, hent: (b) => b.ledig_kw },
  { id: 'ki_uregulert_effekt', type: 'number', no: 'Annet forbruk', en: 'Other consumption', enhet: 'kW', desimaler: 2, hent: (b) => b.uregulert_kw },
  { id: 'ki_styrt_effekt', type: 'number', no: 'Styrt varme', en: 'Controlled heating', enhet: 'W', desimaler: 0, hent: (b) => b.styrt_w },
  { id: 'ki_senkede_rom', type: 'number', no: 'Senkede rom', en: 'Lowered rooms', enhet: '', desimaler: 0, hent: (b) => b.soner.filter((p) => p.handling === 'senket').length },
  { id: 'ki_plan_spart', type: 'number', no: 'Varmeplanen sparer (36 t)', en: 'Heat plan saves (36 h)', enhet: 'kr', desimaler: 2, hent: (b) => b.plan_spart_kr },
  // --- Huset ---
  { id: 'ki_modus', type: 'string', no: 'Modus', en: 'Mode', hent: (b) => (b.hus ? b.hus.modus : null) },
  { id: 'ki_hjemkomst', type: 'string', no: 'Huset er varmt til', en: 'House warm by', hent: (b) => (b.hus ? b.hus.hjemkomst_kl : null) },
  { id: 'ki_bereder_status', type: 'string', no: 'Bereder', en: 'Water heater', hent: (b) => (b.hus && b.hus.bereder ? b.hus.bereder.status : null) },
  { id: 'ki_bereder_dager', type: 'number', no: 'Dager siden berederen var varm', en: 'Days since heater was hot', enhet: 'd', desimaler: 1, hent: (b) => (b.hus && b.hus.bereder ? b.hus.bereder.dager_siden_varm : null) },
];

module.exports.MOTOR_SENSORER = MOTOR_SENSORER;
module.exports.STATUSTEKST = STATUSTEKST;
