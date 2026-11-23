'use strict';

/**
 * Huset: hvem som er hjemme, bortemodus og hjemkomst.
 *
 *  - Bortemodus slår seg på når alle har vært borte lenge nok, og av i det noen kommer hjem.
 *    Det er overgangen borte → hjemme som avslutter den, ikke at noen er hjemme: bortemodus
 *    satt for hånd mens noen er hjemme, står til dere har dratt og kommet tilbake.
 *  - Hjemkomst er tidspunktet huset skal være varmt igjen. Den kan settes for hånd, eller
 *    følge en fast ukedag og tid (søndag kl. 13). Etter tiden holdes dagtemperatur til noen
 *    kommer; kommer ingen på seks timer, går huset tilbake til bortetemperatur.
 *
 * Klassen er ren: den får tilstedeværelse inn og gir kontekst og hendelser ut.
 */

const { osloDeler, osloDato, osloTilUtc } = require('./kalender');
const { minutter } = require('./program');

const TIME_MS = 3600000;
const DOGN_MS = 86400000;
const PERSONTYPER = ['barn', 'ungdom', 'voksen'];

const STANDARD = {
  personer: [],                  // [{key, navn, type, kilde: {type: 'bruker'|'variabel'|'enhet', id, kap}, natt, dag, borteFra, borteTil, vekking, vekkingHelg, ferie}]
  borteAuto: true,
  borteAutoTimer: 3,
  borteAutoDager: 'alle',        // 'alle' | 'helg' (bare torsdag og fredag, som i Home Assistant-versjonen)
  borteAutoTemp: true,           // bortetemperaturen velges per rom av motoren
  borteMinTemp: 12,
  borteTempPanel: 16,
  borteTempGulv: 18,
  borteTempBad: 22,
  forvarmHjemkomst: true,
  hjemkomstUkedag: 6,            // 0 = mandag … 6 = søndag, null = ingen fast hjemkomst
  hjemkomstTid: '13:00',
  vanerStyrer: false,            // la lært hjemkomsttid erstatte den faste
};

class Hus {
  constructor(tilstand, innstillinger) {
    this.t = tilstand;
    for (const [k, v] of Object.entries({ borte: false, borte_siden: null, hjemkomst: null, auto_dag: null, forlenget: null })) {
      if (this.t[k] === undefined) this.t[k] = v;
    }
    this.settInnstillinger(innstillinger);
    this.tilstede = {};
  }

  settInnstillinger(innstillinger) {
    this.i = { ...STANDARD, ...(innstillinger || {}) };
    this.i.personer = (this.i.personer || []).filter((p) => p && p.key);
  }

  /** True når alle kjente er borte, false når noen er hjemme, null når ingen er kjent. */
  alleBorte() {
    const kjent = this.i.personer.map((p) => this.tilstede[p.key]).filter((v) => v === true || v === false);
    if (!kjent.length) return null;
    return !kjent.some(Boolean);
  }

  /**
   * @param {number} ms
   * @param {object} tilstede {key: true|false|null}
   * @param {object|null} vaner Vaner — får ankomster og avreiser
   * @returns {Array<{type: string, tekst: string}>}
   */
  tick(ms, tilstede, vaner = null) {
    const t = this.t;
    const i = this.i;
    this.tilstede = tilstede || {};
    const hendelser = [];
    const borte = this.alleBorte();

    if (borte === true) {
      if (t.borte_siden === null) { t.borte_siden = ms; if (vaner) vaner.avreise(ms); }
    } else if (borte === false) {
      const varBorteSiden = t.borte_siden;
      t.borte_siden = null;
      if (varBorteSiden !== null) {
        if (vaner) vaner.ankomst(ms, ms - varBorteSiden);
        if (t.borte || t.hjemkomst !== null) {
          t.borte = false; t.hjemkomst = null; t.forlenget = null;
          hendelser.push({ type: 'kom_hjem', tekst: 'Noen kom hjem — tilbake til vanlig program.' });
        }
      }
    }

    // Automatisk bortemodus når alle har vært ute lenge nok
    const d = osloDeler(ms);
    const dagOk = i.borteAutoDager === 'helg' ? d.ukedag === 3 || d.ukedag === 4 : true;
    if (borte === true && i.borteAuto && !t.borte && dagOk && t.borte_siden !== null
        && ms - t.borte_siden >= Number(i.borteAutoTimer) * TIME_MS && t.auto_dag !== osloDato(ms)) {
      t.auto_dag = osloDato(ms);
      t.borte = true;
      hendelser.push({ type: 'borte_paa', tekst: `Alle har vært borte i ${i.borteAutoTimer} timer — huset er satt i bortemodus.` });
    }

    // Satt hjemkomst er passert med god margin og ingen kom: tilbake til bortetemperatur
    if (t.borte && t.hjemkomst !== null && ms > t.hjemkomst + 6 * TIME_MS && borte !== false) {
      t.hjemkomst = null;
      t.forlenget = osloDato(ms);
      hendelser.push({ type: 'kom_ikke', tekst: 'Ingen kom til planlagt tid — huset går tilbake til bortetemperatur.' });
    }
    return hendelser;
  }

