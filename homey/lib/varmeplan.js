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

const { simuler, simulerTreg, holdepaadrag } = require('./termisk');

const STEG = 0.25;
const PAADRAG = [0, 0.25, 0.5, 0.75, 1];
const STRAFF_KR_PER_GRAD_TIME = 5;      // langt over enhver strømpris: komforten brytes bare når ovnen ikke rekker

/**
 * @param {object} p
 * @param {number} p.start       romtemperaturen nå
 * @param {{k: number, r: number}} p.modell
 * @param {number} p.effektKw    ovnens effekt ved fullt pådrag
 * @param {Array<{ute: number, pris: number, min: number, maks: number, vilkaar?: {k: number, gevinst: number}}>} p.timer
 *   pris i kr/kWh; `vilkaar` er timens varmetap og gratisvarme (vind og sol), ellers modellens egne
 * @param {number} [p.ueff]     trege anlegg: hvor mye av pådraget som alt når rommet (0–1)
 * @returns {{timer: Array, kostnad: number, referanse: number, spart: number}}
 */
function planlegg({ start, modell, effektKw, timer, ueff = 0 }) {
  const n = timer.length;
  if (!n) return { timer: [], kostnad: 0, referanse: 0, spart: 0 };
  const lav = Math.min(start, ...timer.map((t) => t.min)) - 3;
  const hoy = Math.max(start, ...timer.map((t) => t.maks)) + 1;
  const antall = Math.round((hoy - lav) / STEG) + 1;
  const temp = (i) => lav + i * STEG;
  const snittpris = timer.reduce((s, t) => s + (t.grunnpris ?? t.pris), 0) / n;
  const kwhPerGrad = effektKw / Math.max(modell.r, 0.05);
  // Trege anlegg (gulvvarme): varmen som når rommet henger etter pådraget. Da er «hvor varmt
  // gulvet alt er» en del av tilstanden, ellers ville planen startet for sent hver morgen.
  const treg = (Number(modell.treghet) || 0) > 0;
  const nivaaer = treg ? PAADRAG.length : 1;
  const steg = (T, ue, u, t) => (treg ? simulerTreg(T, t.ute, u, ue, modell, 1, t.vilkaar) : { T: simuler(T, t.ute, u, modell, 1, t.vilkaar), ueff: u });
  const plass = (i, j) => i * nivaaer + j;

  // Verdien av en tilstand mellom rutepunktene: lineær interpolasjon i temperatur og treghet.
  // Avrunding til nærmeste punkt ville «spist» små endringer — et tregt rom som stiger 0,1 °C
  // i timen ville sett ut til å stå stille, og planen ville trodd at ovnen ikke strekker til.
  const verdiVed = (tabell, T, ue) => {
    const x = Math.min(antall - 1, Math.max(0, (T - lav) / STEG));
    const i0 = Math.min(antall - 2, Math.floor(x));
    const fx = antall > 1 ? x - i0 : 0;
    if (!treg) return tabell[plass(i0, 0)] * (1 - fx) + tabell[plass(Math.min(antall - 1, i0 + 1), 0)] * fx;
    const y = Math.min(nivaaer - 1, Math.max(0, ue * (nivaaer - 1)));
    const j0 = Math.min(nivaaer - 2, Math.floor(y));
    const fy = y - j0;
    const i1 = Math.min(antall - 1, i0 + 1);
    return (tabell[plass(i0, j0)] * (1 - fx) + tabell[plass(i1, j0)] * fx) * (1 - fy)
      + (tabell[plass(i0, j0 + 1)] * (1 - fx) + tabell[plass(i1, j0 + 1)] * fx) * fy;
  };
  /** Beste pådrag fra en tilstand i time h, gitt verdien av det som kommer etter. */
  const velg = (T, ue, t, etterpaa) => {
    let lavest = Infinity;
    let best = 0;
    for (let a = 0; a < PAADRAG.length; a++) {
      const u = PAADRAG[a];
      const etter = steg(T, ue, u, t);
      if (etter.T > t.maks + 1e-9 && u > 0) continue;            // ikke varm over båndet
      const under = Math.max(0, t.min - etter.T);
      const kost = u * effektKw * t.pris + under * STRAFF_KR_PER_GRAD_TIME + verdiVed(etterpaa, etter.T, etter.ueff);
      if (kost < lavest - 1e-12) { lavest = kost; best = a; }
    }
    return { kost: lavest, a: best };
  };

  // Sluttverdi: varme som står igjen i rommet er verdt noe, ellers ville planen latt rommet
  // falle mot slutten av horisonten. Under kravet straffes det.
  const siste = timer[n - 1];
  const verdier = new Array(n + 1);
  verdier[n] = new Float64Array(antall * nivaaer);
  for (let i = 0; i < antall; i++) {
    const over = temp(i) - siste.min;
    const verdi = over >= 0 ? -over * kwhPerGrad * snittpris * 0.8 : -over * STRAFF_KR_PER_GRAD_TIME * 4;
    for (let j = 0; j < nivaaer; j++) verdier[n][plass(i, j)] = verdi;
  }
  for (let h = n - 1; h >= 0; h--) {
    const verdi = new Float64Array(antall * nivaaer);
    for (let i = 0; i < antall; i++) {
      for (let j = 0; j < nivaaer; j++) verdi[plass(i, j)] = velg(temp(i), treg ? j / (nivaaer - 1) : 0, timer[h], verdier[h + 1]).kost;
    }
    verdier[h] = verdi;
  }

  // Framover: velg på nytt fra den faktiske tilstanden i hver time.
  const ut = [];
  let T = start;
  let ue = treg ? Math.min(1, Math.max(0, Number(ueff) || 0)) : 0;
  let kostnad = 0;
  for (let h = 0; h < n; h++) {
    const t = timer[h];
    const u = PAADRAG[velg(T, ue, t, verdier[h + 1]).a];
    const etter = steg(T, ue, u, t);
    const kwh = u * effektKw;
    kostnad += kwh * (t.grunnpris ?? t.pris);
    ut.push({ u, fra: T, til: etter.T, kwh, kostnad: kwh * (t.grunnpris ?? t.pris), min: t.min, maks: t.maks, pris: t.pris, ute: t.ute });
    T = etter.T;
    ue = etter.ueff;
  }

  // Referanse: en termostat som står på komforttemperaturen (høyeste krav i perioden) hele
  // tiden, uten senking og uten hensyn til pris. `spart` er hva planen sparer mot det.
  const komfort = Math.max(...timer.map((t) => t.min));
  let referanse = 0;
  for (const t of timer) referanse += Math.min(1, holdepaadrag(komfort, t.ute, modell, t.vilkaar)) * effektKw * (t.grunnpris ?? t.pris);

  return { timer: ut, kostnad, referanse, spart: referanse - kostnad };
}

/**
 * Settpunktet termostaten skal ha nå, fra planens første time: dit planen vil ha rommet
 * ved timens slutt, aldri under komfortkravet og aldri over båndet. Avrundet til halve grader.
 */
function settpunktNaa(plan) {
  const forste = plan.timer[0];
  if (!forste) return null;
  let mal = forste.min;
  if (forste.u > 0) {
    // Planen vil varme. Settpunktet må da ligge over der rommet er nå, ellers slår termostaten
    // av — også når modellen (feilaktig) tror at rommet faller selv med ovnen på.
    mal = Math.max(forste.min, forste.til, forste.fra + (forste.u >= 1 ? 0.5 : 0));
  }
  return Math.round(Math.min(Math.max(forste.maks, forste.min), Math.max(forste.min, mal)) * 2) / 2;
}

module.exports = { planlegg, settpunktNaa, STEG, PAADRAG };
