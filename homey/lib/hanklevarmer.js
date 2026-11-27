'use strict';

/**
 * Håndklevarmer: på i et morgen- og et kveldsvindu, av når huset står tomt.
 *
 * Den slås av og på ved skiftene — når et vindu åpner eller stenger, og når bortemodus slår
 * inn eller ut — ikke fortløpende. Det gir ett tydelig skifte hver gang, og det du selv slår
 * av eller på i mellomtiden får stå til neste skifte.
 *
 * Timebudsjettet får ikke styre den: 100 W monner ikke, og en trang time ville bare fått
 * den til å slå seg av og på.
 */

const { osloDeler } = require('./kalender');
const { minutter, mellom } = require('./program');

const STANDARD = {
  bryter: null,                    // {enhet, kap}
  styr: true,
  morgenStart: '06:00',
  morgenSlutt: '08:00',
  kveldStart: '19:00',
  kveldSlutt: '22:00',
  nominellKw: 0.1,
};

/** @returns {{paa: boolean, grunn: string}} */
function skalPaa(ms, innst, kontekst = {}) {
  const i = { ...STANDARD, ...(innst || {}) };
  if (kontekst.borte) return { paa: false, grunn: 'Bortemodus' };
  const d = osloDeler(ms);
  const naa = d.time * 60 + d.minutt;
  const morgen = mellom(minutter(i.morgenStart, 360), minutter(i.morgenSlutt, 480), naa);
  const kveld = mellom(minutter(i.kveldStart, 1140), minutter(i.kveldSlutt, 1320), naa);
  if (!morgen && !kveld) return { paa: false, grunn: 'Utenfor morgen- og kveldsvinduet' };
  return { paa: true, grunn: morgen ? `Morgen til kl. ${i.morgenSlutt}` : `Kveld til kl. ${i.kveldSlutt}` };
}

const SKIFTE_MS = 15 * 60000;

/**
 * Skal releet skrives nå? Returnerer true/false for å slå på/av, eller null for å la det stå.
 *
 * Ved et skifte i det ønskede (og ved første kjøring) settes releet, og det følges opp i et
 * kvarter i tilfelle det ikke svarte med en gang. Etter det røres det ikke før neste skifte.
 *
 * @param {object} tilstand lagret: {onsket, sidenMs}
 * @param {boolean|null} erPaa det releet melder nå (null = svarer ikke)
 */
function skriv(tilstand, ms, onsket, erPaa) {
  if (tilstand.onsket !== onsket) {
    tilstand.onsket = onsket;
    tilstand.sidenMs = ms;
  }
  if (erPaa === null || erPaa === onsket) return null;
  return ms - tilstand.sidenMs < SKIFTE_MS ? onsket : null;
}

module.exports = { STANDARD, skalPaa, skriv, SKIFTE_MS };
