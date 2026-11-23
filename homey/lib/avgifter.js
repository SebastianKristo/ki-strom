'use strict';

/**
 * Offentlige satser: forbruksavgift, Enova, mva, strømstøtte og Norgespris.
 *
 * Satsene og reglene er de samme som i Strømkalkulator (fredrik-lindseth/Stromkalkulator,
 * const.py). Alle priser i formlene er inkl. mva; spotpris kommer eks. mva og normaliseres
 * før den brukes.
 */

const SATSER_GJELDER_AAR = 2026;

const AVGIFTSSONE = { STANDARD: 'standard', NORD_NORGE: 'nord_norge', TILTAKSSONE: 'tiltakssone' };
const BOLIGTYPE = { BOLIG: 'bolig', FRITIDSBOLIG: 'fritidsbolig', FRITIDSBOLIG_FAST: 'fritidsbolig_fast' };

const FORBRUKSAVGIFT = 0.0713;       // kr/kWh eks. mva (2026, flat hele året)
const ENOVA_AVGIFT = 0.01;           // kr/kWh eks. mva, alle soner
const MVA_SATS = 0.25;

const STROMSTOTTE_TERSKEL_EKS_MVA = 0.77;   // 77 øre/kWh eks. mva (2026)
const STROMSTOTTE_RATE = 0.9;               // 90 % av det som er over terskelen
const STROMSTOTTE_MAKS_KWH = 5000;          // per målepunkt per måned

const NORGESPRIS_STANDARD = 0.5;            // 40 øre + 25 % mva
const NORGESPRIS_NORD = 0.4;                // mva-fritak
const NORGESPRIS_MAKS_KWH_BOLIG = 5000;
const NORGESPRIS_MAKS_KWH_FRITID = 1000;

const mvaSats = (sone) => (sone === AVGIFTSSONE.NORD_NORGE || sone === AVGIFTSSONE.TILTAKSSONE ? 0 : MVA_SATS);
const forbruksavgift = (sone) => (sone === AVGIFTSSONE.TILTAKSSONE ? 0 : FORBRUKSAVGIFT);

/** Offentlige avgifter per kWh inkl. mva (forbruksavgift + Enova). */
const avgifterInklMva = (sone) => (forbruksavgift(sone) + ENOVA_AVGIFT) * (1 + mvaSats(sone));

/** Energiledd inkl. forbruksavgift, Enova og mva, fra nettselskapets rene sats eks. mva. */
const energileddInklMva = (eksMva, sone) => (eksMva + forbruksavgift(sone) + ENOVA_AVGIFT) * (1 + mvaSats(sone));

/** Terskelen sammenlignes med spotpris inkl. mva der mva betales. */
const stromstotteTerskel = (sone) => STROMSTOTTE_TERSKEL_EKS_MVA * (1 + mvaSats(sone));

/** Ren fritidsbolig har ikke rett på strømstøtte. */
const stromstotteMaksKwh = (boligtype) => (boligtype === BOLIGTYPE.FRITIDSBOLIG ? 0 : STROMSTOTTE_MAKS_KWH);

const norgesprisInklMva = (sone) => (mvaSats(sone) === 0 ? NORGESPRIS_NORD : NORGESPRIS_STANDARD);

const norgesprisMaksKwh = (boligtype) => (boligtype === BOLIGTYPE.FRITIDSBOLIG ? NORGESPRIS_MAKS_KWH_FRITID : NORGESPRIS_MAKS_KWH_BOLIG);

/** Strømstøtte i kr/kWh for en timepris inkl. mva. */
const stromstottePerKwh = (spotInklMva, terskel) => (spotInklMva <= terskel ? 0 : (spotInklMva - terskel) * STROMSTOTTE_RATE);

/** NO4 er Nord-Norge (mva-fritak) som standard; nettselskapet kan overstyre. */
function avgiftssoneFor(dso) {
  if (dso.tiltakssone) return AVGIFTSSONE.TILTAKSSONE;
  if (dso.avgiftssone) return dso.avgiftssone;
  return dso.prisomrade === 'NO4' ? AVGIFTSSONE.NORD_NORGE : AVGIFTSSONE.STANDARD;
}

module.exports = {
  SATSER_GJELDER_AAR, AVGIFTSSONE, BOLIGTYPE,
  FORBRUKSAVGIFT, ENOVA_AVGIFT, MVA_SATS, STROMSTOTTE_RATE,
  mvaSats, forbruksavgift, avgifterInklMva, energileddInklMva,
  stromstotteTerskel, stromstotteMaksKwh, norgesprisInklMva, norgesprisMaksKwh,
  stromstottePerKwh, avgiftssoneFor,
};
