'use strict';

/**
 * Komfortkravet for et rom på et tidspunkt: hvor varmt det minst skal være, og hvorfor.
 *
 * Dette er «programmet» — det brukeren har bedt om. Varmeplanen og effektmotoren får
 * bevege seg rundt det, men aldri under det uten at timebudsjettet tvinger dem.
 *
 * Profiler (som i Home Assistant-versjonen):
 *   fellesrom      dag/natt etter klokka
 *   konstant       samme temperatur hele døgnet (bad)
 *   sjelden        to grader under dagtemperaturen om natten, ellers dag (do, vaskegang)
 *   person:<key>   følger personen: barn (fast opp/legg, borte på dagtid), ungdom
 *                  (egen leggetid, vekking hverdag og helg) eller voksen
 *
 * Bortemodus og hjemkomst kommer inn gjennom `kontekst` og går foran profilen: tomt hus
 * holder bortetemperaturen, og fra planlagt hjemkomst gjelder dagtemperaturen. Fordi
 * kravet stiger på et kjent tidspunkt, starter varmeplanen oppvarmingen i tide av seg selv.
 */

const { osloDeler } = require('./kalender');

const PROFILER = ['fellesrom', 'konstant', 'sjelden'];
const TIME_MS = 3600000;

/** «HH:MM» → minutter siden midnatt. */
function minutter(tekst, standard) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(tekst || ''));
  if (!m) return standard;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

const klokke = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Er `naa` mellom start og slutt (minutter siden midnatt)? Tåler at perioden krysser midnatt. */
const mellom = (start, slutt, naa) => (start <= slutt ? naa >= start && naa < slutt : naa >= start || naa < slutt);

function erDag(ms, innst) {
  const d = osloDeler(ms);
  return mellom(minutter(innst.dagStart, 6 * 60), minutter(innst.nattStart, 23 * 60), d.time * 60 + d.minutt);
}

/** Fast bortetemperatur når rommet ikke er lært: etter varmekilde og program. */
function fastBortetemp(sone, innst) {
  if (sone.profil === 'konstant') return Number(innst.borteTempBad ?? 22);
  if (sone.type === 'gulv' || sone.type === 'vannbaaren') return Number(innst.borteTempGulv ?? 18);
  return Number(innst.borteTempPanel ?? 16);
}

/** Kravet for et rom som følger en person. `p` er personen med tider og om hen er hjemme nå. */
function personkrav(p, dag, natt, ms, naaMs) {
  const d = osloDeler(ms);
  const naa = d.time * 60 + d.minutt;
  // Tilstedeværelsen er bare kjent for øyeblikket; lenger fram gjelder klokka.
  const hjemmeNaa = Math.abs(ms - naaMs) < TIME_MS ? p.hjemme : null;
  if (p.type === 'barn') {
    const legg = minutter(p.natt, 19 * 60);
    const vekk = minutter(p.dag, 5 * 60 + 30);
    if (mellom(legg, vekk, naa)) return { min: natt, grunn: `${p.navn} sover` };
    const borte = hjemmeNaa === null
      ? d.ukedag < 5 && mellom(minutter(p.borteFra, 8 * 60), minutter(p.borteTil, 15 * 60), naa)
      : !hjemmeNaa;
    if (borte) return { min: dag - 2, grunn: `${p.navn} er borte på dagtid` };
    return { min: dag, grunn: `${p.navn} er hjemme` };
  }
  if (p.type === 'ungdom') {
    const legg = minutter(p.natt, 23 * 60);
    // Vekkingen avgjøres av morgenen som kommer: fredag kveld er lørdag morgen.
    const morgen = osloDeler(naa >= legg ? ms + 12 * TIME_MS : ms);
    const helg = morgen.ukedag >= 5 || Boolean(p.ferie);
    const vekk = minutter(helg ? p.vekkingHelg : p.vekking, helg ? 9 * 60 + 30 : 7 * 60);
    if (mellom(legg, vekk, naa)) return { min: natt, grunn: `${p.navn} sover (vekking kl. ${klokke(vekk)})` };
    return { min: dag, grunn: `${p.navn} — rommet brukes på dagtid` };
  }
  return null;      // voksen: som fellesrom, se under
}

/**
 * @param {object} sone {dag, natt, profil, type}
 * @param {number} ms tidspunktet
 * @param {object} innst {dagStart, nattStart, borteTemp*}
 * @param {object|null} overstyring {temp, tilMs}
 * @param {object} kontekst {naaMs, borte, hjemkomstMs, bortetemp, personer: {key: {...}}}
 * @returns {{min: number, grunn: string, fast: boolean}} `fast` = planen skal ikke forvarme over kravet
 */
function kravVed(sone, ms, innst, overstyring = null, kontekst = {}) {
  if (overstyring && ms < overstyring.tilMs) {
    const d = osloDeler(overstyring.tilMs);
    return { min: Number(overstyring.temp), grunn: `Manuell overstyring til kl. ${klokke(d.time * 60 + d.minutt)}`, fast: true };
  }
  const dag = Number.isFinite(Number(sone.dag)) ? Number(sone.dag) : 21;
  const natt = Number.isFinite(Number(sone.natt)) ? Number(sone.natt) : dag - 2;
  const naaMs = kontekst.naaMs ?? ms;

  if (kontekst.borte) {
    if (kontekst.hjemkomstMs !== null && kontekst.hjemkomstMs !== undefined && ms >= kontekst.hjemkomstMs) {
      const d = osloDeler(kontekst.hjemkomstMs);
      return { min: dag, grunn: `Hjemkomst kl. ${klokke(d.time * 60 + d.minutt)} — dagtemperatur`, fast: false };
    }
    const auto = kontekst.bortetemp;
    if (auto !== null && auto !== undefined) return { min: Math.min(auto, dag), grunn: 'Bortemodus — laveste temperatur rommet rekker å varme seg opp fra', fast: false };
    return { min: Math.min(fastBortetemp(sone, innst), dag), grunn: 'Bortemodus', fast: false };
  }

  const personnokkel = String(sone.profil || '').startsWith('person:') ? sone.profil.slice(7) : null;
  const person = personnokkel ? (kontekst.personer || {})[personnokkel] : null;
  if (person) {
    const krav = personkrav(person, dag, natt, ms, naaMs);
    if (krav) return { ...krav, fast: false };
    if (person.hjemme === false && Math.abs(ms - naaMs) < TIME_MS && erDag(ms, innst)) {
      return { min: dag - 2, grunn: `${person.navn} er borte`, fast: false };
    }
  }
  if (sone.profil === 'konstant') return { min: dag, grunn: 'Holdes varmt hele døgnet', fast: false };
  if (erDag(ms, innst)) return { min: dag, grunn: 'Dag', fast: false };
  if (sone.profil === 'sjelden') return { min: dag - 2, grunn: 'Sjelden brukt — senket om natten', fast: false };
  return { min: natt, grunn: 'Natt', fast: false };
}

module.exports = { PROFILER, minutter, klokke, mellom, erDag, fastBortetemp, kravVed };
