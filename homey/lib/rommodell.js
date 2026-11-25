'use strict';

/**
 * Rommodellen: lærer fysikken i hvert rom fra det som faktisk skjer.
 *
 *   dT/dt = r·u − (k + kv·vind)·(T − ute) + s_øst·sol_øst + s_sør·sol_sør + s_vest·sol_vest + g − d·åpen·(T − ute)
 *
 *   r    oppvarmingsevne: °C/t ved fullt pådrag (u = 1)
 *   k    varmetap: per time og grad forskjell til ute (1/k er rommets tidskonstant)
 *   kv   hvor mye vinden øker tapet (per m/s)
 *   s_*  hvor mye sola varmer, for sol fra øst, sør og vest — rommet lærer selv hvor vinduene står
 *   g    varme fra alt annet (folk, lys, apparater, naborom)
 *   d    ekstra tap når et vindu eller en dør mot ute står åpen
 *
 * Læringen er rekursiv minste kvadrater med glemsel: hver observasjon flytter anslagene litt,
 * gamle observasjoner teller gradvis mindre, og kovariansen sier hvor sikkert hvert tall er.
 *
 *   - Lærer raskt: alle vinduer brukes, også de der ovnen går av og på (u er snittpådraget).
 *   - Lærer av feil: bommer modellen mer enn den pleier, økes usikkerheten så den lærer om.
 *   - Tåler dårlige data: enkeltmålinger langt utenfor det vanlige får liten vekt.
 *   - Trege anlegg: flere utgaver av modellen med ulik treghet på pådraget går parallelt,
 *     og den som treffer best brukes (gulvvarme havner på timer, panelovner på null).
 *   - Usikkerheten brukes: planleggeren får en forsiktig utgave (litt svakere ovn, litt større
 *     tap), og marginen krymper etter hvert som modellen blir sikker.
 *
 * Termostater melder ofte i halve grader. Vinduene åpnes og lukkes derfor i det temperaturen
 * skifter verdi, så avrundingen ikke gir skjeve tall.
 */

const TIME_MS = 3600000;
const VERSJON = 2;
const TREGHETER = [0, 0.75, 2.5];           // timer: tidskonstanten på pådraget for hver kandidat
const N = 8;                                // r, k, kv, øst, sør, vest, g, d
const GLEMSEL = 0.995;                      // ~200 vinduer i minnet (omtrent en uke)
const VINDU_MIN_T = 0.5;
const VINDU_MAKS_T = 2;
const HULL_MS = 10 * 60000;                 // lengre opphold mellom målinger bryter vinduet

// Skalering: modellen regner med tall i samme størrelsesorden, og regnes om når den leses.
const SKALA = [1, 10, 100, 1, 1, 1, 1, 10];
const START = [2.8, 0.8, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0];      // skalert: r=2.8, k=0.08, d=0.3
const P0 = [4, 0.64, 0.25, 1, 1, 1, 0.09, 4];                // startusikkerhet (varians) per parameter
const NEDRE = [0.05, 0.03, 0, 0, 0, 0, -0.5, 0];
const OVRE = [15, 6, 3, 6, 6, 6, 1.5, 30];

const rund = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;
const klem = (v, a, b) => Math.min(b, Math.max(a, v));

function nyKandidat(start = START) {
  const P = new Array(N * N).fill(0);
  for (let i = 0; i < N; i++) P[i * N + i] = P0[i];
  return { th: [...start], P, mse: null, ueff: null };
}

function nyttRom(start) {
  return {
    v: VERSJON, kand: TREGHETER.map(() => nyKandidat(start)), best: 0,
    n: 0, nVarm: 0, nKald: 0, s2: null, feilKort: null, feilLang: null, sistOmlaert: 0, omlaeringer: 0,
    pmaks: null,
  };
}

/** Forklaringsvariablene for ett vindu (skalert). */
function trekk({ u, diff, vind, sol, aapen }) {
  return [u, -diff / 10, -(vind * diff) / 100, sol.ost, sol.sor, sol.vest, 1, -(aapen * diff) / 10];
}

