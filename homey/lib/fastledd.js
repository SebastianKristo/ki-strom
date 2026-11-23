'use strict';

/**
 * Fastleddet (kapasitetsleddet): fra tariff og effekttopper til kroner per måned.
 *
 * Oversatt fra Strømkalkulator (dso.py og fastledd.py). De fleste nettselskap bruker
 * NVE-modellen — snittet av de tre høyeste døgnmaksene i måneden — men fem gjør noe annet,
 * og hos dem stemmer beløpet bare hvis metoden er riktig.
 */

const { ukestart } = require('./kalender');

const METODE = {
  TRE_DOGNMAX_MND: 'TRE_DØGNMAX_MND',   // snitt av tre høyeste døgnmakser (standard)
  MND_MAX: 'MND_MAX',                   // månedens høyeste enkelttime
  OV_TREFASE: 'OV_TREFASE',             // etter hovedsikring — brukeren velger raden
  FEM_VEKTET_AR: 'FEM_VEKTET_ÅR',       // fem sesongvektede ukestopper over tolv måneder
  UKJENT: 'UKJENT',                     // ikke publisert — regnes som NVE-modellen
};
const TRINNBASERTE = new Set([METODE.TRE_DOGNMAX_MND, METODE.MND_MAX, METODE.UKJENT]);
const FEM_VEKTET_ANTALL = 5;
const UKJENT_TEKST = 'fastledd ukjent';
const SIKRING_MANGLER_TEKST = 'sikringsstørrelse ikke valgt';

const grense = (kw) => (kw === null || kw === undefined ? Infinity : kw);

/** Fast bosted endrer støttevilkårene, ikke bygningstypen. */
function hentKapasitetstrinn(dso, boligtype) {
  const type = boligtype === 'fritidsbolig_fast' ? 'fritidsbolig' : boligtype;
  const egne = (dso.kapasitetstrinn_per_boligtype || {})[type];
  return (egne || dso.kapasitetstrinn || []).map(([kw, kr]) => [grense(kw), kr]);
}

/**
 * Tariffen fastledd-oppslaget trenger: nettselskapets tabell og brukerens valg.
 * `sikringstrinn` er id-en brukeren har valgt hos nettselskap med OV_TREFASE.
 */
function lagTariff(dso, { boligtype = 'bolig', mvaSats = 0.25, sikringstrinn = null } = {}) {
  const rader = dso.fastledd_sikringstrinn || [];
  const valgt = rader.findIndex((r) => r.id === sikringstrinn);
  return {
    metode: dso.fastledd_metode || METODE.TRE_DOGNMAX_MND,
    mvaSats,
    trinn: hentKapasitetstrinn(dso, boligtype),
    terskelInkludert: dso.terskel_inkludert !== false,
    kildegrenseKw: dso.kjent_fastledd_maks_kw ?? null,
    kildegrenseInkludert: dso.kjent_fastledd_maks_kw_inkludert !== false,
    lineaer: dso.fastledd_lineaer || null,
    sesongfaktor: dso.fastledd_sesongfaktor || {},
    sikringstrinn: valgt >= 0 ? { nummer: valgt + 1, ...rader[valgt] } : null,
  };
}

/** De fleste legger eksakt grensetreff i trinnet over (`<`); «til og med»-tabeller bruker `<=`. */
const iLavereTrinn = (kw, terskel, terskelInkludert) => (terskelInkludert ? kw < terskel : kw <= terskel);

/** Slå opp fastledd for et effektgrunnlag: { pris, nummer, tekst }. */
function finnKapasitetstrinn(trinn, kw, terskelInkludert = true) {
  for (let i = 0; i < trinn.length; i++) {
    const [terskel, pris] = trinn[i];
    if (iLavereTrinn(kw, terskel, terskelInkludert)) {
      const forrige = i > 0 ? trinn[i - 1][0] : 0;
      const tekst = terskel === Infinity ? `>${forrige.toFixed(0)} kW` : `${forrige.toFixed(0)}-${terskel.toFixed(0)} kW`;
      return { pris, nummer: i + 1, tekst };
    }
  }
  const siste = trinn.length;
  const forrige = siste > 1 ? trinn[siste - 2][0] : 0;
  return { pris: trinn[siste - 1][1], nummer: siste, tekst: `>${forrige.toFixed(0)} kW` };
}

/** Ukestoppens sesongvektede effekt. Vekten følger mandagen i uken, ikke toppens egen måned. */
function vektetKw(kw, dato, sesongfaktor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dato || '')) return kw;
  const mnd = Number(ukestart(dato).slice(5, 7));
  return kw * (sesongfaktor[mnd] ?? sesongfaktor[String(mnd)] ?? 1);
}

/**
 * Effekten i kW som nettselskapets metode legger til grunn.
 * `doegnmaks` er månedens høyeste time per dag, `ukestopper` er [{kw, dato}] for FEM_VEKTET_ÅR.
 */
function fastleddGrunnlag(tariff, doegnmaks, ukestopper = []) {
  if (tariff.metode === METODE.MND_MAX) return doegnmaks.length ? Math.max(...doegnmaks) : 0;
  if (tariff.metode === METODE.FEM_VEKTET_AR) {
    const vektet = ukestopper.map((u) => vektetKw(u.kw, u.dato, tariff.sesongfaktor))
      .sort((a, b) => b - a).slice(0, FEM_VEKTET_ANTALL);
    if (!vektet.length) return 0;
    return Math.round((vektet.reduce((s, v) => s + v, 0) / vektet.length) * 100) / 100;
  }
  const topp = [...doegnmaks].sort((a, b) => b - a).slice(0, 3);
  if (!topp.length) return 0;
  return topp.reduce((s, v) => s + v, 0) / topp.length;
}