  /** Når huset skal være varmt igjen (UTC-ms), eller null. Bare i bortemodus. */
  hjemkomstMs(ms, vaner = null) {
    const t = this.t;
    const i = this.i;
    if (!t.borte) return null;
    if (t.hjemkomst !== null) return t.hjemkomst;
    if (!i.forvarmHjemkomst || i.hjemkomstUkedag === null || i.hjemkomstUkedag === undefined) return null;
    const ukedag = Number(i.hjemkomstUkedag);
    let min = minutter(i.hjemkomstTid, 13 * 60);
    if (i.vanerStyrer && vaner) min = vaner.hjemkomstMinutter(ukedag) ?? min;
    const d = osloDeler(ms);
    const fram = (ukedag - d.ukedag + 7) % 7;
    const dag = osloDeler(ms + fram * DOGN_MS);
    const tid = osloTilUtc(dag.aar, dag.mnd, dag.dag, Math.floor(min / 60), min % 60);
    // I dag: tiden gjelder også etter at den er passert, til noen kommer. «Forleng» hopper over dagen.
    if (t.forlenget === osloDato(tid)) return null;
    return tid;
  }

  /** Det programmet og berederen trenger å vite om huset akkurat nå. */
  kontekst(ms, vaner = null) {
    const personer = {};
    for (const p of this.i.personer) personer[p.key] = { ...p, hjemme: this.tilstede[p.key] ?? null };
    return { naaMs: ms, borte: Boolean(this.t.borte), hjemkomstMs: this.hjemkomstMs(ms, vaner), alleBorte: this.alleBorte(), personer };
  }

  settBorte(paa, ms) {
    this.t.borte = Boolean(paa);
    if (!paa) { this.t.hjemkomst = null; this.t.forlenget = null; }
    // Ikke la automatikken slå den på igjen samme dag etter at den er slått av for hånd.
    this.t.auto_dag = osloDato(ms);
  }

  /** Sett hjemkomst til et klokkeslett («HH:MM», neste gang det inntreffer) eller et tidspunkt (ms). */
  settHjemkomst(naar, ms) {
    let tid = Number(naar);
    if (typeof naar === 'string' && naar.includes(':')) {
      const min = minutter(naar, 13 * 60);
      const d = osloDeler(ms);
      tid = osloTilUtc(d.aar, d.mnd, d.dag, Math.floor(min / 60), min % 60);
      if (tid <= ms) tid += DOGN_MS;
    }
    this.t.borte = true;
    this.t.hjemkomst = tid;
    this.t.forlenget = null;
    return tid;
  }

  /** Bli borte lenger: dagens (eller neste) faste hjemkomst hoppes over. */
  forleng(ms) {
    const neste = this.hjemkomstMs(ms);
    this.t.hjemkomst = null;
    this.t.forlenget = osloDato(neste ?? ms);
  }

  bilde(ms, vaner = null) {
    const t = this.t;
    const hjemkomst = this.hjemkomstMs(ms, vaner);
    const borte = this.alleBorte();
    let modus = 'Hjemme';
    if (t.borte) modus = hjemkomst !== null && ms >= hjemkomst ? 'Venter på dere' : hjemkomst !== null && hjemkomst - ms < 36 * TIME_MS ? 'Borte — varmer til hjemkomst' : 'Borte';
    else if (borte === true) modus = 'Alle ute';
    return {
      modus, borte: Boolean(t.borte), alle_borte: borte,
      borte_siden: t.borte_siden ? new Date(t.borte_siden).toISOString() : null,
      hjemkomst: hjemkomst !== null ? new Date(hjemkomst).toISOString() : null,
      personer: this.i.personer.map((p) => ({ key: p.key, navn: p.navn || p.key, type: p.type || 'voksen', hjemme: this.tilstede[p.key] ?? null })),
    };
  }
}

module.exports = { Hus, STANDARD, PERSONTYPER };
