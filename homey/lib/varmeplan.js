'use strict';

/**
 * Prisoptimal varmeplan for ett rom.
 *
 * Gitt rommets termiske modell, utetemperaturen og strømprisen time for time, og et
 * komfortbånd [min, maks] per time, finner planen pådraget som holder rommet innenfor
 * båndet til lavest kostnad. Det gir tre ting av seg selv:
 *   - nattsenking bare når den lønner seg (tapet som uteblir mot prisen på å hente det igjen)
 *   - forvarming i billige timer før dyre, innenfor det båndet tillater
 *   - start av oppvarming i tide før komfortkravet stiger (morgen, hjemkomst)
 *
 * Løses med dynamisk programmering over temperatur i steg på 0,25 °C. Rommet er lite nok
 * til at hele planen (36 timer) regnes på noen millisekunder.
 */

const { simuler, holdepaadrag } = require('./termisk');

const STEG = 0.25;
const PAADRAG = [0, 0.25, 0.5, 0.75, 1];
const STRAFF_KR_PER_GRAD_TIME = 5;      // langt over enhver strømpris: komforten brytes bare når ovnen ikke rekker

/**
 * @param {object} p
 * @param {number} p.start       romtemperaturen nå
 * @param {{k: number, r: number}} p.modell
 * @param {number} p.effektKw    ovnens effekt ved fullt pådrag
 * @param {Array<{ute: number, pris: number, min: number, maks: number}>} p.timer  pris i kr/kWh
 * @returns {{timer: Array, kostnad: number, referanse: number, spart: number}}
 */
function planlegg({ start, modell, effektKw, timer }) {
  const n = timer.length;
  if (!n) return { timer: [], kostnad: 0, referanse: 0, spart: 0 };
  const lav = Math.min(start, ...timer.map((t) => t.min)) - 3;
  const hoy = Math.max(start, ...timer.map((t) => t.maks)) + 1;
  const antall = Math.round((hoy - lav) / STEG) + 1;
  const temp = (i) => lav + i * STEG;
  const indeks = (T) => Math.min(antall - 1, Math.max(0, Math.round((T - lav) / STEG)));
  const snittpris = timer.reduce((s, t) => s + t.pris, 0) / n;
  const kwhPerGrad = effektKw / Math.max(modell.r, 0.05);

  // Sluttverdi: varme som står igjen i rommet er verdt noe, ellers ville planen latt rommet
  // falle mot slutten av horisonten. Under kravet straffes det.
  const siste = timer[n - 1];
  let neste = new Float64Array(antall);
  for (let i = 0; i < antall; i++) {
    const over = temp(i) - siste.min;
    neste[i] = over >= 0 ? -over * kwhPerGrad * snittpris * 0.8 : -over * STRAFF_KR_PER_GRAD_TIME * 4;
  }
  const valg = [];
  for (let h = n - 1; h >= 0; h--) {
    const t = timer[h];
    const verdi = new Float64Array(antall);
    const beste = new Uint8Array(antall);
    for (let i = 0; i < antall; i++) {
      let lavest = Infinity;
      for (let a = 0; a < PAADRAG.length; a++) {
        const u = PAADRAG[a];
        const T1 = simuler(temp(i), t.ute, u, modell);
        if (T1 > t.maks + 1e-9 && u > 0) continue;            // ikke varm over båndet
        const under = Math.max(0, t.min - T1);
        const kost = u * effektKw * t.pris + under * STRAFF_KR_PER_GRAD_TIME + neste[indeks(T1)];
        if (kost < lavest - 1e-12) { lavest = kost; beste[i] = a; }
      }
      verdi[i] = lavest;
    }
    valg[h] = beste;
    neste = verdi;
  }

  // Framover: følg valgene fra den faktiske starttemperaturen (uten avrunding til rutenettet underveis).
  const ut = [];
  let T = start;
  let kostnad = 0;
  for (let h = 0; h < n; h++) {
    const t = timer[h];
    const u = PAADRAG[valg[h][indeks(T)]];
    const T1 = simuler(T, t.ute, u, modell);
    const kwh = u * effektKw;
    kostnad += kwh * t.pris;
    ut.push({ u, fra: T, til: T1, kwh, kostnad: kwh * t.pris, min: t.min, maks: t.maks, pris: t.pris, ute: t.ute });
    T = T1;
  }

  // Referanse: en termostat som står på komforttemperaturen (høyeste krav i perioden) hele
  // tiden, uten senking og uten hensyn til pris. `spart` er hva planen sparer mot det.
  const komfort = Math.max(...timer.map((t) => t.min));
  let referanse = 0;
  for (const t of timer) referanse += Math.min(1, holdepaadrag(komfort, t.ute, modell)) * effektKw * t.pris;

  return { timer: ut, kostnad, referanse, spart: referanse - kostnad };
}

/**
 * Settpunktet termostaten skal ha nå, fra planens første time: dit planen vil ha rommet
 * ved timens slutt, aldri under komfortkravet og aldri over båndet. Avrundet til halve grader.
 */
function settpunktNaa(plan) {
  const forste = plan.timer[0];
  if (!forste) return null;
  const mal = forste.u > 0 ? Math.max(forste.min, forste.til) : forste.min;
  return Math.round(Math.min(forste.maks, Math.max(forste.min, mal)) * 2) / 2;
}

module.exports = { planlegg, settpunktNaa, STEG, PAADRAG };
