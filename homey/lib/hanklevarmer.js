'use strict';

/**
 * Håndklevarmer: på i et morgen- og et kveldsvindu, av når huset står tomt.
 * En trang time utsetter påslaget — håndklærne tåler å vente til neste tick.
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
  if (kontekst.trangt) return { paa: false, grunn: 'I vinduet, men timen er for trang akkurat nå' };
  return { paa: true, grunn: morgen ? `Morgen til kl. ${i.morgenSlutt}` : `Kveld til kl. ${i.kveldSlutt}` };
}

module.exports = { STANDARD, skalPaa };