class Rommodeller {
  /** @param {object} tilstand { rom: {key: {...}}, vindu: {key: {...}} } @param {object} gammel læringen fra før (k, rate_max) */
  constructor(tilstand = {}, gammel = null) {
    this.m = tilstand;
    this.m.rom = this.m.rom || {};
    this.m.vindu = this.m.vindu || {};
    this.gammel = (gammel && gammel.soner) || {};
  }

  _rom(key) {
    let rom = this.m.rom[key];
    if (!rom || rom.v !== VERSJON) {
      // Det forrige læringssystemet visste noe om rommet: bruk det som utgangspunkt.
      const g = this.gammel[key];
      const start = [...START];
      if (g && Number.isFinite(g.k)) start[1] = klem(g.k * 10, NEDRE[1], OVRE[1]);
      if (g && Number.isFinite(g.rate_max)) start[0] = klem(g.rate_max, NEDRE[0], OVRE[0]);
      rom = nyttRom(start);
      this.m.rom[key] = rom;
    }
    return rom;
  }

  glem(key = null) {
    if (key) { delete this.m.rom[key]; delete this.m.vindu[key]; } else { this.m.rom = {}; this.m.vindu = {}; }
  }

  // ------------------------------------------------------------------
  //  Observasjon
  // ------------------------------------------------------------------
  /**
   * Én måling (kalles hvert minutt).
   * @param {string} key
   * @param {object} o {ms, temp, ute, u, vind, sol: {ost, sor, vest}, aapen, effektKw}
   *   u er pådraget 0–1, eller null når det er ukjent (da læres ingenting).
   * @returns {boolean} true hvis et vindu ble lukket og modellen oppdatert
   */
  observer(key, o) {
    const { ms, temp, ute } = o;
    if (!Number.isFinite(temp) || !Number.isFinite(ute)) { delete this.m.vindu[key]; return false; }
    const rom = this._rom(key);
    if (Number.isFinite(o.effektKw) && o.effektKw > 0.1) {
      // Ovnens virkelige effekt: det høyeste den trekker, med langsom glemsel.
      rom.pmaks = rund(rom.pmaks === null ? o.effektKw : Math.max(o.effektKw, rom.pmaks * 0.9995 + o.effektKw * 0.0005), 3);
    }
    const u = o.u === null || o.u === undefined || !Number.isFinite(o.u) ? null : klem(o.u, 0, 1.25);
    const naa = {
      u, diff: temp - ute, vind: Number.isFinite(o.vind) ? Math.max(0, o.vind) : 0,
      sol: o.sol || { ost: 0, sor: 0, vest: 0 }, aapen: o.aapen ? 1 : 0,
    };
    let w = this.m.vindu[key];
    if (u === null) { delete this.m.vindu[key]; return false; }
    if (!w || ms <= w.sistMs || ms - w.sistMs > HULL_MS) {
      for (const k of rom.kand) k.ueff = u;
      this.m.vindu[key] = this._nyttVindu(ms, temp, naa, false);
      return false;
    }
    // Det som gjaldt siden forrige måling, regnes inn for tiden som har gått.
    const dt = (ms - w.sistMs) / TIME_MS;
    const f = w.forrige;
    w.sum.diff += f.diff * dt;
    w.sum.vd += f.vind * f.diff * dt;
    w.sum.ost += f.sol.ost * dt; w.sum.sor += f.sol.sor * dt; w.sum.vest += f.sol.vest * dt;
    w.sum.ad += f.aapen * f.diff * dt;
    rom.kand.forEach((k, n) => {
      const tau = TREGHETER[n];
      if (k.ueff === null) k.ueff = f.u;
      // Snittet av det trege pådraget over steget (eksakt for førsteordens treghet).
      if (tau > 0) {
        const a = Math.exp(-dt / tau);
        w.sum.u[n] += f.u * dt + (k.ueff - f.u) * tau * (1 - a);
        k.ueff = f.u + (k.ueff - f.u) * a;
      } else {
        w.sum.u[n] += f.u * dt;
        k.ueff = f.u;
      }
    });
    w.sistMs = ms;
    w.forrige = naa;
    const endret = temp !== w.sistT;
    // I det termostaten skifter verdi, ligger den virkelige temperaturen midt mellom de to:
    // det er det eneste øyeblikket avrundingen ikke skjuler noe.
    const kantT = endret ? (w.sistT + temp) / 2 : temp;
    w.sistT = temp;
    const timer = (ms - w.ms0) / TIME_MS;
    if (!w.kant && endret && timer < VINDU_MIN_T) {
      // Første temperaturskifte: herfra er start­temperaturen nøyaktig.
      this.m.vindu[key] = this._nyttVindu(ms, temp, naa, true, kantT);
      return false;
    }
    if (!((timer >= VINDU_MIN_T && endret) || timer >= VINDU_MAKS_T)) return false;
    const brukbar = w.kant || timer >= 1.5;
    this.m.vindu[key] = this._nyttVindu(ms, temp, naa, endret, kantT);
    if (!brukbar) return false;
    const y = (kantT - w.t0) / timer;
    const felles = { diff: w.sum.diff / timer, vd: w.sum.vd / timer, sol: { ost: w.sum.ost / timer, sor: w.sum.sor / timer, vest: w.sum.vest / timer }, ad: w.sum.ad / timer };
    this._laer(rom, y, felles, w.sum.u.map((s) => s / timer));
    return true;
  }

