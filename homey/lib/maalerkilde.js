'use strict';

/**
 * Hvor forbruket skal regnes fra: målerens kWh-register, eller effekten summert over tid.
 *
 * Registeret er best — det er det samme tallet som fakturaen bygger på. Men et register som
 * står stille mens huset åpenbart bruker strøm, er ikke til å stole på: feil register valgt
 * (eksport i stedet for import), en måler som har sluttet å melde det, eller en kobling som
 * har falt ut. Da regnes det fra effekten til registeret rører seg igjen, i stedet for å
 * vise null forbruk i dagevis.
 */

const STILLE_MS = 2 * 3600000;      // så lenge får registeret stå stille før vi slutter å tro på det
const MIN_EFFEKT_W = 150;           // … mens huset bruker minst så mye

/**
 * @param {object} p
 * @param {boolean} p.harRegister  et kWh-register er valgt
 * @param {number|null} p.energi   siste registerverdi
 * @param {number|null} p.energiEndretMs  når registeret sist endret verdi (eller først ble lest)
 * @param {number|null} p.effekt   siste effekt (W)
 * @param {number} p.naa
 * @returns {{kilde: 'register'|'effekt'|'ingen', stille: boolean}}
 */
function velgKilde({ harRegister, energi, energiEndretMs, effekt, naa }) {
  const harEffekt = Number.isFinite(effekt);
  if (!harRegister || !Number.isFinite(energi)) return { kilde: harEffekt ? 'effekt' : 'ingen', stille: false };
  const stille = harEffekt && effekt > MIN_EFFEKT_W && Number.isFinite(energiEndretMs) && naa - energiEndretMs > STILLE_MS;
  return { kilde: stille ? 'effekt' : 'register', stille };
}

/** Rangering av registre når brukeren ikke har valgt: importert energi først, aldri eksport hvis noe annet finnes. */
function rangerRegister(id) {
  const navn = String(id).toLowerCase();
  if (/export|eksport|produ|return|injected|out\b/.test(navn)) return 9;
  if (/import/.test(navn)) return 0;
  if (navn === 'meter_power') return 1;
  if (/peak|tariff|t[12]\b|l[123]\b|phase/.test(navn)) return 5;
  return 3;
}

module.exports = { velgKilde, rangerRegister, STILLE_MS, MIN_EFFEKT_W };
