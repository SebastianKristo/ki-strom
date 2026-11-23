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
const { Laering, forvarmingMinutter } = require('./termisk');
const { planlegg, settpunktNaa } = require('./varmeplan');
const { kravVed } = require('./program');
const { Lastprofil } = require('./profil');

const TIME_MS = 3600000;
const TREGE = new Set(['gulv', 'vannbaaren']);
const TYPER = ['panel', 'gulv', 'vannbaaren', 'varmepumpe'];

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
    this.t.laering = this.t.laering || {};
    this.t.profil = this.t.profil || {};
    this.t.overstyringer = this.t.overstyringer || {};
    this.t.senket = this.t.senket || {};
    this.laering = new Laering(this.t.laering);
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
  maal(sone, ms, maaling, { kalk, spot, uteTimer }) {
    const i = this.i;
    const o = this._overstyring(sone.key, ms);
    const krav = kravVed(sone, ms, i, o);
    const modell = this.laering.modell(sone.key);
    const temp = maaling.temp;
    const ut = { krav: krav.min, mal: krav.min, grunn: krav.grunn, plan: null, laert: modell.laert };
    if (krav.fast || temp === null || temp === undefined) return ut;
    const effektKw = Number(sone.nominell) || 1;

    if (i.planAktiv && modell.laert && uteTimer && uteTimer.length) {
      const start = kal.timestart(ms);
      const n = Math.min(Number(i.planTimer) || 36, uteTimer.length);
      const opp = sone.profil === 'konstant' ? Math.min(0.5, i.planOppGrader) : Number(i.planOppGrader);
      const timer = [];
      for (let h = 0; h < n; h++) {
        // Kravet gjelder ved timens slutt: da må rommet være varmt når kravet stiger.
        const k = kravVed(sone, start + (h + 1) * TIME_MS, i, o);
        timer.push({ ute: uteTimer[h], pris: kalk ? kalk.marginalpris(start + h * TIME_MS, spot) : 1, min: k.min, maks: k.min + opp });
      }
      // Før kravet stiger må rommet få varme seg opp mot det nye nivået. Båndet åpnes så
      // mange timer i forveien som rommet trenger i det været — ikke hele natta.
      const maksFram = Math.max(1, Math.round(Number(i.forvarmingMaksTimer) || 10));
      for (let h = 0; h < n; h++) {
        for (let j = h + 1; j < Math.min(n, h + 1 + maksFram); j++) {
          if (timer[j].min <= timer[h].min + 0.2) continue;
          const behov = forvarmingMinutter(modell, timer[h].min, timer[j].min, timer[h].ute);
          const timerBehov = behov === null ? maksFram : Math.ceil(behov / 60) + 1;
          if (j - h <= timerBehov) timer[h].maks = Math.max(timer[h].maks, timer[j].min + opp);
          break;
        }
      }
      const plan = planlegg({ start: temp, modell, effektKw, timer });
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
      const neste = kravVed(sone, ms + m * 60000, i, o);
      if (neste.min > krav.min + 0.2) {
        const ute = uteTimer && uteTimer.length ? uteTimer[0] : 0;
        let behov = forvarmingMinutter(modell, temp, neste.min, ute);
        if (behov === null) behov = maksMin;
        if (TREGE.has(sone.type)) behov = Math.max(behov, 45);
        if (m <= behov + 10 && temp < neste.min - 0.2) {
          ut.mal = neste.min;
          ut.grunn = `Forvarming — trenger ca. ${Math.round(behov)} min for å nå ${neste.min} °C`;
        }
        break;
      }
    }
    return ut;
  }

  // ------------------------------------------------------------------
  //  Fordeling
  // ------------------------------------------------------------------
  /** Fordel tillatt effekt på rommene etter prioritet. Returnerer {plan, ledig}. */
  fordel(laster, budsjett, prognoseKw, ms) {
    const i = this.i;
    let tilgjengelig = budsjett.tillatt_kw - prognoseKw - i.reserveUregulertKw;
    const romslig = tilgjengelig - laster.filter((l) => l.trenger).reduce((s, l) => s + l.effekt, 0) > 1.0;
    const intervall = Number(i.gradvisIntervallMin) * 60000;
    const forrige = this.t.senket;
    let frigittNaa = false;
    const plan = [];
    // Viktigst først (prio 1), og blant like: det rommet som er lengst unna målet.
    const rangert = [...laster].sort((a, b) => a.prio - b.prio || b.avvik - a.avvik);
    for (const last of rangert) {
      const p = { ...last };
      if (!last.levende) {
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
   */
  tick(inn) {
    const { ms, kalk, spot, vaer } = inn;
    const i = this.i;
    const soner = this.soner();
    const totalKw = Number.isFinite(inn.totalW) ? inn.totalW / 1000 : null;
    const ute = Number.isFinite(inn.uteMaalt) ? inn.uteMaalt : (vaer ? vaer.tempVed(ms) : null);
    const uteTimer = vaer ? vaer.timer(ms, Number(i.planTimer) || 36, ute, ute ?? 0) : null;

    // Det motoren styrer, og resten
    let styrtW = 0;
    for (const s of soner) {
      const m = inn.maalinger[s.key] || {};
      if (Number.isFinite(m.effektW) && m.effektW > 0) styrtW += m.effektW;
    }
    const uregulertKw = totalKw === null ? null : Math.max(totalKw - styrtW / 1000, 0);
    if (uregulertKw !== null && (!this.t.sist_profil_ms || ms - this.t.sist_profil_ms >= 5 * 60000)) {
      this.profil.laer(ms, uregulertKw);
      this.t.sist_profil_ms = ms;
    }
    const prognose = this.profil.prognose(ms, uregulertKw ?? 0.5, 15);
    const budsjett = this.budsjett(ms, kalk, inn.timeKwh, totalKw);

    const laster = [];
    let spart = 0;
    for (const s of soner) {
      const m = { temp: null, settpunkt: null, effektW: null, levende: false, ...(inn.maalinger[s.key] || {}) };
      // Læring: ovnen går (over 100 W) eller står (under 30 W). Uten effektmåling vet vi ikke.
      const tilstand = !Number.isFinite(m.effektW) ? null : m.effektW > 100 ? 'varmer' : m.effektW < 30 ? 'av' : null;
      if (ute !== null && m.temp !== null) this.laering.observer(s.key, { ms, temp: m.temp, ute, tilstand });
      const maal = this.maal(s, ms, m, { kalk, spot, uteTimer });
      if (maal.plan) spart += maal.plan.spart;
      const avvik = m.temp === null ? 0.3 : maal.mal - m.temp;
      const trenger = avvik > 0.2;
      const effekt = !trenger ? 0 : (Number.isFinite(m.effektW) && m.effektW > 50 ? m.effektW / 1000 : (Number(s.nominell) || 1) * 0.5);
      laster.push({
        key: s.key, navn: s.navn || s.key, type: s.type || 'panel', prio: Number(s.prio) || 3,
        levende: Boolean(m.levende), styrt: s.styrt !== false,
        temp: m.temp, settpunkt_naa: m.settpunkt, effekt_w: m.effektW,
        krav: maal.krav, mal: maal.mal, grunn: maal.grunn, laert: maal.laert,
        avvik: rund(avvik), trenger, effekt: rund(effekt, 3),
        plan: maal.plan ? maal.plan.timer.slice(0, 24).map((t) => ({ u: t.u, til: rund(t.til, 1), min: t.min, pris: rund(t.pris, 3) })) : null,
      });
    }

    const { plan, ledig } = this.fordel(laster, budsjett, prognose, ms);
    const styrtKw = plan.filter((p) => p.handling === 'normal').reduce((s, p) => s + p.effekt, 0);
    const forventetKw = prognose + styrtKw;
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

module.exports = { Motor, STANDARD, TYPER, TREGE, sonefarge };