  _nyttVindu(ms, temp, naa, kant, t0 = temp) {
    return { ms0: ms, t0, sistMs: ms, sistT: temp, kant, forrige: naa, sum: { diff: 0, vd: 0, ost: 0, sor: 0, vest: 0, ad: 0, u: TREGHETER.map(() => 0) } };
  }

  /** Oppdater alle kandidatene med ett vindu. */
  _laer(rom, y, f, uSnitt) {
    const sigma = Math.sqrt(rom.s2 ?? 0.25);
    let feilBest = null;
    rom.kand.forEach((k, n) => {
      const x = [uSnitt[n], -f.diff / 10, -f.vd / 100, f.sol.ost, f.sol.sor, f.sol.vest, 1, -f.ad / 10];
      let e = y;
      for (let i = 0; i < N; i++) e -= k.th[i] * x[i];
      if (n === rom.best) feilBest = e;
      k.mse = k.mse === null ? e * e : k.mse * 0.93 + e * e * 0.07;
      // Robust: en måling langt utenfor det vanlige får redusert vekt.
      const grense = 3 * Math.max(sigma, 0.2);
      const vekt = Math.abs(e) > grense ? grense / Math.abs(e) : 1;
      const Px = new Array(N).fill(0);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) Px[i] += k.P[i * N + j] * x[j];
      let nevner = GLEMSEL / vekt;
      for (let i = 0; i < N; i++) nevner += x[i] * Px[i];
      for (let i = 0; i < N; i++) k.th[i] = klem(k.th[i] + (Px[i] / nevner) * e, NEDRE[i], OVRE[i]);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) k.P[i * N + j] = (k.P[i * N + j] - (Px[i] * Px[j]) / nevner) / GLEMSEL;
      // Uten variasjon i en variabel vokser usikkerheten av glemselen: hold den under startverdien.
      for (let i = 0; i < N; i++) {
        const d = k.P[i * N + i];
        if (d > P0[i]) {
          const s = Math.sqrt(P0[i] / d);
          for (let j = 0; j < N; j++) { k.P[i * N + j] *= s; k.P[j * N + i] *= s; }
        } else if (d < 1e-9) k.P[i * N + i] = 1e-9;
      }
      k.th = k.th.map((v) => rund(v, 5));
      k.P = k.P.map((v) => Number(v.toPrecision(7)));
    });
    rom.n += 1;
    if (uSnitt[0] > 0.3) rom.nVarm += 1;
    if (uSnitt[0] < 0.1) rom.nKald += 1;
    const a = Math.abs(feilBest);
    rom.s2 = rund(rom.s2 === null ? Math.max(feilBest * feilBest, 0.04) : rom.s2 * 0.95 + Math.min(feilBest * feilBest, 9 * rom.s2 + 0.04) * 0.05, 5);
    rom.feilKort = rund(rom.feilKort === null ? a : rom.feilKort * 0.75 + a * 0.25);
    rom.feilLang = rund(rom.feilLang === null ? a : rom.feilLang * 0.97 + a * 0.03);

    // Hvilken treghet treffer best? Bytt bare når en annen er klart bedre.
    if (rom.n >= 10) {
      let best = rom.best;
      rom.kand.forEach((k, n) => { if (k.mse < rom.kand[best].mse * 0.9) best = n; });
      rom.best = best;
    }
    // Lærer av feil: bommer modellen mye mer enn den pleier, har noe endret seg (ny ovn,
    // ny årstid, møblert om). Da økes usikkerheten, så nye målinger veier tungt igjen.
    if (rom.n >= 20 && rom.n - rom.sistOmlaert >= 12 && rom.feilKort > 2.2 * Math.max(rom.feilLang, 0.15)) {
      for (const k of rom.kand) {
        for (let i = 0; i < N * N; i++) k.P[i] *= 4;
        for (let i = 0; i < N; i++) {
          const d = k.P[i * N + i];
          if (d > P0[i]) { const s = Math.sqrt(P0[i] / d); for (let j = 0; j < N; j++) { k.P[i * N + j] *= s; k.P[j * N + i] *= s; } }
        }
      }
      rom.sistOmlaert = rom.n;
      rom.omlaeringer += 1;
      rom.feilLang = rom.feilKort;
    }
  }

  // ------------------------------------------------------------------
  //  Det planleggeren og innsynet bruker
  // ------------------------------------------------------------------
  /**
   * Modellen for et rom i fysiske enheter.
   * `rSikker` og `kSikker` er den forsiktige utgaven (ett standardavvik svakere ovn og større tap).
   */
  modell(key) {
    const rom = this._rom(key);
    const k = rom.kand[rom.best];
    const th = k.th.map((v, i) => v / SKALA[i]);
    const s2 = rom.s2 ?? 0.25;
    const std = (i) => Math.sqrt(Math.max(0, s2 * k.P[i * N + i])) / SKALA[i];
    const feil = Math.sqrt(s2);
    const laert = rom.n >= 12 && rom.nVarm >= 3 && rom.nKald >= 3 && feil < 0.8 && th[0] > 0.2;
    const relR = std(0) / Math.max(th[0], 0.05);
    const relK = std(1) / Math.max(th[1], 0.003);
    const sikkerhet = klem((1 - klem((relR + relK) / 2, 0, 1)) * Math.min(1, rom.n / 12) * (laert ? 1 : 0.5), 0, 1);
    return {
      laert, n: rom.n,
      r: th[0], k: th[1], kv: th[2], sol: { ost: th[3], sor: th[4], vest: th[5] }, g: th[6], d: th[7],
      treghet: TREGHETER[rom.best], ueff: k.ueff ?? 0,
      rSikker: Math.max(th[0] - std(0), th[0] * 0.6), kSikker: Math.min(th[1] + std(1), th[1] * 1.5),
      feil: rund(feil, 3), sikkerhet: rund(sikkerhet, 2), omlaeringer: rom.omlaeringer, pmaks: rom.pmaks,
    };
  }
}

