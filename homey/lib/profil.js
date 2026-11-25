'use strict';

/**
 * Forbruksprognosen: hva huset bruker utenom det motoren styrer.
 *
 * Tre ting læres:
 *   1. Mønsteret: snitt og spredning per ukedag og time. Nye installasjoner har lite data per
 *      ukedag, så prognosen lener seg på «hverdag/helg + time» og «time» til ukedagen er lært.
 *   2. Hvor lenge et avvik varer: bruker huset mer enn mønsteret akkurat nå (noen lager
 *      middag), holder det seg en stund. Hvor fort det dør ut, læres av hvordan det faktisk gikk.
 *   3. Hvor godt prognosen treffer: hver prognose sjekkes mot fasiten et kvarter senere.
 *      Bommene gir reserven motoren holder av — stor når forbruket er uforutsigbart, liten
 *      når det er jevnt.
 */

const { osloDeler } = require('./kalender');

const MIN = 60000;
const KVARTER = 15 * MIN;

class Lastprofil {
  /** @param {object} tilstand { "<nøkkel>": {kw, n, v}, _: {rho, feil, skjev, ventende} } */
  constructor(tilstand = {}) {
    this.m = tilstand;
    if (!this.m._) this.m._ = { rho: 0.75, feil: null, skjev: 0, ventende: [], n: 0 };
  }

  static nokler(ms) {
    const d = osloDeler(ms);
    return [`${d.ukedag}-${d.time}`, `${d.ukedag >= 5 ? 'helg' : 'hverdag'}-${d.time}`, `t-${d.time}`];
  }

  /** Beholdt for kall som bare trenger ukedag-time-nøkkelen. */
  static nokkel(ms) {
    return Lastprofil.nokler(ms)[0];
  }

  /** Mønsterets forventning og spredning på tidspunktet: {kw, sigma, n} eller null når ingenting er lært. */
  monster(ms) {
    // Krymping: ukedagen teller fullt når den har nok data; ellers fylles det på fra de grovere nivåene.
    let vekt = 0;
    let kw = 0;
    let varians = 0;
    let igjen = 1;
    let nTotalt = 0;
    for (const nk of Lastprofil.nokler(ms)) {
      const rad = this.m[nk];
      if (!rad || !rad.n) continue;
      const w = igjen * Math.min(1, rad.n / 8);
      kw += w * rad.kw;
      varians += w * (rad.v || 0);
      vekt += w;
      igjen -= w;
      nTotalt += rad.n;
      if (igjen <= 0.01) break;
    }
    if (vekt < 0.2) return null;
    return { kw: kw / vekt, sigma: Math.sqrt(varians / vekt), n: nTotalt };
  }

  /** Én observasjon av uregulert last (kW). Kalles hvert femte minutt. */
  laer(ms, kw) {
    if (!Number.isFinite(kw) || kw < 0) return;
    const f = this.m._;
    // Fasiten for prognosene som ble laget for et kvarter siden.
    const modne = f.ventende.filter((p) => ms >= p.ms);
    f.ventende = f.ventende.filter((p) => ms < p.ms).slice(-6);
    for (const p of modne) {
      if (ms - p.ms > 10 * MIN) continue;
      const bom = kw - p.kw;
      f.feil = f.feil === null ? Math.abs(bom) : Math.sqrt(0.95 * f.feil ** 2 + 0.05 * bom ** 2);
      f.skjev = 0.95 * f.skjev + 0.05 * bom;
      f.n += 1;
      // Varte avviket? Var huset over mønsteret da prognosen ble laget og er det fortsatt,
      // skal avvik veie tyngre neste gang; var det borte, lettere.
      if (Math.abs(p.avvik) > 0.2 && Number.isFinite(p.monster)) {
        const varte = (kw - p.monster) / p.avvik;
        f.rho = Math.round(Math.min(0.95, Math.max(0.3, 0.97 * f.rho + 0.03 * Math.min(1.2, Math.max(0, varte)))) * 1000) / 1000;
      }
    }
    for (const nk of Lastprofil.nokler(ms)) {
      const rad = this.m[nk] || { kw, n: 0, v: 0 };
      const n = rad.n + 1;
      const alfa = Math.max(0.04, 1 / Math.min(n, 25));
      const avvik = kw - rad.kw;
      this.m[nk] = {
        kw: Math.round((rad.kw + alfa * avvik) * 1000) / 1000,
        v: Math.round(((1 - alfa) * ((rad.v || 0) + alfa * avvik * avvik)) * 10000) / 10000,
        n,
      };
    }
    // Prognosen som skal sjekkes om et kvarter.
    const m = this.monster(ms + KVARTER);
    const naa = this.monster(ms);
    f.ventende.push({ ms: ms + KVARTER, kw: this.prognose(ms, kw, 15), avvik: naa ? kw - naa.kw : 0, monster: m ? m.kw : null });
  }

  /** Forventet uregulert last (kW) `minutterFrem` minutter fram, gitt lasten nå. */
  prognose(ms, naaKw, minutterFrem = 15) {
    const naa = this.monster(ms);
    const fram = this.monster(ms + minutterFrem * MIN);
    if (!naa || !fram || fram.n < 3) return Math.max(naaKw, 0.25);
    const avvik = naaKw - naa.kw;
    const rho = this.m._.rho ** (minutterFrem / 15);
    return Math.max(0.15, fram.kw + avvik * rho);
  }

  /**
   * Reserven motoren bør holde av (kW): hvor mye prognosen pleier å bomme med, pluss
   * skjevheten når den bommer mest én vei. `standard` gjelder til nok er lært.
   */
  reserve(standard = 0.35) {
    const f = this.m._;
    if (f.feil === null || f.n < 12) return standard;
    return Math.round(Math.min(1.5, Math.max(0.15, 1.1 * f.feil + Math.max(0, f.skjev))) * 100) / 100;
  }

  /** Forventet last og usikkerhet i en hel time fram i tid (til varmeplanen): {kw, sigma} eller null. */
  time(ms) {
    const m = this.monster(ms + 30 * MIN);
    return m && m.n >= 3 ? { kw: m.kw, sigma: m.sigma } : null;
  }

  treffsikkerhet() {
    const f = this.m._;
    return { feil_kw: f.feil === null ? null : Math.round(f.feil * 100) / 100, skjevhet_kw: Math.round(f.skjev * 100) / 100, varighet: f.rho, n: f.n };
  }
}

module.exports = { Lastprofil };
