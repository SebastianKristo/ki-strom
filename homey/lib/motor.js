'use strict';

/**
 * Effektmotoren: holder timeforbruket under kapasitetstrinnet og varmer rommene så billig
 * som komforten tillater.
 *
 * Hvert tick (én gang i minuttet):
 *   1. Timens grense: det høyeste timen kan ende på uten at fastleddet går opp et trinn.
 *   2. Hvor mye effekt som kan brukes resten av timen, etter det som alt er brukt.
 *   3. Prognose for det motoren ikke styrer (lært per ukedag og time).
 *   4. Mål for hvert rom: fra den prisoptimale varmeplanen når rommet er lært, ellers fra programmet.
 *   5. Fordeling: rommene får effekt etter prioritet. Rekker det ikke til alle, senkes de
 *      minst viktige noen grader til timen har rom igjen.
 *
 * Klassen er ren: den får målinger inn og gir settpunkter og forklaringer ut. Appen leser
 * termostatene og skriver settpunktene — eller lar være, i skyggemodus.
 */

const kal = require('./kalender');
const { forvarmingMinutter } = require('./termisk');
const { Rommodeller, innsikt, innsiktTekst } = require('./rommodell');
const { planlegg, settpunktNaa } = require('./varmeplan');
const { kravVed, erDag } = require('./program');
const { Lastprofil } = require('./profil');
const { solmot } = require('./sol');

const TIME_MS = 3600000;
const TREGE = new Set(['gulv', 'vannbaaren']);
const BORTE_MARGIN = 1.3;
const TYPER = ['panel', 'gulv', 'vannbaaren', 'varmepumpe'];
const MIN_MS = 60000;
const DOGN_MS = 86400000;
const INGEN_SOL = { ost: 0, sor: 0, vest: 0 };

const STANDARD = {
  aktiv: true,
  skygge: true,                 // regn og forklar, men ikke rør termostatene
  maksTimeKwh: 6.0,             // absolutt grense for en time
  minTimeKwh: 3.0,              // grensen strammes aldri under dette
  reserveToppKwh: 0.3,          // avstand til trinngrensen
  reserveUregulertKw: 0.35,     // buffer for det prognosen ikke ser
  maalTrinnKw: null,            // «hold snittet under …», null = forsvar dagens trinn
  dagStart: '06:00',
  nattStart: '23:00',
  planAktiv: true,              // prisoptimal varmeplan for lærte rom
  planOppGrader: 1.0,           // hvor mye over kravet planen får forvarme
  planTimer: 36,
  forvarmingMaksTimer: 10,
  shedGulvMaks: 3.0,            // største senking av tregt anlegg
  shedPanelMaks: 2.0,
  gradvisIntervallMin: 3,
  kapasitetIPlan: true,         // varmeplanen unngår timer der huset pleier å bruke mye
  solandel: 0.5,                // hvor mye av den varslede solvarmen planen tør å regne med
  laerAvJusteringer: true,      // skrur du på termostaten selv, holdes det — og gjentatte justeringer læres
  korreksjonTimer: 3,           // så lenge holdes en manuell endring på termostaten
  vinduPauseMin: 3,             // åpent vindu så lenge: varmen pauses
  vinduTemp: 7,                 // settpunktet mens det luftes (frostsikring)
  vinduMaksMin: 90,             // lenger enn dette pauses ikke varmen: da er det heller sensoren som henger
  vind: null,                   // {enhet, kap} — egen vindmåler; ellers brukes værvarselet
  soner: [],                    // [{key, navn, termostater, effekt, temp, type, prio, nominell, profil, dag, natt, aktiv, styrt}]
};