/**
 * Tapet og gratisvarmen i en gitt time: {k, gevinst}. `forsiktig` bruker den sikre utgaven
 * og regner ikke med sol (den kan utebli).
 */
function vilkaar(modell, { vind = 0, sol = null, aapen = false } = {}, forsiktig = false) {
  const k = (forsiktig ? modell.kSikker ?? modell.k : modell.k) + (modell.kv || 0) * Math.max(0, vind || 0) + (aapen ? modell.d || 0 : 0);
  const s = modell.sol || { ost: 0, sor: 0, vest: 0 };
  const solvarme = sol && !forsiktig ? s.ost * sol.ost + s.sor * sol.sor + s.vest * sol.vest : 0;
  return { k: Math.max(0.005, k), gevinst: (modell.g || 0) + solvarme };
}

/** Det modellen sier om rommet, i tall folk kan bruke. `effektKw` er ovnens effekt. */
function innsikt(modell, effektKw) {
  const lagring = effektKw / Math.max(modell.r, 0.05);                 // kWh per grad
  const retninger = [['øst', modell.sol.ost], ['sør', modell.sol.sor], ['vest', modell.sol.vest]].sort((a, b) => b[1] - a[1]);
  return {
    tidskonstant_t: rund(1 / Math.max(modell.k, 0.005), 0),
    tap_w_per_grad: Math.round(modell.k * lagring * 1000),
    lagring_kwh_per_grad: rund(lagring, 2),
    oppvarming_c_per_t: rund(modell.r, 2),
    vind_pst_ved_5ms: Math.round(((modell.kv * 5) / Math.max(modell.k, 0.005)) * 100),
    sol_fra: retninger[0][1] > 0.15 ? retninger[0][0] : null,
    sol_c_per_t: rund(retninger[0][1], 2),
    gratisvarme_c_per_t: rund(modell.g, 2),
    treghet_t: modell.treghet,
    treffer_c_per_t: modell.feil,
    sikkerhet_pst: Math.round(modell.sikkerhet * 100),
  };
}

