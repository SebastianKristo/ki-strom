'use strict';

/**
 * Energi per hele klokketime fra tidsstemplede registerprøver.
 *
 * Samme måler som i Home Assistant-versjonen (nettleie.py, Timemaler). Tid er sekunder siden
 * epoken, verdier er kWh fra målerens register.
 *
 * Tilstand (vanlig objekt, lagres av appen):
 *   prover:      [[ts, kwh], ...]  stigende ts
 *   timer:       { "<utc-iso timestart>": {kwh, kvalitet, start, slutt, start_kv, slutt_kv} }
 *   reset:       ts for siste registrerte nullstilling
 *   sist_lukket: ts for siste timegrense som er behandlet
 * kvalitet: "malt" | "estimert" | "mangler"
 */

const TOL_MALT_SEK = 15;            // prøve innen ±15 s av timegrensen regnes som målt
const MAKS_GAP_SEK = 3 * 3600;      // lengre hull enn dette interpoleres ikke
const VENT_PA_PROVE_SEK = 5 * 60;   // så lenge venter vi på en forsinket prøve etter timeskiftet
const RESET_TOLERANSE = 0.5;        // registeret falt mer enn dette → nullstilt/byttet måler
const TYNN_SEK = 60;                // midt i timen holder én prøve i minuttet

const timestart = (ts) => Math.floor(ts / 3600) * 3600;
const nokkel = (startTs) => new Date(startTs * 1000).toISOString().slice(0, 16);

function naerGrense(ts) {
  const rest = ts - timestart(ts);
  return rest <= TOL_MALT_SEK || rest >= 3600 - TOL_MALT_SEK;
}

/** Første indeks med p[i][0] >= ts. */
function finnIndeks(p, ts) {
  let lav = 0;
  let hoy = p.length;
  while (lav < hoy) {
    const midt = (lav + hoy) >> 1;
    if (p[midt][0] < ts) lav = midt + 1; else hoy = midt;
  }
  return lav;
}

class Timemaler {
  constructor(tilstand = {}) {
    this.m = tilstand;
    this.m.prover = this.m.prover || [];
    this.m.timer = this.m.timer || {};
    if (this.m.reset === undefined) this.m.reset = null;
    if (this.m.sist_lukket === undefined) this.m.sist_lukket = null;
  }

  /** Ta imot en registerprøve. Returnerer true hvis registeret ble nullstilt. */
  prove(ts, verdi) {
    const p = this.m.prover;
    if (p.length && ts <= p[p.length - 1][0]) {
      // gammel/duplisert prøve — sett den inn sortert hvis den er ny
      const i = finnIndeks(p, ts);
      if (i < p.length && Math.abs(p[i][0] - ts) < 0.5) return false;
      p.splice(i, 0, [ts, verdi]);
      return false;
    }
    if (p.length && verdi < p[p.length - 1][1] - RESET_TOLERANSE) {
      this.m.reset = ts;
      p.push([ts, verdi]);
      return true;
    }
    // Tynning: HAN-lesere melder hvert 2.–3. sekund. Bare prøvene nær timegrensen gir «målt»;
    // midt i timen flyttes den siste fram i stedet for å legge til en ny.
    const n = p.length;
    if (n >= 2 && p[n - 1][0] - p[n - 2][0] < TYNN_SEK && !naerGrense(p[n - 1][0]) && !naerGrense(ts)) {
      p[n - 1] = [ts, verdi];
      return false;
    }
    p.push([ts, verdi]);
    return false;
  }

  /** Registerverdi ved et tidspunkt: [verdi, 'malt'|'estimert'|'mangler']. */
  verdiVed(ts) {
    const p = this.m.prover;
    if (!p.length) return [null, 'mangler'];
    const i = finnIndeks(p, ts);
    const naer = [i - 1, i].filter((j) => j >= 0 && j < p.length && Math.abs(p[j][0] - ts) <= TOL_MALT_SEK).map((j) => p[j]);
    if (naer.length) {
      naer.sort((a, b) => Math.abs(a[0] - ts) - Math.abs(b[0] - ts));
      return [naer[0][1], 'malt'];
    }
    if (i === 0 || i >= p.length) return [null, 'mangler'];
    const a = p[i - 1];
    const b = p[i];
    if (b[0] - a[0] > MAKS_GAP_SEK) return [null, 'mangler'];
    const { reset } = this.m;
    if (reset !== null && a[0] < reset && reset <= b[0]) return [null, 'mangler'];
    const f = (ts - a[0]) / Math.max(b[0] - a[0], 1e-9);
    return [a[1] + f * (b[1] - a[1]), 'estimert'];
  }

  lukkTime(startTs) {
    const sluttTs = startTs + 3600;
    const [v0, k0] = this.verdiVed(startTs);
    const [v1, k1] = this.verdiVed(sluttTs);
    const { reset } = this.m;
    const rad = { start: startTs, slutt: sluttTs, start_kv: k0, slutt_kv: k1 };
    if (v0 === null || v1 === null || (reset !== null && startTs < reset && reset <= sluttTs)) {
      rad.kwh = null;
      rad.kvalitet = 'mangler';
    } else {
      rad.kwh = Math.round(Math.max(0, v1 - v0) * 10000) / 10000;
      rad.kvalitet = k0 === 'malt' && k1 === 'malt' ? 'malt' : 'estimert';
    }
    this.m.timer[nokkel(startTs)] = rad;
    return rad;
  }

  /** Lukk alle timer som er ferdige. Returnerer radene som ble lukket i dette kallet. */
  oppdater(naaTs) {
    const lukket = [];
    const sisteGrense = timestart(naaTs);
    const p = this.m.prover;
    let sist = this.m.sist_lukket;
    if (sist === null) {
      if (p.length) {
        sist = timestart(p[0][0]);
        if (p[0][0] > sist + TOL_MALT_SEK) sist += 3600;
        sist = Math.min(sist, sisteGrense);
      } else {
        sist = sisteGrense;
      }
    }
    let start = sist;
    while (start + 3600 <= sisteGrense) {
      const slutt = start + 3600;
      const harProveEtter = p.length > 0 && p[p.length - 1][0] >= slutt - TOL_MALT_SEK;
      if (!harProveEtter && naaTs - slutt < VENT_PA_PROVE_SEK) break;
      lukket.push(this.lukkTime(start));
      start = slutt;
    }
    this.m.sist_lukket = start;
    const grense = start - MAKS_GAP_SEK;
    while (p.length > 2 && p[1][0] < grense) p.shift();
    const gammel = naaTs - 40 * 86400;
    for (const [k, r] of Object.entries(this.m.timer)) {
      if ((r.start || 0) < gammel) delete this.m.timer[k];
    }
    return lukket;
  }

  /** kWh hittil i inneværende time og kvaliteten på nullpunktet: [kwh, kvalitet]. */
  forelopig(naaTs, naaVerdi) {
    if (naaVerdi === null || naaVerdi === undefined) return [null, 'mangler'];
    const start = timestart(naaTs);
    const [v0, k0] = this.verdiVed(start);
    if (v0 !== null) return [Math.max(0, naaVerdi - v0), k0 === 'malt' ? 'forelopig' : 'forelopig_estimert'];
    const forste = this.m.prover.find((q) => start <= q[0] && q[0] <= naaTs);
    if (!forste) return [null, 'mangler'];
    return [Math.max(0, naaVerdi - forste[1]), 'forelopig_delvis'];
  }
}

module.exports = { Timemaler, TOL_MALT_SEK, MAKS_GAP_SEK, VENT_PA_PROVE_SEK, RESET_TOLERANSE, TYNN_SEK, timestart, nokkel };
