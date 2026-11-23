'use strict';

/**
 * Komfortkravet for et rom på et tidspunkt: hvor varmt det minst skal være, og hvorfor.
 *
 * Dette er «programmet» — det brukeren har bedt om. Varmeplanen og effektmotoren får
 * bevege seg rundt det, men aldri under det uten at timebudsjettet tvinger dem.
 *
 * Profiler (som i Home Assistant-versjonen):
 *   fellesrom  dag/natt etter klokka
 *   konstant   samme temperatur hele døgnet (bad)
 *   sjelden    to grader under dagtemperaturen om natten, ellers dag (do, vaskegang)
 * Personprofiler, helg og hjemkomst kommer i trinn 3.
 */

const { osloDeler } = require('./kalender');

const PROFILER = ['fellesrom', 'konstant', 'sjelden'];

/** «HH:MM» → minutter siden midnatt. */
function minutter(tekst, standard) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(tekst || ''));
  if (!m) return standard;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

/** Er `naa` mellom start og slutt (minutter siden midnatt)? Tåler at perioden krysser midnatt. */
const mellom = (start, slutt, naa) => (start <= slutt ? naa >= start && naa < slutt : naa >= start || naa < slutt);

function erDag(ms, innst) {
  const d = osloDeler(ms);
  return mellom(minutter(innst.dagStart, 6 * 60), minutter(innst.nattStart, 23 * 60), d.time * 60 + d.minutt);
}

/**
 * @param {object} sone {dag, natt, profil}
 * @param {number} ms tidspunktet
 * @param {object} innst {dagStart, nattStart}
 * @param {object|null} overstyring {temp, tilMs}
 * @returns {{min: number, grunn: string, fast: boolean}} `fast` = planen skal ikke forvarme over kravet
 */
function kravVed(sone, ms, innst, overstyring = null) {
  if (overstyring && ms < overstyring.tilMs) {
    const d = osloDeler(overstyring.tilMs);
    return { min: Number(overstyring.temp), grunn: `Manuell overstyring til kl. ${String(d.time).padStart(2, '0')}:${String(d.minutt).padStart(2, '0')}`, fast: true };
  }
  const dag = Number.isFinite(Number(sone.dag)) ? Number(sone.dag) : 21;
  const natt = Number.isFinite(Number(sone.natt)) ? Number(sone.natt) : dag - 2;
  if (sone.profil === 'konstant') return { min: dag, grunn: 'Holdes varmt hele døgnet', fast: false };
  if (erDag(ms, innst)) return { min: dag, grunn: 'Dag', fast: false };
  if (sone.profil === 'sjelden') return { min: dag - 2, grunn: 'Sjelden brukt — senket om natten', fast: false };
  return { min: natt, grunn: 'Natt', fast: false };
}

module.exports = { PROFILER, minutter, mellom, erDag, kravVed };
