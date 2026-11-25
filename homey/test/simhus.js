'use strict';

/**
 * Et simulert rom med kjent fysikk, til å prøve læringen og planleggingen mot.
 * Minutt for minutt, med termostat som melder i halve grader, vind, sol og målestøy.
 */

const { solmot } = require('../lib/sol');

const MIN = 60000;
const LAT = 59.91;
const LON = 10.75;

/** Deterministisk slumptall (mulberry32), så testene gir samme svar hver gang. */
function slump(fro) {
  let a = fro >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Simrom {
  /**
   * @param {object} sann {r, k, kv, sol: {ost, sor, vest}, g, d, treghet (timer), effektKw}
   * @param {object} valg {start, opplosning (°C), stoy (°C), fro}
   */
  constructor(sann, valg = {}) {
    this.sann = { kv: 0, sol: { ost: 0, sor: 0, vest: 0 }, g: 0, d: 0, treghet: 0, effektKw: 1, ...sann };
    this.T = valg.start ?? 20;
    this.ueff = 0;
    this.opplosning = valg.opplosning ?? 0.5;
    this.stoy = valg.stoy ?? 0.05;
    this.tilfeldig = slump(valg.fro ?? 1);
    this.paa = false;
    this.kwh = 0;
  }

  /** Været på et tidspunkt: døgnsving, frontpassasjer, vind og skyer som varierer langsomt. */
  static vaer(ms, grunn = -2) {
    const t = ms / 3600000;
    return {
      ute: grunn + 3 * Math.sin((2 * Math.PI * (t - 9)) / 24) + 4 * Math.sin((2 * Math.PI * t) / 190) + 1.5 * Math.sin((2 * Math.PI * t) / 57),
      vind: Math.max(0, 4 + 3.5 * Math.sin((2 * Math.PI * t) / 83) + 2 * Math.sin((2 * Math.PI * t) / 31)),
      sky: Math.min(100, Math.max(0, 50 + 55 * Math.sin((2 * Math.PI * t) / 67))),
    };
  }

  /** Ett minutt. `settpunkt` styrer termostaten (hysterese ±0,3 °C); `aapen` = vindu åpent. */
  steg(ms, settpunkt, vaer, aapen = false) {
    const s = this.sann;
    if (this.T < settpunkt - 0.3) this.paa = true;
    else if (this.T > settpunkt + 0.3) this.paa = false;
    const u = this.paa ? 1 : 0;
    const dt = 1 / 60;
    this.ueff = s.treghet > 0 ? u + (this.ueff - u) * Math.exp(-dt / s.treghet) : u;
    const sol = solmot(ms, LAT, LON, vaer.sky);
    const diff = this.T - vaer.ute;
    const dT = s.r * this.ueff - (s.k + s.kv * vaer.vind + (aapen ? s.d : 0)) * diff
      + s.sol.ost * sol.ost + s.sol.sor * sol.sor + s.sol.vest * sol.vest + s.g;
    this.T += dT * dt;
    this.kwh += u * s.effektKw * dt;
    return { u, effektW: u * s.effektKw * 1000, sol };
  }

  /** Det termostaten melder: avrundet, med litt støy før avrundingen. */
  maalt() {
    const stoy = (this.tilfeldig() - 0.5) * 2 * this.stoy;
    return Math.round((this.T + stoy) / this.opplosning) * this.opplosning;
  }
}

module.exports = { Simrom, slump, MIN, LAT, LON };
