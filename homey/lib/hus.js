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

const { osloDeler, osloDato, osloTilUtc, ukestart } = require('./kalender');
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
  varsler: {},                   // se VARSLER
};

/** Varslene om helg, ferie og hjemkomst. Hvert kan slås av; flow-kortene utløses uansett. */
const VARSLER = {
  helg: true,                    // spør før helgen om dere skal bort
  helgDag: 3,                    // 0 = mandag … 3 = torsdag
  helgTid: '17:00',
  ferie: true,                   // si fra når huset regnes som på ferie
  ferieDager: 2,                 // uten fast hjemkomst: så lenge tomt før det regnes som ferie
  hjemkomst: true,               // si fra når oppvarmingen starter og når huset er varmt
};

const kl = (ms) => { const d = osloDeler(ms); return `${String(d.time).padStart(2, '0')}:${String(d.minutt).padStart(2, '0')}`; };
const UKEDAGER = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];

class Hus {
  constructor(tilstand, innstillinger) {
    this.t = tilstand;
    for (const [k, v] of Object.entries({ borte: false, borte_siden: null, hjemkomst: null, auto_dag: null, forlenget: null, helg: null, ferie: false, varslet: {} })) {
      if (this.t[k] === undefined) this.t[k] = v;
    }
    this.settInnstillinger(innstillinger);
    this.tilstede = {};
  }

