'use strict';

/**
 * Termisk modell for ett rom, og læringen av den.
 *
 * Rommet følger dT/dt = r·u − k·(T − ute): ovnen gir r °C/t ved full effekt (u = 1), og
 * tapet vokser med forskjellen til ute. k er 1/tidskonstanten (per time).
 *
 * Samme modell og læring som i Home Assistant-versjonen (engine.py): raten måles over
 * vinduer på minst 30 min med samme tilstand (varmer / av), så termostater som melder i
 * halve grader ikke gir skjeve tall.
 */

const STANDARD = { k: 0.08, varme_rate: 1.2, rate_max: null, n: 0 };
const VINDU_MIN_TIMER = 0.5;
const VINDU_MAKS_TIMER = 1.5;

/** Temperaturen etter `timer` med pådrag u (0–1). Eksakt løsning av modellen. */
function simuler(T, ute, u, modell, timer = 1) {
  const k = Math.max(0.005, modell.k);
  const likevekt = ute + (modell.r * u) / k;
  return likevekt + (T - likevekt) * Math.exp(-k * timer);
}

/** Pådraget (0–1) som holder rommet på T. Over 1 betyr at ovnen ikke klarer det i dette været. */
const holdepaadrag = (T, ute, modell) => Math.max(0, (Math.max(0.005, modell.k) * (T - ute)) / modell.r);

/**
 * Minutter fra `fra` til `til` ved full effekt, eller null når rommet ikke når målet i dette været.
 * t = ln((r − k·(fra − ute)) / (r − k·(til − ute))) / k
 */
function forvarmingMinutter(modell, fra, til, ute) {
  if (til <= fra) return 0;
  const k = Math.max(0.005, modell.k);
  const tapTil = k * (til - ute);
  if (modell.r <= tapTil + 1e-6) return null;
  const tapFra = k * (fra - ute);
  return Math.max(0, (Math.log(Math.max(modell.r - tapFra, 1e-6) / (modell.r - tapTil)) / k) * 60);
}

class Laering {
  /** @param {object} tilstand { soner: {key: {k, varme_rate, rate_max, n}}, vindu: {key: {t, ms, tilstand}} } */
  constructor(tilstand = {}) {
    this.m = tilstand;
    this.m.soner = this.m.soner || {};
    this.m.vindu = this.m.vindu || {};
  }

  hent(key) {
    return { ...STANDARD, ...(this.m.soner[key] || {}) };
  }

  /** Modellen planleggeren bruker: {k, r, laert}. Ulært rom får forsiktige standardverdier. */
  modell(key) {
    const rad = this.hent(key);
    const laert = rad.rate_max !== null && rad.n >= 5;
    return { k: rad.k, r: laert ? rad.rate_max : Math.max(rad.varme_rate + rad.k * 20, 1.5), laert, n: rad.n };
  }

  /**
   * Én observasjon. `tilstand` er 'varmer' (ovnen går), 'av' (ovnen står) eller null
   * (ukjent, åpent vindu, eller blandet) — null nullstiller vinduet uten å lære.
   * Returnerer true hvis noe ble lært.
   */
  observer(key, { ms, temp, ute, tilstand }) {
    if (!Number.isFinite(temp) || !Number.isFinite(ute)) return false;
    const gammel = this.m.vindu[key];
    const ny = { t: temp, ms, tilstand };
    if (!gammel || gammel.tilstand !== tilstand || tilstand === null) { this.m.vindu[key] = ny; return false; }
    const timer = (ms - gammel.ms) / 3600000;
    if (timer <= 0 || timer > VINDU_MAKS_TIMER) { this.m.vindu[key] = ny; return false; }
    if (timer < VINDU_MIN_TIMER) return false;       // vinduet er ikke fullt ennå — behold startpunktet
    this.m.vindu[key] = ny;
    const endring = (temp - gammel.t) / timer;
    const diff = temp - ute;
    const rad = this.hent(key);
    if (tilstand === 'av' && diff > 3 && endring <= 0) {
      const k = Math.min(0.5, Math.max(0.005, -endring / diff));
      const alfa = Math.max(0.05, 1 / Math.min(rad.n + 1, 30));
      rad.k = Math.round((rad.k * (1 - alfa) + k * alfa) * 10000) / 10000;
    } else if (tilstand === 'varmer' && endring > 0) {
      rad.varme_rate = Math.round(Math.max(0.05, rad.varme_rate * 0.85 + endring * 0.15) * 1000) / 1000;
      // Oppvarmingsevnen uavhengig av været: det rommet stiger pluss det som samtidig tapes.
      const r = endring + rad.k * Math.max(diff, 0);
      rad.rate_max = Math.round(Math.max(0.05, (rad.rate_max ?? r) * 0.85 + r * 0.15) * 1000) / 1000;
    } else {
      return false;
    }
    rad.n += 1;
    this.m.soner[key] = rad;
    return true;
  }
}

module.exports = { STANDARD, simuler, holdepaadrag, forvarmingMinutter, Laering };
