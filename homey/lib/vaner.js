'use strict';

/**
 * Selvlærende vaner: når dere pleier å komme hjem og dra, og når huset våkner.
 *
 * Lærer tre ting, alle som et glidende snitt per ukedag:
 *   - ankomst etter en lengre tur (minst tolv timer borte) — «dere er vanligvis hjemme søndag kl. 13:20»
 *   - avreise
 *   - morgenstart: første gang forbruket løfter seg over nattnivået, hverdag og helg for seg
 *
 * Vanene brukes på to måter: som forslag («Flytt dagstart til 06:30»), og — når brukeren
 * slår det på — til å la lært hjemkomsttid erstatte den faste.
 */

const { osloDeler, osloDato } = require('./kalender');

const TIME_MS = 3600000;
const MIN_OBS = 3;
const klokke = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`;
const UKEDAGER = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];

function glatt(rad, min) {
  if (!rad) return { min, n: 1 };
  const alfa = Math.max(0.2, 1 / (rad.n + 1));
  return { min: Math.round(rad.min * (1 - alfa) + min * alfa), n: rad.n + 1 };
}

class Vaner {
  constructor(tilstand = {}) {
    this.m = tilstand;
    this.m.ankomst = this.m.ankomst || {};     // ukedag → {min, n}
    this.m.avreise = this.m.avreise || {};
    this.m.morgen = this.m.morgen || {};       // 'hverdag' | 'helg' → {min, n}
    this.m.natt = this.m.natt || {};           // dato → {sum, n} for nattnivået
  }

  ankomst(ms, borteMs) {
    if (borteMs < 12 * TIME_MS) return;        // en tur på butikken er ikke en hjemkomst
    const d = osloDeler(ms);
    this.m.ankomst[d.ukedag] = glatt(this.m.ankomst[d.ukedag], d.time * 60 + d.minutt);
  }

  avreise(ms) {
    const d = osloDeler(ms);
    this.m.avreise[d.ukedag] = glatt(this.m.avreise[d.ukedag], d.time * 60 + d.minutt);
  }

  /** Lært hjemkomsttid for ukedagen (minutter siden midnatt), eller null før det er nok grunnlag. */
  hjemkomstMinutter(ukedag) {
    const rad = this.m.ankomst[ukedag];
    return rad && rad.n >= MIN_OBS ? rad.min : null;
  }

  /**
   * Én måling av husets øvrige forbruk (kW), hvert femte minutt. Morgenstart er første gang
   * mellom kl. 04 og 11 at forbruket ligger 60 % og minst 0,3 kW over nattnivået (kl. 01–04).
   */
  last(ms, kw) {
    if (!Number.isFinite(kw)) return;
    const d = osloDeler(ms);
    const dato = osloDato(ms);
    const m = this.m;
    if (m.natt.dato !== dato) m.natt = { dato, sum: 0, n: 0, funnet: false };
    if (d.time >= 1 && d.time < 4) { m.natt.sum += kw; m.natt.n += 1; return; }
    if (m.natt.funnet || m.natt.n < 6 || d.time < 4 || d.time >= 11) return;
    const nivaa = m.natt.sum / m.natt.n;
    if (kw > nivaa * 1.6 && kw > nivaa + 0.3) {
      m.natt.funnet = true;
      const type = d.ukedag >= 5 ? 'helg' : 'hverdag';
      m.morgen[type] = glatt(m.morgen[type], d.time * 60 + d.minutt);
    }
  }

  /** Forslag til endringer, som tekst. `innst` har dagStart, hjemkomstUkedag og hjemkomstTid. */
  forslag(innst) {
    const ut = [];
    const [t, m] = String(innst.dagStart || '06:00').split(':').map(Number);
    const dagStart = t * 60 + m;
    const morgen = this.m.morgen.hverdag;
    if (morgen && morgen.n >= 5 && Math.abs(morgen.min - 30 - dagStart) >= 30) {
      ut.push({ type: 'dagstart', verdi: klokke(Math.max(0, morgen.min - 30)),
        tekst: `Huset våkner vanligvis kl. ${klokke(morgen.min)} på hverdager. Dagen starter nå kl. ${klokke(dagStart)} — ${klokke(Math.max(0, morgen.min - 30))} ville passet bedre.` });
    }
    const ukedag = innst.hjemkomstUkedag;
    if (ukedag !== null && ukedag !== undefined) {
      const laert = this.hjemkomstMinutter(Number(ukedag));
      const [ht, hm] = String(innst.hjemkomstTid || '13:00').split(':').map(Number);
      if (laert !== null && Math.abs(laert - (ht * 60 + hm)) >= 30) {
        ut.push({ type: 'hjemkomst', verdi: klokke(laert),
          tekst: `Dere kommer vanligvis hjem ${UKEDAGER[ukedag]} kl. ${klokke(laert)}, ikke kl. ${klokke(ht * 60 + hm)}.` });
      }
    }
    return ut;
  }

  bilde() {
    const rader = (kart) => Object.entries(kart).map(([k, v]) => ({ nokkel: k, tid: klokke(v.min), n: v.n }));
    return { ankomst: rader(this.m.ankomst), avreise: rader(this.m.avreise), morgen: rader(this.m.morgen) };
  }
}

module.exports = { Vaner, MIN_OBS };
