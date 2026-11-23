'use strict';

/**
 * Lastprofilen: hva huset bruker utenom det motoren styrer, per ukedag og time.
 *
 * Brukes til å anslå resten av timen. Rett fram i tid veier øyeblikksverdien tyngst;
 * lenger fram tar den lærte profilen over.
 */

const { osloDeler } = require('./kalender');

class Lastprofil {
  /** @param {object} tilstand { "<ukedag>-<time>": {kw, n} } */
  constructor(tilstand = {}) {
    this.m = tilstand;
  }

  static nokkel(ms) {
    const d = osloDeler(ms);
    return `${d.ukedag}-${d.time}`;
  }

  /** Én observasjon av uregulert last (kW). Kalles hvert femte minutt. */
  laer(ms, kw) {
    if (!Number.isFinite(kw) || kw < 0) return;
    const nk = Lastprofil.nokkel(ms);
    const rad = this.m[nk] || { kw, n: 0 };
    const n = rad.n + 1;
    const alfa = Math.max(0.05, 1 / Math.min(n, 20));
    this.m[nk] = { kw: Math.round((rad.kw * (1 - alfa) + kw * alfa) * 1000) / 1000, n };
  }

  /** Forventet uregulert last (kW) `minutterFrem` minutter fram, gitt lasten nå. */
  prognose(ms, naaKw, minutterFrem = 15) {
    const rad = this.m[Lastprofil.nokkel(ms + minutterFrem * 60000)];
    if (!rad || rad.n < 3) return Math.max(naaKw, 0.25);
    const vekt = Math.min(1, minutterFrem / 45);
    return Math.max(0.15, naaKw * (1 - vekt) + rad.kw * vekt);
  }
}

module.exports = { Lastprofil };