/**
 * Tilstanden for et rom som alt er lært, med kjente tall. Til tester og simuleringer.
 * @param {object} p {r, k, kv, sol: {ost, sor, vest}, g, d, treghet}
 */
function ferdigLaert(p) {
  const sol = p.sol || {};
  const th = [p.r, p.k, p.kv || 0, sol.ost || 0, sol.sor || 0, sol.vest || 0, p.g || 0, p.d ?? 0.3].map((v, i) => v * SKALA[i]);
  const rom = nyttRom(th);
  for (const k of rom.kand) { for (let i = 0; i < N; i++) k.P[i * N + i] = 0.002; k.mse = 0.01; }
  const best = TREGHETER.indexOf(p.treghet || 0);
  return { ...rom, best: best < 0 ? 0 : best, n: 60, nVarm: 20, nKald: 20, s2: 0.01, feilKort: 0.08, feilLang: 0.08 };
}

/** Det samme i en setning eller tre, til innstillingssiden. */
function innsiktTekst(modell, effektKw) {
  const i = innsikt(modell, effektKw);
  if (!modell.laert) {
    return modell.n === 0
      ? 'Ikke lært ennå. Følger programmet til rommet er kjent — vanligvis innen et døgn.'
      : `Lærer rommet (${modell.n} av 12 målevinduer). Følger programmet imens.`;
  }
  const deler = [`Lært (${i.sikkerhet_pst} % sikker): taper ${i.tap_w_per_grad} W per grad mot ute og holder på varmen med en tidskonstant på ${i.tidskonstant_t} timer.`];
  deler.push(`Ovnen løfter rommet ${String(i.oppvarming_c_per_t).replace('.', ',')} °C i timen.`);
  if (i.treghet_t > 0) deler.push(`Varmen bruker rundt ${String(i.treghet_t).replace('.', ',')} timer på å nå rommet.`);
  if (i.vind_pst_ved_5ms >= 8) deler.push(`Vind på 5 m/s øker tapet med ${i.vind_pst_ved_5ms} %.`);
  if (i.sol_fra) deler.push(`Får mest solvarme fra ${i.sol_fra}.`);
  if (modell.omlaeringer > 0) deler.push(`Har lært rommet på nytt ${modell.omlaeringer} gang${modell.omlaeringer > 1 ? 'er' : ''} etter at det endret seg.`);
  return deler.join(' ');
}

module.exports = { Rommodeller, ferdigLaert, innsiktTekst, vilkaar, innsikt, trekk, TREGHETER, VERSJON };