  settInnstillinger(innstillinger) {
    this.i = { ...STANDARD, ...(innstillinger || {}) };
    this.i.personer = (this.i.personer || []).filter((p) => p && p.key);
    this.v = { ...VARSLER, ...(this.i.varsler || {}) };
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
   * @param {object} varme fra motoren: {forvarmer: boolean, kalde: [{navn, temp, krav}]}
   * @returns {Array<{type: string, tekst: string, varsle?: boolean}>} `varsle` false = utløs flow-kortet, men send ikke varsel
   */
  tick(ms, tilstede, vaner = null, varme = {}) {
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
          const varFerie = t.ferie;
          t.borte = false; t.hjemkomst = null; t.forlenget = null; t.ferie = false; t.varslet = {};
          hendelser.push({ type: 'kom_hjem', tekst: varFerie ? 'Velkommen hjem fra ferie — tilbake til vanlig program.' : 'Noen kom hjem — tilbake til vanlig program.', varsle: this.v.hjemkomst });
        }
      }
    }

    const d = osloDeler(ms);
    const v = this.v;
    const naaMin = d.time * 60 + d.minutt;

    // --- Helgen: spør på forhånd, og bruk svaret ---
    const uke = ukestart(osloDato(ms));
    if (t.helg && t.helg.uke !== uke) t.helg = null;
    const sporretid = naaMin >= minutter(v.helgTid, 17 * 60);
    if (i.personer.length && !t.borte && sporretid) {
      if (!t.helg && d.ukedag === Number(v.helgDag)) {
        t.helg = { uke, svar: null, spurt: 1 };
        hendelser.push({ type: 'helg_sporsmaal', varsle: v.helg, tekst: 'Skal dere bort i helgen? Svar «bort» eller «hjemme» i KI Energi (eller med et flow-kort). Uten svar finner appen det ut selv når alle har dratt.' });
      } else if (t.helg && t.helg.svar === null && t.helg.spurt === 1 && d.ukedag === (Number(v.helgDag) + 1) % 7 && borte !== true) {
        // Dagen etter, bare hvis dere fortsatt er hjemme og ikke har svart
        t.helg.spurt = 2;
        hendelser.push({ type: 'helg_sporsmaal', varsle: v.helg, tekst: 'Dere er fortsatt hjemme. Blir dere hjemme i helgen, eller drar dere bort?' });
      }
    }
    // Svaret «bort»: huset senkes i det siste person drar, uten å vente noen timer først
    if (t.helg && t.helg.svar === 'bort' && borte === true && !t.borte) {
      t.borte = true;
      t.auto_dag = osloDato(ms);
      const hjem = this.hjemkomstMs(ms, vaner);
      hendelser.push({ type: 'borte_paa', tekst: `Alle har dratt — huset er satt i bortemodus${hjem !== null ? ` og er varmt igjen ${UKEDAGER[osloDeler(hjem).ukedag]} kl. ${kl(hjem)}` : ''}.` });
    }

    // Automatisk bortemodus når alle har vært ute lenge nok
    const dagOk = i.borteAutoDager === 'helg' ? d.ukedag === 3 || d.ukedag === 4 : true;
    const blirHjemme = t.helg && t.helg.svar === 'hjemme';        // dere har sagt at dere blir hjemme: en lang tur ut er ikke en reise
    if (borte === true && i.borteAuto && !t.borte && dagOk && !blirHjemme && t.borte_siden !== null
        && ms - t.borte_siden >= Number(i.borteAutoTimer) * TIME_MS && t.auto_dag !== osloDato(ms)) {
      t.auto_dag = osloDato(ms);
      t.borte = true;
      hendelser.push({ type: 'borte_paa', tekst: `Alle har vært borte i ${i.borteAutoTimer} timer — huset er satt i bortemodus.` });
    }

    // Satt hjemkomst er passert med god margin og ingen kom: tilbake til bortetemperatur
    // Gjelder både en hjemkomst du har satt selv og den faste ukentlige.
    const planlagt = t.borte ? this.hjemkomstMs(ms, vaner) : null;
    if (planlagt !== null && ms > planlagt + 6 * TIME_MS && borte !== false) {
      t.hjemkomst = null;
      t.forlenget = osloDato(ms);
      // Fra nå regnes huset som på ferie: den faste hjemkomsten varmer ikke opp et tomt hus uke etter uke.
      t.ferie = true;
      t.varslet.ferie = true;
      hendelser.push({ type: 'kom_ikke', varsle: v.ferie, tekst: 'Ingen kom til planlagt tid. Huset regnes som på ferie og holder bortetemperatur til noen kommer hjem, eller til du setter «Vi kommer hjem kl. …».' });
    }

    // --- Ferie: tomt hus uten noen planlagt hjemkomst ---
    if (t.borte && !t.ferie && t.borte_siden !== null && this.hjemkomstMs(ms, vaner) === null
        && ms - t.borte_siden >= Number(v.ferieDager) * DOGN_MS) {
      t.ferie = true;
    }
    if (t.borte && t.ferie && !t.varslet.ferie) {
      t.varslet.ferie = true;
      const hjem = t.hjemkomst;
      hendelser.push({ type: 'ferie', varsle: v.ferie, tekst: hjem !== null
        ? `Feriemodus: huset holder bortetemperatur og berederen hviler. Det er varmt igjen ${UKEDAGER[osloDeler(hjem).ukedag]} ${osloDeler(hjem).dag}.${osloDeler(hjem).mnd}. kl. ${kl(hjem)}.`
        : 'Huset har stått tomt lenge og regnes som på ferie: det holder bortetemperatur og berederen hviler. Si fra når dere kommer med «Vi kommer hjem kl. …», så er det varmt.' });
    }

    // --- Hjemkomst: si fra når oppvarmingen starter, og når huset er klart ---
    const hjem = t.borte ? this.hjemkomstMs(ms, vaner) : null;
    if (hjem !== null) {
      if (varme.forvarmer && ms < hjem && t.varslet.forvarm !== hjem) {
        t.varslet.forvarm = hjem;
        hendelser.push({ type: 'forvarmer', varsle: v.hjemkomst, tekst: `Oppvarmingen til hjemkomst ${UKEDAGER[osloDeler(hjem).ukedag]} kl. ${kl(hjem)} har startet.` });
      }
      if (ms >= hjem && ms < hjem + TIME_MS && t.varslet.klar !== hjem) {
        t.varslet.klar = hjem;
        const kalde = varme.kalde || [];
        hendelser.push({ type: 'hjemkomst_klar', varsle: v.hjemkomst, tekst: kalde.length
          ? `Klokka er ${kl(hjem)}, men huset er ikke helt varmt ennå: ${kalde.map((r) => `${r.navn} ${String(r.temp).replace('.', ',')} °C av ${r.krav}`).join(', ')}.`
          : `Huset er varmt og klart til dere kommer (kl. ${kl(hjem)}).` });
      }
    }
    return hendelser;
  }

  /** Når huset skal være varmt igjen (UTC-ms), eller null. Bare i bortemodus. */
  hjemkomstMs(ms, vaner = null) {
    const t = this.t;
    const i = this.i;
    if (!t.borte) return null;
    if (t.hjemkomst !== null) return t.hjemkomst;
    if (t.ferie) return null;            // på ferie gjelder bare en hjemkomst du selv har satt
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
    if (!paa) { this.t.hjemkomst = null; this.t.forlenget = null; this.t.ferie = false; this.t.varslet = {}; }
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

  /**
   * Svar på helgespørsmålet. 'bort': huset senkes i det siste person drar. 'hjemme': ingen
   * automatisk bortemodus resten av uka. Returnerer en bekreftelse.
   */
  svarHelg(svar, ms) {
    const bort = svar === 'bort';
    this.t.helg = { uke: ukestart(osloDato(ms)), svar: bort ? 'bort' : 'hjemme', spurt: 2 };
    if (!bort) return 'Greit — dere blir hjemme i helgen. Huset følger vanlig program.';
    const i = this.i;
    const fast = i.forvarmHjemkomst && i.hjemkomstUkedag !== null && i.hjemkomstUkedag !== undefined;
    return `Greit — huset senkes når alle har dratt${fast ? `, og er varmt igjen ${UKEDAGER[Number(i.hjemkomstUkedag)]} kl. ${i.hjemkomstTid}` : ''}.`;
  }

  /** Ferie: bortemodus uten den faste ukentlige hjemkomsten. `tilMs` er når huset skal være varmt igjen, eller null. */
  settFerie(tilMs, ms) {
    this.t.borte = true;
    this.t.ferie = true;
    this.t.hjemkomst = Number.isFinite(tilMs) && tilMs > ms ? tilMs : null;
    this.t.forlenget = null;
    this.t.varslet = {};
    this.t.auto_dag = osloDato(ms);
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
    if (t.borte && t.ferie && hjemkomst === null) modus = 'Ferie';
    else if (t.borte) modus = hjemkomst !== null && ms >= hjemkomst ? 'Venter på dere' : hjemkomst !== null && hjemkomst - ms < 36 * TIME_MS ? 'Borte — varmer til hjemkomst' : 'Borte';
    else if (borte === true) modus = 'Alle ute';
    return {
      modus, borte: Boolean(t.borte), alle_borte: borte, ferie: Boolean(t.borte && t.ferie),
      helg: t.helg ? { svar: t.helg.svar, spurt: t.helg.spurt > 0 } : null,
      borte_siden: t.borte_siden ? new Date(t.borte_siden).toISOString() : null,
      hjemkomst: hjemkomst !== null ? new Date(hjemkomst).toISOString() : null,
      personer: this.i.personer.map((p) => ({ key: p.key, navn: p.navn || p.key, type: p.type || 'voksen', hjemme: this.tilstede[p.key] ?? null })),
    };
  }
}

module.exports = { Hus, STANDARD, VARSLER, PERSONTYPER };