const rund = (v, n = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
const halv = (v) => Math.round(v * 2) / 2;

/** Fargen på timen: hvor nær forventet forbruk er det som er tillatt. */
function sonefarge(brukKw, tillattKw) {
  if (tillattKw <= 0) return 'kritisk';
  const andel = (100 * brukKw) / Math.max(tillattKw, 0.05);
  if (andel >= 110) return 'kritisk';
  if (andel >= 97) return 'rod';
  if (andel >= 88) return 'oransje';
  if (andel >= 75) return 'gul';
  return 'gronn';
}

class Motor {
  /**
   * @param {object} tilstand lagret tilstand: {laering, profil, overstyringer, senket, sist_frigitt, sist_profil_ms}
   * @param {object} innstillinger se STANDARD
   */
  constructor(tilstand, innstillinger) {
    this.t = tilstand;
    this.t.modeller = this.t.modeller || {};
    this.t.profil = this.t.profil || {};
    this.t.treff = this.t.treff || {};             // key → {faktor, krav, borte, varmFra, n, sene}
    this.t.justering = this.t.justering || {};     // key → {dag, natt, logg: [{ms, delta, periode}]}
    this.t.sp = this.t.sp || {};                   // key → {onsket, onsketMs, sett, settMs}
    this.t.aapent = this.t.aapent || {};
    this.t.logg = this.t.logg || [];               // de siste hendelsene: [{ms, type, tekst}]           // key → ms da vinduet ble åpnet
    this.t.overstyringer = this.t.overstyringer || {};
    this.t.senket = this.t.senket || {};
    // Det forrige læringssystemet (t.laering) er utgangspunkt for rom som alt var lært.
    this.modeller = new Rommodeller(this.t.modeller, this.t.laering);
    this.synket = new Set();                       // rom der termostatens settpunkt er lest siden oppstart (lagres ikke)
    this.profil = new Lastprofil(this.t.profil);
    this.settInnstillinger(innstillinger);
  }

  settInnstillinger(innstillinger) {
    this.i = { ...STANDARD, ...(innstillinger || {}) };
    this.i.soner = (this.i.soner || []).filter((s) => s && s.key);
  }

  soner() {
    return this.i.soner.filter((s) => s.aktiv !== false);
  }

  // ------------------------------------------------------------------
  //  Overstyring
  // ------------------------------------------------------------------
  overstyr(key, temp, minutter, ms) {
    this.t.overstyringer[key] = { temp: Number(temp), tilMs: ms + Number(minutter) * 60000 };
  }

  fjernOverstyring(key = null) {
    if (key) delete this.t.overstyringer[key]; else this.t.overstyringer = {};
  }

  _overstyring(key, ms) {
    const o = this.t.overstyringer[key];
    if (!o) return null;
    if (ms >= o.tilMs) { delete this.t.overstyringer[key]; return null; }
    return o;
  }

  // ------------------------------------------------------------------
  //  Læring: modellen planen bruker, dine justeringer og treffsikkerheten
  // ------------------------------------------------------------------
  /**
   * Modellen planleggeren bruker for et rom. Et lært rom planlegges med den forsiktige
   * utgaven (litt svakere ovn, litt større tap), og med treff-faktoren: har rommet kommet
   * for sent til et kjent tidspunkt, regnes ovnen som svakere til det treffer igjen.
   */
  planmodell(key) {
    const m = this.modeller.modell(key);
    const faktor = (this.t.treff[key] && this.t.treff[key].faktor) || 1;
    return {
      ...m,
      r: Math.max(0.1, (m.laert ? m.rSikker : m.r) * faktor),
      k: m.laert ? m.kSikker : m.k,
      faktor,
    };
  }

  /** Timens varmetap og gratisvarme for et rom: vinden øker tapet, sola gir varme (forsiktig regnet). */
  vilkaar(modell, forhold) {
    const f = forhold || {};
    const sol = f.sol || INGEN_SOL;
    const s = modell.sol || INGEN_SOL;
    return {
      k: Math.max(0.005, modell.k + (modell.kv || 0) * Math.max(0, f.vind || 0)),
      gevinst: (modell.g || 0) + Number(this.i.solandel) * (s.ost * sol.ost + s.sor * sol.sor + s.vest * sol.vest),
    };
  }

  /** Lært justering for rommet på tidspunktet (°C), fra dine egne endringer på termostaten. */
  justering(key, ms) {
    const j = this.t.justering[key];
    if (!j || !this.i.laerAvJusteringer) return 0;
    return Number(erDag(ms, this.i) ? j.dag : j.natt) || 0;
  }

  glemJusteringer(key = null) {
    if (key) delete this.t.justering[key]; else this.t.justering = {};
  }

  glemLaering(key = null) {
    this.modeller.glem(key);
    if (key) delete this.t.treff[key]; else this.t.treff = {};
  }

  /** Kravet for rommet, med lært justering lagt til (ikke i bortemodus og ikke ved overstyring). */
  krav(sone, ms, i, o, kx) {
    const k = kravVed(sone, ms, i, o, kx);
    if (k.fast) return k;
    const borte = kx.borte && !(kx.hjemkomstMs !== null && kx.hjemkomstMs !== undefined && ms >= kx.hjemkomstMs);
    const j = borte ? 0 : this.justering(sone.key, ms);
    return j ? { ...k, min: k.min + j, grunn: `${k.grunn} (${j > 0 ? '+' : '−'}${Math.abs(j)} °C lært av dine justeringer)` } : k;
  }

  /**
   * Du har skrudd på termostaten selv. Det holdes i noen timer, og huskes: tre like
   * justeringer på to forskjellige dager blir en fast justering for dag eller natt.
   * @returns {Array} hendelser
   */
  _manuellEndring(sone, ms, verdi, grunnkrav, laer = true) {
    const i = this.i;
    const hendelser = [];
    const timer = Number(i.korreksjonTimer) || 3;
    this.overstyr(sone.key, verdi, timer * 60, ms);
    hendelser.push({ type: 'manuell', rom: sone.key, tekst: `${sone.navn || sone.key}: du satte ${verdi} °C på termostaten. Det holdes i ${timer} timer.` });
    if (!i.laerAvJusteringer || !laer) return hendelser;
    const j = this.t.justering[sone.key] || { dag: 0, natt: 0, logg: [] };
    const periode = erDag(ms, i) ? 'dag' : 'natt';
    j.logg = j.logg.filter((x) => ms - x.ms < 14 * DOGN_MS).concat([{ ms, delta: Math.round((verdi - grunnkrav) * 2) / 2, periode }]).slice(-20);
    // Det som teller, er justeringer som er uenige med det rommet har nå — også tilbake til
    // programmet, så en lært justering kan læres bort igjen på samme måte som den ble lært.
    const naa = Number(j[periode]) || 0;
    const like = j.logg.filter((x) => x.periode === periode && Math.abs(x.delta - naa) >= 0.5);
    const opp = like.filter((x) => x.delta > naa);
    const ned = like.filter((x) => x.delta < naa);
    const gruppe = opp.length >= ned.length ? opp : ned;
    const dager = new Set(gruppe.map((x) => kal.osloDato(x.ms)));
    if (gruppe.length >= 3 && dager.size >= 2) {
      const sortert = gruppe.map((x) => x.delta).sort((a, b) => a - b);
      const median = sortert[Math.floor(sortert.length / 2)];
      const ny = Math.min(2, Math.max(-2, median));
      if (ny !== j[periode]) {
        j[periode] = ny;
        const naar = periode === 'dag' ? 'dagen' : 'natten';
        hendelser.push({ type: 'laert_justering', rom: sone.key, tekst: ny === 0
          ? `${sone.navn || sone.key}: følger programmet igjen om ${naar}.`
          : `${sone.navn || sone.key}: lærte at du vil ha det ${Math.abs(ny)} °C ${ny > 0 ? 'varmere' : 'kaldere'} om ${naar}.` });
      }
      j.logg = j.logg.filter((x) => x.periode !== periode);
    }
    this.t.justering[sone.key] = j;
    return hendelser;
  }

  /**
   * Treffsikkerheten: i det kravet stiger på et tidspunkt klokka kunne forutsi, sjekkes det
   * om rommet var varmt. For sent → ovnen regnes som svakere neste gang. Varmt lenge før →
   * den regnes som litt sterkere. Uforutsette sprang (noen kom hjem) teller ikke.
   */
  _treff(sone, ms, maal, temp, i, kx, senket, ute = null) {
    const tr = this.t.treff[sone.key] || { faktor: 1, krav: null, borte: false, varmFra: null, n: 0, sene: 0 };
    this.t.treff[sone.key] = tr;
    let hendelse = null;
    const borte = Boolean(kx.borte);
    // Straff fra før rommet var lært gjelder gjetningene, ikke den lærte modellen.
    if (maal.laert && !tr.laert && tr.faktor < 1) tr.faktor = 1;
    tr.laert = Boolean(maal.laert);
    // En straff som ikke blir prøvd på nytt, skal ikke bli stående: den trappes ned litt hvert døgn.
    const dato = kal.osloDato(ms);
    if (tr.dato && tr.dato !== dato && tr.faktor < 1) tr.faktor = Math.round(Math.min(1, tr.faktor * 1.03) * 1000) / 1000;
    tr.dato = dato;
    if (senket) tr.senketMs = ms;
    if (tr.krav !== null && maal.krav > tr.krav + 0.4 && temp !== null && !maal.overstyrt) {
      const klokke = (t) => this.krav(sone, t, i, null, { ...kx, naaMs: t - 3 * TIME_MS }).min;
      const forutsigbart = Math.abs(klokke(ms) - maal.krav) < 0.3 && klokke(ms - 2 * MIN_MS) <= tr.krav + 0.3 && tr.borte === borte;
      const forstyrret = tr.senketMs && ms - tr.senketMs < 90 * MIN_MS;      // timebudsjettet holdt rommet nede: ikke modellens feil
      // Klarer ikke ovnen spranget i dette været uansett, er det ikke en planleggingsfeil.
      // Regnes med modellen uten straff: ellers kunne en lav faktor gjøre alt «umulig», og da
      // ville den aldri blitt prøvd på nytt.
      const raa = this.modeller.modell(sone.key);
      const behov = ute === null ? 0 : forvarmingMinutter({ ...raa, r: raa.laert ? raa.rSikker : raa.r, k: raa.laert ? raa.kSikker : raa.k }, tr.krav, maal.krav, ute);
      const umulig = behov === null || behov > Number(i.forvarmingMaksTimer) * 60;
      if (forutsigbart && !forstyrret && !umulig) {
        const mangel = maal.krav - temp;
        tr.n += 1;
        if (mangel > 0.7) {
          tr.sene += 1;
          tr.faktor = Math.round(Math.max(0.5, tr.faktor * (1 - Math.min(0.25, 0.08 * mangel))) * 1000) / 1000;
          hendelse = { type: 'for_sent', rom: sone.key, tekst: `${sone.navn || sone.key} var ${mangel.toFixed(1)} °C for kaldt da kravet steg. Starter tidligere neste gang.` };
        } else if (tr.varmFra && ms - tr.varmFra > 45 * MIN_MS) {
          // Varmt lenge før tiden: ovnen er sterkere enn planen regner med.
          tr.faktor = Math.round(Math.min(1.15, tr.faktor * 1.05) * 1000) / 1000;
        } else if (tr.faktor < 1) {
          // Traff: en tidligere straff trappes ned.
          tr.faktor = Math.round(Math.min(1, tr.faktor * 1.05) * 1000) / 1000;
        }
      }
    }
    // Under forvarming: når nådde rommet målet?
    if (maal.mal > maal.krav + 0.4 && temp !== null) {
      if (temp >= maal.mal - 0.3) { if (!tr.varmFra) tr.varmFra = ms; } else tr.varmFra = null;
    } else {
      tr.varmFra = null;
    }
    tr.krav = maal.krav;
    tr.borte = borte;
    return hendelse;
  }

  // ------------------------------------------------------------------
  //  Budsjett
  // ------------------------------------------------------------------
  /** Timens grense i kWh, og hvorfor. */
  grense(ms, kalk) {
    const i = this.i;
    const tak = kalk ? kalk.takForIdag(ms, i.maalTrinnKw) : null;
    if (tak === null) return { kwh: i.maksTimeKwh, grunn: 'absolutt grense (kapasitetsleddet har ingen trinn å forsvare)' };
    const okonomisk = tak - i.reserveToppKwh;
    if (okonomisk >= i.maksTimeKwh) return { kwh: i.maksTimeKwh, grunn: `absolutt grense — trinnet tåler ${rund(tak)} kWh` };
    if (okonomisk <= i.minTimeKwh) return { kwh: i.minTimeKwh, grunn: `laveste grense — trinnet er alt nær (${rund(tak)} kWh)` };
    return { kwh: rund(okonomisk), grunn: `holder kapasitetstrinnet: ${rund(tak)} kWh minus ${i.reserveToppKwh} i reserve` };
  }

  budsjett(ms, kalk, timeKwh, totalKw) {
    const g = this.grense(ms, kalk);
    const d = kal.osloDeler(ms);
    const minutterIgjen = 60 - d.minutt - d.sekund / 60;
    const timerIgjen = Math.max(minutterIgjen / 60, 0.02);
    let forbrukt = timeKwh;
    let usikker = false;
    if (forbrukt === null || forbrukt === undefined) {
      // Måleren svarer ikke: anslå fra effekten nå, og si fra.
      forbrukt = (totalKw || 0) * (d.minutt / 60);
      usikker = true;
    }
    const igjen = g.kwh - forbrukt;
    const tillatt = Math.min(igjen / Math.max(timerIgjen, 0.25), g.kwh);
    return { grense: g.kwh, grense_grunn: g.grunn, forbrukt: rund(forbrukt, 3), igjen: rund(igjen, 3), minutter_igjen: Math.floor(minutterIgjen), tillatt_kw: rund(tillatt, 3), usikker };
  }

  // ------------------------------------------------------------------
  //  Mål per rom
  // ------------------------------------------------------------------
  /**
   * Hva rommet skal ha nå: krav fra programmet, og mål fra varmeplanen når rommet er lært.
   * Returnerer {krav, mal, grunn, plan, modell}.
   */
  maal(sone, ms, maaling, { kalk, spot, uteTimer, forhold = null, grenseKwh = null, andreKw = 0, kontekst = {} }) {
    const i = { ...this.i, ...(kontekst.husinnst || {}) };
    const o = this._overstyring(sone.key, ms);
    const modell = this.planmodell(sone.key);
    // Bortetemperaturen for dette rommet, hvis huset er i bortemodus og motoren skal velge den.
    const kx = { ...kontekst, bortetemp: kontekst.borte && i.borteAutoTemp !== false ? this.bortetemp(sone, uteTimer) : null };
    const krav = this.krav(sone, ms, i, o, kx);
    const temp = maaling.temp;
    const ut = { krav: krav.min, mal: krav.min, grunn: krav.grunn, plan: null, laert: modell.laert, overstyrt: Boolean(krav.fast), kx };
    if (krav.fast || temp === null || temp === undefined) return ut;
    const effektKw = modell.pmaks || Number(sone.nominell) || 1;
    const vilkaarVed = (h) => (forhold && forhold[h] ? this.vilkaar(modell, forhold[h]) : null);

    if (i.planAktiv && modell.laert && uteTimer && uteTimer.length) {
      const start = kal.timestart(ms);
      const n = Math.min(Number(i.planTimer) || 36, uteTimer.length);
      const opp = sone.profil === 'konstant' ? Math.min(0.5, i.planOppGrader) : Number(i.planOppGrader);
      const timer = [];
      for (let h = 0; h < n; h++) {
        // Kravet gjelder ved timens slutt: da må rommet være varmt når kravet stiger.
        const k = this.krav(sone, start + (h + 1) * TIME_MS, i, o, kx);
        const grunnpris = kalk ? kalk.marginalpris(start + h * TIME_MS, spot) : 1;
        // Timer der huset pleier å bruke mye, er dyre på en annen måte: varmer rommet da, kan
        // timen sprenge kapasitetstrinnet. Planen får et påslag, så den varmer før eller etter.
        let paaslag = 0;
        const last = h > 0 && i.kapasitetIPlan && grenseKwh !== null ? this.profil.time(start + h * TIME_MS) : null;
        if (last) {
          const mangler = effektKw + andreKw - (grenseKwh - last.kw - last.sigma);
          if (mangler > 0) paaslag = Math.min(3, (1.5 * mangler) / Math.max(effektKw, 0.1));
        }
        timer.push({ ute: uteTimer[h], pris: grunnpris + paaslag, grunnpris, min: k.min, maks: k.min + opp, vilkaar: vilkaarVed(h) });
      }
      // Før kravet stiger må rommet få varme seg opp mot det nye nivået. Båndet åpnes så
      // mange timer i forveien som rommet trenger i det været — ikke hele natta.
      const maksFram = Math.max(1, Math.round(Number(i.forvarmingMaksTimer) || 10));
      for (let h = 0; h < n; h++) {
        for (let j = h + 1; j < Math.min(n, h + 1 + maksFram); j++) {
          if (timer[j].min <= timer[h].min + 0.2) continue;
          const behov = forvarmingMinutter(modell, timer[h].min, timer[j].min, timer[h].ute, timer[h].vilkaar);
          const timerBehov = behov === null ? maksFram : Math.ceil(behov / 60) + 1;
          if (j - h <= timerBehov) timer[h].maks = Math.max(timer[h].maks, timer[j].min + opp);
          break;
        }
      }
      const plan = planlegg({ start: temp, modell, effektKw, timer, ueff: modell.ueff });
      const settpunkt = settpunktNaa(plan);
      ut.plan = plan;
      // Planens første time gjelder til neste hele time. Kravet akkurat nå går alltid foran.
      ut.mal = Math.max(krav.min, settpunkt === null ? krav.min : settpunkt);
      if (ut.mal > krav.min + 0.2) {
        const stiger = timer.find((t) => t.min > krav.min + 0.2);
        ut.grunn = stiger ? 'Forvarming — planen starter i tide til kravet stiger' : 'Forvarming i billig time';
      } else if (plan.timer[0].u === 0 && temp > krav.min + 0.3) {
        ut.grunn = `${krav.grunn} — lar rommet gli (varmeplan)`;
      }
      return ut;
    }

    // Ulært rom: programmet, med enkel forvarming mot neste gang kravet stiger.
    const maksMin = Number(i.forvarmingMaksTimer) * 60;
    for (let m = 15; m <= maksMin; m += 15) {
      const neste = this.krav(sone, ms + m * 60000, i, o, kx);
      if (neste.min > krav.min + 0.2) {
        const ute = uteTimer && uteTimer.length ? uteTimer[0] : 0;
        let behov = forvarmingMinutter(modell, temp, neste.min, ute, vilkaarVed(0));
        if (behov === null) behov = maksMin;
        if (TREGE.has(sone.type)) behov = Math.max(behov, 45);
        if (m <= behov + 10 && temp < neste.min - 0.2) {
          ut.mal = neste.min;
          ut.grunn = `Forvarming — trenger ca. ${Math.round(behov)} min for å nå ${neste.min} °C`;
        } else if (TREGE.has(sone.type) && neste.min - 1.5 > krav.min) {
          // Et tregt anlegg vi ikke kjenner ennå, senkes bare litt: hvor lang tid det bruker
          // på å hente seg inn, vet vi først når rommet er lært.
          ut.mal = neste.min - 1.5;
          ut.grunn = `${krav.grunn} — senkes bare 1,5 °C til rommet er lært`;
        }
        break;
      }
    }
    return ut;
  }

  /**
   * Den laveste bortetemperaturen rommet rekker å varme seg opp fra til dagtemperaturen
   * innen forvarmingstiden, i det kaldeste været varselet viser. Null når rommet ikke er lært.
   *
   * Jo lavere rommet står mens huset er tomt, jo mindre strøm går med — også med
   * gjenoppvarmingen regnet med. Det som setter grensen, er tiden: rommene varmes samtidig
   * og deler effektbudsjettet, så hvert rom får en margin (BORTE_MARGIN).
   */
  bortetemp(sone, uteTimer) {
    const modell = this.planmodell(sone.key);
    if (!modell.laert || !uteTimer || !uteTimer.length) return null;
    const i = this.i;
    const ute = Math.min(...uteTimer);
    const dag = Number.isFinite(Number(sone.dag)) ? Number(sone.dag) : 21;
    const bunn = Number(i.borteMinTemp ?? 12);
    const grense = (Number(i.forvarmingMaksTimer) * 60) / BORTE_MARGIN;
    for (let t = bunn; t < dag; t += 0.5) {
      const behov = forvarmingMinutter(modell, t, dag, ute);
      if (behov !== null && behov <= grense) return t;
    }
    return null;
  }

  // ------------------------------------------------------------------
  //  Fordeling
  // ------------------------------------------------------------------
  /** Fordel tillatt effekt på rommene etter prioritet. Returnerer {plan, ledig}. */
  fordel(laster, budsjett, prognoseKw, ms, reservertKw = 0) {
    const i = this.i;
    // Reserven følger hvor godt forbruksprognosen pleier å treffe: uforutsigbart hus, større reserve.
    const reserve = this.profil.reserve(Number(i.reserveUregulertKw));
    let tilgjengelig = budsjett.tillatt_kw - prognoseKw - reserve - reservertKw;
    const romslig = tilgjengelig - laster.filter((l) => l.trenger).reduce((s, l) => s + l.effekt, 0) > 1.0;
    const intervall = Number(i.gradvisIntervallMin) * 60000;
    const forrige = this.t.senket;
    let frigittNaa = false;
    const plan = [];
    // Viktigst først (prio 1), og blant like: det rommet som er lengst unna målet.
    const rangert = [...laster].sort((a, b) => a.prio - b.prio || b.avvik - a.avvik);
    for (const last of rangert) {
      const p = { ...last };
      if (last.lufter && last.levende && last.styrt) {
        Object.assign(p, { handling: 'lufting', settpunkt: Number(i.vinduTemp) || 7, forklaring: 'Vindu eller dør står åpen — varmen pauses til det lukkes' });
      } else if (!last.levende) {
        Object.assign(p, { handling: 'utilgjengelig', settpunkt: null, forklaring: 'Termostaten svarer ikke — rører den ikke' });
      } else if (!last.styrt) {
        Object.assign(p, { handling: 'manuell', settpunkt: null, forklaring: 'Rommet styres manuelt' });
      } else if (!last.trenger) {
        Object.assign(p, { handling: 'normal', settpunkt: last.mal, forklaring: `${last.grunn}. Rommet er på måltemperatur` });
      } else if (tilgjengelig >= last.effekt || last.prio === 1) {
        const varSenket = Object.prototype.hasOwnProperty.call(forrige, last.key);
        const maaVente = frigittNaa || (this.t.sist_frigitt && ms - this.t.sist_frigitt < intervall);
        if (varSenket && last.prio !== 1 && !romslig && maaVente) {
          // Gradvis gjenoppvarming: senkede rom slippes ett om gangen, så ikke alle ovnene slår inn samtidig.
          const trinn = forrige[last.key] || 0.5;
          Object.assign(p, { handling: 'senket', settpunkt: halv(last.mal - trinn), senket: trinn, venter: true, forklaring: `Venter på tur i gjenoppvarmingen (${trinn.toFixed(1)} °C under mål)` });
          tilgjengelig = Math.max(tilgjengelig - last.effekt * 0.3, 0);
        } else {
          if (varSenket && !romslig) { frigittNaa = true; this.t.sist_frigitt = ms; }
          tilgjengelig -= last.effekt;
          Object.assign(p, { handling: 'normal', settpunkt: last.mal, forklaring: last.grunn + (varSenket ? ' — varmen er tilbake' : '') });
        }
      } else {
        const maks = TREGE.has(last.type) ? i.shedGulvMaks : last.type === 'varmepumpe' ? Math.min(i.shedPanelMaks, 1) : i.shedPanelMaks;
        const mangel = last.effekt - Math.max(tilgjengelig, 0);
        const trinn = Math.min(maks, halv(Math.max(0.5, (mangel / Math.max(last.effekt, 0.1)) * maks)));
        Object.assign(p, { handling: 'senket', settpunkt: halv(last.mal - trinn), senket: trinn, forklaring: `Senket ${trinn.toFixed(1)} °C — timen har ${Math.max(budsjett.igjen, 0).toFixed(2)} kWh igjen av ${budsjett.grense.toFixed(2)}` });
        tilgjengelig = Math.max(tilgjengelig - last.effekt * 0.3, 0);
      }
      plan.push(p);
    }
    this.t.senket = Object.fromEntries(plan.filter((p) => p.handling === 'senket').map((p) => [p.key, p.senket || 0.5]));
    return { plan, ledig: rund(tilgjengelig) };
  }

  // ------------------------------------------------------------------
  //  Hovedløkke
  // ------------------------------------------------------------------
  /**
   * @param {object} inn
   * @param {number} inn.ms
   * @param {object} inn.kalk Stromkalkulator (for trinngrense og pris), kan være null
   * @param {object} inn.spot Spotpriser
   * @param {object} inn.vaer Vaer
   * @param {number|null} inn.uteMaalt målt utetemperatur nå
   * @param {number|null} inn.totalW husets effekt nå
   * @param {number|null} inn.timeKwh forbrukt denne timen
   * @param {object} inn.maalinger {key: {temp, settpunkt, effektW, levende}}
   * @param {object} inn.kontekst fra Hus.kontekst(): bortemodus, hjemkomst og personer
   * @param {number} inn.reservertKw effekt som er holdt av til annet motoren kjenner (berederen)
   * @param {number} inn.annetStyrtW effekt motoren kjenner, men som ikke er romvarme (bereder, håndklevarmer)
   */
  tick(inn) {
    const { ms, kalk, spot, vaer } = inn;
    const i = this.i;
    const soner = this.soner();
    const totalKw = Number.isFinite(inn.totalW) ? inn.totalW / 1000 : null;
    const ute = Number.isFinite(inn.uteMaalt) ? inn.uteMaalt : (vaer ? vaer.tempVed(ms) : null);
    const antallTimer = Number(i.planTimer) || 36;
    const uteTimer = vaer ? vaer.timer(ms, antallTimer, ute, ute ?? 0) : null;
    // Vind og sol: nå (til læringen) og time for time framover (til planen).
    const sted = inn.sted || {};
    const vindMaalt = Number.isFinite(inn.vindMaalt) ? inn.vindMaalt : null;
    const vindNaa = vindMaalt ?? (vaer ? vaer.feltVed(ms, 'vind') : null) ?? 0;
    const solNaa = solmot(ms, sted.lat, sted.lon, vaer ? vaer.feltVed(ms, 'sky') : null);
    const start = kal.timestart(ms);
    const forhold = vaer ? vaer.vindOgSky(ms, antallTimer, vindMaalt).map((f, h) => ({
      vind: f.vind, sol: solmot(start + (h + 0.5) * TIME_MS, sted.lat, sted.lon, f.sky),
    })) : null;
    const hendelser = [];

    // Det motoren styrer, og resten
    let styrtW = 0;
    for (const s of soner) {
      const m = inn.maalinger[s.key] || {};
      if (Number.isFinite(m.effektW) && m.effektW > 0) styrtW += m.effektW;
    }
    const annetStyrtW = Number.isFinite(inn.annetStyrtW) ? inn.annetStyrtW : 0;
    const reservertKw = Number.isFinite(inn.reservertKw) ? inn.reservertKw : 0;
    const kontekst = inn.kontekst || {};
    const uregulertKw = totalKw === null ? null : Math.max(totalKw - (styrtW + annetStyrtW) / 1000, 0);
    if (uregulertKw !== null && (!this.t.sist_profil_ms || ms - this.t.sist_profil_ms >= 5 * 60000)) {
      this.profil.laer(ms, uregulertKw);
      if (inn.vaner) inn.vaner.last(ms, uregulertKw);
      this.t.sist_profil_ms = ms;
    }
    const prognose = this.profil.prognose(ms, uregulertKw ?? 0.5, 15);
    const budsjett = this.budsjett(ms, kalk, inn.timeKwh, totalKw);
    const styrer = Boolean(i.aktiv) && !i.skygge;
    const nominellAlle = soner.reduce((sum, x) => sum + (Number(x.nominell) || 1), 0);

    const laster = [];
    let spart = 0;
    for (const s of soner) {
      const m = { temp: null, settpunkt: null, effektW: null, levende: false, aapen: null, ...(inn.maalinger[s.key] || {}) };
      const raa = this.modeller.modell(s.key);
      const effektKw = raa.pmaks || Number(s.nominell) || 1;

      // Åpent vindu eller dør mot ute: varmen pauses etter noen minutter.
      if (m.aapen) { if (!this.t.aapent[s.key]) this.t.aapent[s.key] = ms; } else delete this.t.aapent[s.key];
      const aapenMin = this.t.aapent[s.key] ? (ms - this.t.aapent[s.key]) / MIN_MS : 0;
      // En sensor som henger på «åpen» skal ikke få la rommet stå kaldt: etter en stund varmes det igjen.
      const lufter = aapenMin >= Number(i.vinduPauseMin) && aapenMin < Number(i.vinduMaksMin);
      const sensorHenger = aapenMin >= Number(i.vinduMaksMin);

      // Læring. Pådraget kommer fra effektmålingen; uten den fra termostaten når den tydelig
      // varmer eller tydelig står (nær settpunktet vet vi ikke, og lærer ingenting).
      let u = null;
      if (Number.isFinite(m.effektW)) u = Math.max(0, m.effektW) / 1000 / effektKw;
      else if (Number.isFinite(m.settpunkt) && m.temp !== null) u = m.settpunkt - m.temp >= 0.6 ? 1 : m.settpunkt - m.temp <= -0.6 ? 0 : null;
      if (ute !== null && m.temp !== null) {
        const foer = raa.omlaeringer;
        this.modeller.observer(s.key, { ms, temp: m.temp, ute, u, vind: vindNaa, sol: solNaa, aapen: Boolean(m.aapen), effektKw: Number.isFinite(m.effektW) ? m.effektW / 1000 : null });
        if (this.modeller.modell(s.key).omlaeringer > foer) hendelser.push({ type: 'laerer_om', rom: s.key, tekst: `${s.navn || s.key}: modellen bommet mer enn den pleier og lærer rommet på nytt.` });
      }

      // Har du skrudd på termostaten selv? Verdien den melder har stått stille, og endrer seg
      // uten at vi har bedt om det.
      const sp = this.t.sp[s.key] || { onsket: null, onsketMs: 0, forrige: null, sett: null, settMs: 0 };
      this.t.sp[s.key] = sp;
      if (Number.isFinite(m.settpunkt) && !this.synket.has(s.key)) {
        // Første måling etter oppstart: tilstanden kan være minutter gammel (den lagres ikke
        // hvert minutt), så det termostaten står på nå er utgangspunktet — ikke en justering.
        this.synket.add(s.key);
        sp.sett = m.settpunkt;
        sp.settMs = ms;
      }
      if (Number.isFinite(m.settpunkt) && m.settpunkt !== sp.sett) {
        const stabil = sp.sett !== null && ms - sp.settMs >= 3 * MIN_MS;
        const vaartSkifte = ms - sp.onsketMs < 3 * MIN_MS;
        // En termostat som bare tar hele grader melder 22 når vi ba om 21,5: det er ikke en
        // justering. Det er heller ikke en treg termostat som først nå melder det vi ba om sist.
        const slakk = Math.max(0.5, Number(m.steg) || 0.5);
        // Det vi ba om klemmes til termostatens egne grenser før det skrives (en varmepumpe går ikke under 16 °C).
        const klemt = (verdi) => Math.min(Number.isFinite(m.maks) ? m.maks : 35, Math.max(Number.isFinite(m.min) ? m.min : 5, verdi));
        const vaart = (verdi) => verdi !== null && verdi !== undefined && Math.abs(m.settpunkt - klemt(verdi)) < slakk + (slakk > 0.5 ? 0.01 : 0);
        // «Treg» gjelder bare til termostaten har bekreftet det vi sist ba om; etter det er en
        // endring tilbake til en eldre verdi noe du har gjort.
        const treg = !sp.bekreftet && vaart(sp.forrige) && ms - sp.onsketMs < 30 * MIN_MS;
        if (vaart(sp.onsket)) sp.bekreftet = true;
        if (styrer && s.styrt !== false && m.levende && stabil && !vaartSkifte && sp.onsket !== null
          && Math.abs(m.settpunkt - sp.sett) >= 0.5 && !vaart(sp.onsket) && !treg) {
          const grunnkrav = kravVed(s, ms, { ...i, ...(kontekst.husinnst || {}) }, null, { ...kontekst }).min;
          // Justeringen sier noe om hva du vil ha bare når appen ba om selve kravet. Under
          // forvarming, senking eller lufting er den et svar på noe annet, og holdes uten å læres.
          const baOmKravet = !kontekst.borte && Math.abs(sp.onsket - (grunnkrav + this.justering(s.key, ms))) < 0.3;
          hendelser.push(...this._manuellEndring(s, ms, m.settpunkt, grunnkrav, baOmKravet));
        }
        sp.sett = m.settpunkt;
        sp.settMs = ms;
      }

      const andreKw = 0.4 * (nominellAlle - (Number(s.nominell) || 1));
      const maal = this.maal(s, ms, m, { kalk, spot, uteTimer, forhold, grenseKwh: budsjett.grense, andreKw, kontekst });
      const treff = this._treff(s, ms, maal, m.temp, { ...i, ...(kontekst.husinnst || {}) }, maal.kx, Object.prototype.hasOwnProperty.call(this.t.senket, s.key), ute);
      if (treff) hendelser.push(treff);
      if (maal.plan) spart += maal.plan.spart;
      const avvik = m.temp === null ? 0.3 : maal.mal - m.temp;
      const trenger = avvik > 0.2;
      const trekker = !trenger ? 0 : (Number.isFinite(m.effektW) && m.effektW > 50 ? m.effektW / 1000 : effektKw * 0.5);
      const effekt = lufter ? 0 : trekker;
      const lm = this.modeller.modell(s.key);
      const faktor = (this.t.treff[s.key] && this.t.treff[s.key].faktor) || 1;
      laster.push({
        key: s.key, navn: s.navn || s.key, type: s.type || 'panel', prio: Number(s.prio) || 3,
        levende: Boolean(m.levende), styrt: s.styrt !== false,
        temp: m.temp, settpunkt_naa: m.settpunkt, effekt_w: m.effektW,
        krav: maal.krav, mal: maal.mal, laert: maal.laert,
        grunn: sensorHenger ? `${maal.grunn}. Vinduet har meldt åpent i over ${Math.round(Number(i.vinduMaksMin))} minutter — varmer likevel (sjekk sensoren)` : maal.grunn,
        avvik: rund(avvik), trenger: trenger && !lufter, effekt: rund(effekt, 3), lufter,
        aapen: m.aapen === null ? null : Boolean(m.aapen),
        justering: this.justering(s.key, ms),
        modell: { ...innsikt(lm, effektKw), tekst: innsiktTekst(lm, effektKw), laert: lm.laert, vinduer: lm.n, treff_faktor: faktor, effekt_kw: rund(effektKw, 2), omlaeringer: lm.omlaeringer },
        plan: maal.plan ? maal.plan.timer.slice(0, 24).map((t) => ({ u: t.u, til: rund(t.til, 1), min: t.min, pris: rund(t.pris, 3) })) : null,
      });
    }

    const { plan, ledig } = this.fordel(laster, budsjett, prognose, ms, reservertKw);
    // Det vi ber termostatene om, huskes — så en endring vi ikke har bedt om kan kjennes igjen.
    for (const p of plan) {
      const sp = this.t.sp[p.key];
      if (sp && p.settpunkt !== sp.onsket) { sp.forrige = sp.onsket; sp.onsket = p.settpunkt; sp.onsketMs = ms; sp.bekreftet = false; }
    }
    const styrtKw = plan.filter((p) => p.handling === 'normal').reduce((s, p) => s + p.effekt, 0);
    const forventetKw = prognose + styrtKw + reservertKw;
    const farge = sonefarge(forventetKw, budsjett.tillatt_kw);
    const senket = plan.filter((p) => p.handling === 'senket');
    const forventetTime = budsjett.forbrukt + forventetKw * Math.max(budsjett.minutter_igjen / 60, 0);

    let forklaring;
    if (!i.aktiv) forklaring = 'Motoren er slått av.';
    else if (!soner.length) forklaring = 'Ingen rom er satt opp ennå.';
    else if (senket.length) forklaring = `${senket.map((p) => p.navn).join(', ')} er senket — timen ligger an til ${rund(forventetTime)} kWh av ${budsjett.grense}.`;
    else if (farge === 'gronn') forklaring = `God margin: timen ligger an til ${rund(forventetTime)} kWh av ${budsjett.grense}.`;
    else forklaring = `Følger med: timen ligger an til ${rund(forventetTime)} kWh av ${budsjett.grense}.`;
    if (i.aktiv && i.skygge && soner.length) forklaring += ' Skyggemodus: termostatene røres ikke.';

    if (hendelser.length) this.t.logg = this.t.logg.concat(hendelser.map((h) => ({ ms, type: h.type, tekst: h.tekst }))).slice(-30);

    return {
      tid: new Date(ms).toISOString(),
      aktiv: Boolean(i.aktiv),
      skygge: Boolean(i.skygge),
      status: i.aktiv ? farge : 'av',
      forklaring,
      budsjett,
      forventet_time_kwh: rund(forventetTime),
      forventet_kw: rund(forventetKw),
      ledig_kw: ledig,
      uregulert_kw: rund(uregulertKw),
      prognose_uregulert_kw: rund(prognose),
      styrt_w: Math.round(styrtW),
      ute: rund(ute, 1),
      vaervarsel: Boolean(vaer && vaer.punkter.length && !vaer.utdatert(ms)),
      plan_spart_kr: rund(spart),
      reservert_kw: rund(reservertKw),
      reserve_kw: this.profil.reserve(Number(i.reserveUregulertKw)),
      prognose_treff: this.profil.treffsikkerhet(),
      vind: rund(vindNaa, 1),
      sol: solNaa,
      hendelser,
      logg: this.t.logg.slice(-10).reverse().map((h) => ({ tid: new Date(h.ms).toISOString(), type: h.type, tekst: h.tekst })),
      soner: plan,
    };
  }

  /** Settpunktene som skal skrives nå: [{key, settpunkt}]. Tom liste når motoren er av eller i skyggemodus. */
  static skriveliste(bilde) {
    if (!bilde.aktiv || bilde.skygge) return [];
    return bilde.soner
      .filter((p) => p.settpunkt !== null && p.settpunkt !== undefined && (p.settpunkt_naa === null || Math.abs(p.settpunkt - p.settpunkt_naa) >= 0.25))
      .map((p) => ({ key: p.key, settpunkt: p.settpunkt }));
  }
}

module.exports = { Motor, STANDARD, TYPER, TREGE, BORTE_MARGIN, sonefarge };