/** Ligger grunnlaget der kilden ikke oppgir noe beløp? */
function utenforKildegrense(tariff, kw) {
  const g = tariff.kildegrenseKw;
  if (g === null || g === undefined) return false;
  return kw > g || (kw === g && !tariff.kildegrenseInkludert);
}

/** Ukjent fordi ingen kjenner trinnene — heller «ukjent» enn et plausibelt beløp uten kilde. */
const fastleddUkjent = (tariff, kw) => (TRINNBASERTE.has(tariff.metode) && !tariff.trinn.length) || utenforKildegrense(tariff, kw);

const fastleddBelopUkjent = (tariff, kw) => fastleddUkjent(tariff, kw) || (tariff.metode === METODE.OV_TREFASE && !tariff.sikringstrinn);

/** Grunnbeløp + sats per kW, i hele kroner per måned inkl. mva. */
function lineaertFastledd(tariff, kw) {
  if (!tariff.lineaer) return 0;
  const aar = tariff.lineaer.grunnbelop_aar_eks_mva + tariff.lineaer.sats_kw_aar_eks_mva * kw;
  return Math.floor((aar / 12) * (1 + tariff.mvaSats) + 0.5);
}

/** Fastledd i kr/mnd for et effektgrunnlag: { pris, nummer, tekst }. `nummer` er null uten trinn. */
function fastleddForGrunnlag(tariff, kw) {
  if (fastleddUkjent(tariff, kw)) return { pris: 0, nummer: null, tekst: UKJENT_TEKST };
  if (tariff.metode === METODE.OV_TREFASE) {
    if (!tariff.sikringstrinn) return { pris: 0, nummer: null, tekst: SIKRING_MANGLER_TEKST };
    return { pris: tariff.sikringstrinn.kr_mnd, nummer: tariff.sikringstrinn.nummer, tekst: tariff.sikringstrinn.label };
  }
  if (tariff.metode === METODE.FEM_VEKTET_AR) {
    return { pris: lineaertFastledd(tariff, kw), nummer: null, tekst: `${kw.toFixed(2)} kW vektet årstopp` };
  }
  return finnKapasitetstrinn(tariff.trinn, kw, tariff.terskelInkludert);
}

/**
 * Margin til neste trinn og prisen der. { marginKw, nestePris } — margin 0 og samme pris
 * betyr at det ikke finnes noe høyere trinn (eller at metoden ikke har trinn).
 */
function nesteTrinn(tariff, kw, pris) {
  if (!TRINNBASERTE.has(tariff.metode)) return { marginKw: 0, nestePris: pris };
  for (let i = 0; i < tariff.trinn.length; i++) {
    const [terskel] = tariff.trinn[i];
    if (iLavereTrinn(kw, terskel, tariff.terskelInkludert)) {
      if (i + 1 < tariff.trinn.length) {
        return { marginKw: Math.round((terskel - kw) * 100) / 100, nestePris: tariff.trinn[i + 1][1] };
      }
      break;
    }
  }
  return { marginKw: 0, nestePris: pris };
}

/**
 * Les brukerens egne trinn: «2:155,5:250,10:415» (øvre kW-grense : kr/mnd inkl. mva).
 * Tom tekst gir tom liste. Et komma uten kolon etter er et desimaltegn: «155,5» er én pris.
 */
function parseKapasitetstrinn(tekst) {
  const ryddet = String(tekst || '').trim();
  if (!ryddet) return [];
  const tall = (raa, hva) => {
    const t = raa.trim().replace(',', '.');
    if (!t || Number.isNaN(Number(t))) throw new Error(`«${raa.trim()}» er ikke et tall (${hva})`);
    return Number(t);
  };
  const trinn = [];
  for (const raaPar of ryddet.split(',')) {
    const par = raaPar.trim();
    if (!par) throw new Error(`Tomt trinn i «${tekst}»`);
    if (!par.includes(':')) {
      if (!trinn.length || !/^\d+$/.test(par)) throw new Error(`«${par}» mangler kolon mellom kW-grense og pris`);
      const forrige = trinn[trinn.length - 1];
      forrige[1] = tall(`${forrige[1]}.${par}`, 'pris');
      continue;
    }
    const [raaGrense, raaPris] = par.split(':');
    const g = tall(raaGrense, 'kW-grense');
    const p = tall(raaPris, 'pris');
    if (g <= 0) throw new Error(`kW-grensen må være over null, fikk «${raaGrense.trim()}»`);
    if (p < 0) throw new Error(`Prisen kan ikke være negativ, fikk «${raaPris.trim()}»`);
    if (trinn.length && g <= trinn[trinn.length - 1][0]) throw new Error(`kW-grensene må stige: ${g} kommer etter ${trinn[trinn.length - 1][0]}`);
    trinn.push([g, p]);
  }
  return trinn;
}

/** Sesongperioden som dekker «MM-DD», eller null. Perioder kan krysse nyttår. */
function finnAktivPeriode(perioder, mmdd) {
  for (const p of perioder || []) {
    if (p.fra <= p.til ? (p.fra <= mmdd && mmdd <= p.til) : (mmdd >= p.fra || mmdd <= p.til)) return p;
  }
  return null;
}

module.exports = {
  METODE, TRINNBASERTE, UKJENT_TEKST, SIKRING_MANGLER_TEKST,
  hentKapasitetstrinn, lagTariff, finnKapasitetstrinn, vektetKw, fastleddGrunnlag,
  utenforKildegrense, fastleddUkjent, fastleddBelopUkjent, lineaertFastledd, fastleddForGrunnlag,
  nesteTrinn, parseKapasitetstrinn, finnAktivPeriode,
};
