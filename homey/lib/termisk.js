'use strict';

/**
 * Den termiske regningen planleggeren bruker: hvor fort et rom varmes og kjøles.
 *
 *   dT/dt = r·u + gevinst − k·(T − ute)
 *
 * r er oppvarmingsevnen (°C/t ved fullt pådrag), k varmetapet per time og grad, og
 * gevinsten er gratisvarme (sol, folk, apparater). k og gevinsten kan variere fra time til
 * time med vind og sol; de sendes da inn som `vilkaar`. Tallene læres i rommodell.js.
 */

const STANDARD = { k: 0.08, r: 2.8 };

const tapet = (modell, vilkaar) => Math.max(0.005, vilkaar && Number.isFinite(vilkaar.k) ? vilkaar.k : modell.k);
const gratis = (vilkaar) => (vilkaar && Number.isFinite(vilkaar.gevinst) ? vilkaar.gevinst : 0);

/** Temperaturen etter `timer` med pådrag u (0–1). Eksakt løsning av modellen. */
function simuler(T, ute, u, modell, timer = 1, vilkaar = null) {
  const k = tapet(modell, vilkaar);
  const likevekt = ute + (modell.r * u + gratis(vilkaar)) / k;
  return likevekt + (T - likevekt) * Math.exp(-k * timer);
}

/**
 * Som `simuler`, for trege anlegg: varmen som faktisk når rommet (ueff) henger etter
 * pådraget med tidskonstanten `treghet` (timer). Returnerer {T, ueff} etter `timer`.
 */
function simulerTreg(T, ute, u, ueff, modell, timer = 1, vilkaar = null) {
  const tau = Number(modell.treghet) || 0;
  if (tau <= 0) return { T: simuler(T, ute, u, modell, timer, vilkaar), ueff: u };
  const k = tapet(modell, vilkaar);
  const likevekt = ute + (modell.r * u + gratis(vilkaar)) / k;
  const a = Math.exp(-timer / tau);
  const b = Math.exp(-k * timer);
  // Bidraget fra at ueff ennå ikke har nådd u: r·(ueff − u)·∫ e^(−s/τ)·e^(−k(t−s)) ds
  const hale = Math.abs(k - 1 / tau) < 1e-9 ? timer * b : (a - b) / (k - 1 / tau);
  return { T: likevekt + (T - likevekt) * b + modell.r * (ueff - u) * hale, ueff: u + (ueff - u) * a };
}

/** Pådraget (0–1) som holder rommet på T. Over 1 betyr at ovnen ikke klarer det i dette været. */
function holdepaadrag(T, ute, modell, vilkaar = null) {
  return Math.max(0, (tapet(modell, vilkaar) * (T - ute) - gratis(vilkaar)) / modell.r);
}

/**
 * Minutter fra `fra` til `til` ved full effekt, eller null når rommet ikke når målet i dette været.
 * t = ln((R − k·(fra − ute)) / (R − k·(til − ute))) / k, der R = r + gevinst.
 * Trege anlegg (gulvvarme) får tregheten lagt til: varmen kommer ikke med en gang.
 */
function forvarmingMinutter(modell, fra, til, ute, vilkaar = null) {
  if (til <= fra) return 0;
  const k = tapet(modell, vilkaar);
  const R = modell.r + gratis(vilkaar);
  const tapTil = k * (til - ute);
  if (R <= tapTil + 1e-6) return null;
  const tapFra = k * (fra - ute);
  const min = (Math.log(Math.max(R - tapFra, 1e-6) / (R - tapTil)) / k) * 60;
  return Math.max(0, min) + (Number(modell.treghet) || 0) * 60;
}

module.exports = { STANDARD, simuler, simulerTreg, holdepaadrag, forvarmingMinutter };
