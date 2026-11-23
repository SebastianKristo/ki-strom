'use strict';

/**
 * Kalender i Europe/Oslo: lokale datodeler, helligdager, dag-/natt-tariff og fakturamåned.
 *
 * Alt regnes fra UTC-millisekunder. Nettselskapet fakturerer kalendermåneden i norsk tid,
 * så grensene settes i Oslo-tid og regnes om til UTC — da er mars (743 t) og oktober (745 t)
 * ikke spesialtilfeller.
 */

const SONE = 'Europe/Oslo';
const DAG_START_TIME = 6;
const DAG_SLUTT_TIME = 22;
const HELLIGDAGER_FASTE = ['01-01', '05-01', '05-17', '12-25', '12-26'];

const format = new Intl.DateTimeFormat('en-GB', {
  timeZone: SONE, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const UKEDAG = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Lokale datodeler i Oslo for et UTC-tidspunkt. ukedag: mandag = 0. */
function osloDeler(ms) {
  const d = {};
  for (const p of format.formatToParts(new Date(ms))) d[p.type] = p.value;
  return {
    aar: Number(d.year), mnd: Number(d.month), dag: Number(d.day),
    time: Number(d.hour), minutt: Number(d.minute), sekund: Number(d.second),
    ukedag: UKEDAG[d.weekday],
  };
}

const to = (n) => String(n).padStart(2, '0');
const isoDato = (aar, mnd, dag) => `${aar}-${to(mnd)}-${to(dag)}`;

/** Lokal dato «ÅÅÅÅ-MM-DD» i Oslo. */
function osloDato(ms) {
  const d = osloDeler(ms);
  return isoDato(d.aar, d.mnd, d.dag);
}

/** Måneden «ÅÅÅÅ-MM» i Oslo. */
function osloMaaned(ms) {
  return osloDato(ms).slice(0, 7);
}

/** UTC-millisekunder for et lokalt klokkeslett i Oslo. */
function osloTilUtc(aar, mnd, dag, time = 0, minutt = 0) {
  const onsket = Date.UTC(aar, mnd - 1, dag, time, minutt);
  let ms = onsket;
  // To runder: første gjetter forskyvningen, andre retter den hvis gjetningen krysset et sommertidsskifte.
  for (let i = 0; i < 2; i++) {
    const d = osloDeler(ms);
    const lokalSomUtc = Date.UTC(d.aar, d.mnd - 1, d.dag, d.time, d.minutt, d.sekund);
    ms += onsket - lokalSomUtc;
  }
  return ms;
}

/** Påskedag (Meeus-algoritmen). Returnerer [måned, dag]. */
function paaske(aar) {
  const a = aar % 19;
  const b = Math.floor(aar / 100);
  const c = aar % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return [Math.floor(n / 31), (n % 31) + 1];
}

const bevegeligeCache = new Map();

/** Skjærtorsdag, langfredag, 1. og 2. påskedag, Kristi himmelfartsdag, 1. og 2. pinsedag. */
function bevegeligeHelligdager(aar) {
  if (!bevegeligeCache.has(aar)) {
    const [mnd, dag] = paaske(aar);
    const start = Date.UTC(aar, mnd - 1, dag);
    const dager = [-3, -2, 0, 1, 39, 49, 50].map((n) => new Date(start + n * 86400000).toISOString().slice(0, 10));
    bevegeligeCache.set(aar, new Set(dager));
  }
  return bevegeligeCache.get(aar);
}

/** Er datoen en helligdag? `ekstra` er nettselskapets egne lavtariffdager («MM-DD»). */
function erHelligdag(dato, ekstra = []) {
  const mmdd = dato.slice(5);
  return HELLIGDAGER_FASTE.includes(mmdd) || ekstra.includes(mmdd) || bevegeligeHelligdager(Number(dato.slice(0, 4))).has(dato);
}

/**
 * Gjelder dagtariff? Dag er hverdager 06–22 utenom helligdager. Nettselskap med
 * `helg_som_natt: false` lar bare klokkeslettet styre.
 */
function erDagtariff(ms, dso = {}) {
  const d = osloDeler(ms);
  if (d.time < DAG_START_TIME || d.time >= DAG_SLUTT_TIME) return false;
  if (dso.helg_som_natt === false) return true;
  if (d.ukedag >= 5) return false;
  return !erHelligdag(isoDato(d.aar, d.mnd, d.dag), dso.helligdager_ekstra || []);
}

/** Fakturamånedens start og slutt i UTC-ms for tidspunktet `ms`. */
function maanedsvindu(ms) {
  const d = osloDeler(ms);
  const start = osloTilUtc(d.aar, d.mnd, 1);
  const slutt = d.mnd === 12 ? osloTilUtc(d.aar + 1, 1, 1) : osloTilUtc(d.aar, d.mnd + 1, 1);
  return [start, slutt];
}

/** Hvor stor del av fakturamåneden som er gått, 0–1. */
function forloptAndelAvMaaned(ms) {
  const [start, slutt] = maanedsvindu(ms);
  return Math.min(1, Math.max(0, (ms - start) / (slutt - start)));
}

function dagerIMaaned(ms) {
  const d = osloDeler(ms);
  return new Date(Date.UTC(d.aar, d.mnd, 0)).getUTCDate();
}

/** Mandagen («ÅÅÅÅ-MM-DD») i uken datoen ligger i. */
function ukestart(dato) {
  const t = Date.parse(`${dato}T00:00:00Z`);
  const ukedag = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - ukedag * 86400000).toISOString().slice(0, 10);
}

/** Starten på timen `ms` ligger i (UTC-ms). Oslo-tid er alltid hele timer fra UTC. */
const timestart = (ms) => Math.floor(ms / 3600000) * 3600000;

module.exports = {
  SONE, DAG_START_TIME, DAG_SLUTT_TIME, HELLIGDAGER_FASTE,
  osloDeler, osloDato, osloMaaned, osloTilUtc, isoDato,
  paaske, bevegeligeHelligdager, erHelligdag, erDagtariff,
  maanedsvindu, forloptAndelAvMaaned, dagerIMaaned, ukestart, timestart,
};
