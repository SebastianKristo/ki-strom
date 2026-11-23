'use strict';

/**
 * Spotpriser fra hvakosterstrommen.no (åpent API, ingen nøkkel).
 *
 *   GET https://www.hvakosterstrommen.no/api/v1/prices/ÅÅÅÅ/MM-DD_NO1.json
 *   → [{ NOK_per_kWh, EUR_per_kWh, EXR, time_start, time_end }, ...]
 *
 * Prisene er eks. mva. Lista kan ha timer (24) eller kvarter (96); alt lagres som
 * intervaller [start, slutt) i UTC-ms, så begge deler fungerer. Morgendagens priser
 * kommer rundt kl. 13.
 */

const { osloDato, timestart } = require('./kalender');

const PRISOMRAADER = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
const TIME_MS = 3600000;

/** Adressen for én dato («ÅÅÅÅ-MM-DD») og ett prisområde. */
function adresse(dato, omraade) {
  const [aar, mnd, dag] = dato.split('-');
  return `https://www.hvakosterstrommen.no/api/v1/prices/${aar}/${mnd}-${dag}_${omraade}.json`;
}

/** Gjør API-svaret om til [{start, slutt, pris}] (UTC-ms, kr/kWh eks. mva). Ugyldige rader hoppes over. */
function tolk(svar) {
  if (!Array.isArray(svar)) return [];
  const ut = [];
  for (const rad of svar) {
    const start = Date.parse(rad && rad.time_start);
    const slutt = Date.parse(rad && rad.time_end);
    const pris = Number(rad && rad.NOK_per_kWh);
    if (Number.isFinite(start) && Number.isFinite(slutt) && slutt > start && Number.isFinite(pris)) {
      ut.push({ start, slutt, pris });
    }
  }
  return ut.sort((a, b) => a.start - b.start);
}

class Spotpriser {
  /** @param {Array} intervaller tidligere lagrede intervaller */
  constructor(intervaller = []) {
    this.intervaller = intervaller;
  }

  /** Legg til nye intervaller; samme starttid erstatter det gamle. */
  leggTil(nye) {
    const kart = new Map(this.intervaller.map((i) => [i.start, i]));
    for (const i of nye) kart.set(i.start, i);
    this.intervaller = [...kart.values()].sort((a, b) => a.start - b.start);
  }

  /** Fjern alt som sluttet før `ms`. */
  rydd(ms) {
    this.intervaller = this.intervaller.filter((i) => i.slutt > ms);
  }

  /** Prisen (eks. mva) som gjelder på tidspunktet, eller null. */
  prisVed(ms) {
    const treff = this.intervaller.find((i) => i.start <= ms && ms < i.slutt);
    return treff ? treff.pris : null;
  }

  /** Tidsvektet snittpris for [fra, til), eller null hvis noe av tiden mangler pris. */
  snitt(fra, til) {
    let sum = 0;
    let dekket = 0;
    for (const i of this.intervaller) {
      const a = Math.max(fra, i.start);
      const b = Math.min(til, i.slutt);
      if (b > a) { sum += i.pris * (b - a); dekket += b - a; }
    }
    return dekket >= til - fra - 1 ? sum / dekket : null;
  }

  /** Snittpris per hele time fra og med timen `ms` ligger i: [{start, pris}]. */
  timepriser(ms, antall = 48) {
    const ut = [];
    for (let t = timestart(ms), n = 0; n < antall; t += TIME_MS, n++) {
      const pris = this.snitt(t, t + TIME_MS);
      if (pris === null) break;
      ut.push({ start: t, pris });
    }
    return ut;
  }

  /** Har vi priser for hele den lokale datoen? */
  harDato(dato) {
    return this.intervaller.some((i) => osloDato(i.start) === dato);
  }
}

/**
 * Hent priser for datoene som mangler (i dag, og i morgen etter kl. 13).
 * `hent` er en fetch-lignende funksjon, så modulen kan testes uten nett.
 * Returnerer antall nye intervaller. En dato som ikke er publisert ennå (404) er ikke en feil.
 */
async function hentManglende(spot, omraade, naaMs, hent) {
  const idag = osloDato(naaMs);
  const imorgen = osloDato(naaMs + 24 * TIME_MS);
  const datoer = [idag];
  const lokalTime = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', hourCycle: 'h23' }).format(new Date(naaMs)));
  if (lokalTime >= 13) datoer.push(imorgen);
  let nye = 0;
  for (const dato of datoer) {
    if (spot.harDato(dato)) continue;
    const svar = await hent(adresse(dato, omraade));
    if (!svar || !svar.ok) continue;
    const intervaller = tolk(await svar.json());
    spot.leggTil(intervaller);
    nye += intervaller.length;
  }
  spot.rydd(naaMs - 48 * TIME_MS);
  return nye;
}

module.exports = { PRISOMRAADER, adresse, tolk, Spotpriser, hentManglende };
