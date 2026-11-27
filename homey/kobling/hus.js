'use strict';

const { Hus, STANDARD: HUS_STANDARD } = require('../lib/hus');
const { Bereder, STANDARD: VVB_STANDARD } = require('../lib/vvb');
const { Vaner } = require('../lib/vaner');
const hk = require('../lib/hanklevarmer');
const { Lading, STANDARD: LADING_STANDARD } = require('../lib/lading');
const { Lys } = require('../lib/lys');
const { osloDeler } = require('../lib/kalender');

const VARSLES = new Set(['borte_paa', 'kom_hjem', 'kom_ikke', 'legionella', 'legionella_varsel', 'ikke_klar', 'feil']);
const klokke = (ms) => { const d = osloDeler(ms); return `${String(d.time).padStart(2, '0')}:${String(d.minutt).padStart(2, '0')}`; };

/**
 * Koblingen mellom huset (personer, bortemodus, bereder, håndklevarmer — ren logikk i lib/)
 * og Homey: leser hvem som er hjemme, slår releer av og på, og sier fra når noe skjer.
 */
class HusKobling {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this.tilstand = this.homey.settings.get('hus_tilstand') || {};
    for (const k of ['hus', 'vvb', 'vaner', 'lading', 'lys', 'hanklevarmer']) this.tilstand[k] = this.tilstand[k] || {};
    const innst = this.innstillinger();
    this.hus = new Hus(this.tilstand.hus, innst);
    this.bereder = new Bereder(this.tilstand.vvb, innst.vvb);
    this.vaner = new Vaner(this.tilstand.vaner);
    this.lading = new Lading(this.tilstand.lading, innst.lading);
    this.lys = new Lys(this.tilstand.lys, innst.lys);
    this.bilde = null;
    this.sistSkrevet = {};
  }

  innstillinger() {
    const lagret = this.homey.settings.get('hus') || {};
    return {
      ...HUS_STANDARD, ...lagret,
      vvb: { ...VVB_STANDARD, ...(lagret.vvb || {}) },
      hanklevarmer: { ...hk.STANDARD, ...(lagret.hanklevarmer || {}) },
      lading: { ...LADING_STANDARD, ...(lagret.lading || {}) },
      lys: Array.isArray(lagret.lys) ? lagret.lys : [],
    };
  }

  settInnstillinger(endringer) {
    const naa = this.innstillinger();
    const ny = { ...naa };
    for (const k of Object.keys(HUS_STANDARD)) {
      if (endringer && Object.prototype.hasOwnProperty.call(endringer, k)) ny[k] = endringer[k];
    }
    if (endringer && endringer.vvb) ny.vvb = { ...naa.vvb, ...endringer.vvb };
    if (endringer && endringer.hanklevarmer) ny.hanklevarmer = { ...naa.hanklevarmer, ...endringer.hanklevarmer };
    if (endringer && endringer.lading) ny.lading = { ...naa.lading, ...endringer.lading };
    if (endringer && Array.isArray(endringer.lys)) ny.lys = endringer.lys;
    this.homey.settings.set('hus', ny);
    this.hus.settInnstillinger(ny);
    this.bereder.settInnstillinger(ny.vvb);
    this.lading.settInnstillinger(ny.lading);
    this.lys.settRegler(ny.lys);
    return ny;
  }

  lagre() {
    this.homey.settings.set('hus_tilstand', this.tilstand);
  }

  // ------------------------------------------------------------------
  //  Lesing
  // ------------------------------------------------------------------
  static verdi(enheter, kilde) {
    if (!kilde || !kilde.enhet) return null;
    const e = enheter[kilde.enhet];
    const k = e && e.capabilitiesObj && e.capabilitiesObj[kilde.kap];
    return k && k.value !== undefined ? k.value : null;
  }

  /** Hvem er hjemme: {key: true|false|null}. Kilden er en Homey-bruker, en logikkvariabel eller en enhet. */
  async tilstede(enheter) {
    const personer = this.hus.i.personer;
    const typer = new Set(personer.map((p) => p.kilde && p.kilde.type));
    const api = await this.app.api();
    const brukere = typer.has('bruker') ? await api.users.getUsers().catch(() => ({})) : {};
    const variabler = typer.has('variabel') ? await api.logic.getVariables().catch(() => ({})) : {};
    const ut = {};
    for (const p of personer) {
      const k = p.kilde || {};
      let v = null;
      if (k.type === 'bruker' && brukere[k.id]) v = brukere[k.id].present;
      else if (k.type === 'variabel' && variabler[k.id]) v = variabler[k.id].value;
      else if (k.type === 'enhet') v = HusKobling.verdi(enheter, { enhet: k.id, kap: k.kap });
      ut[p.key] = v === true || v === 'home' || v === 'on' ? true : v === false || v === 'not_home' || v === 'off' ? false : null;
    }
    return ut;
  }

  // ------------------------------------------------------------------
  //  Hovedløkke
  // ------------------------------------------------------------------
  /**
   * Kjøres før motoren i hvert tick. Returnerer det motoren trenger:
   * {kontekst, reservertKw, annetStyrtW, vaner}.
   */
  async tick(naa, enheter, motorstatus) {
    const innst = this.innstillinger();
    const hendelser = this.hus.tick(naa, await this.tilstede(enheter), this.vaner);
    const kontekst = this.hus.kontekst(naa, this.vaner);
    kontekst.trangt = motorstatus === 'rod' || motorstatus === 'kritisk';
    kontekst.norgespris = Boolean(this.app.bilde && this.app.bilde.pris && this.app.bilde.pris.norgespris_aktiv);
    kontekst.husinnst = innst;

    // --- Bereder ---
    let reservertKw = 0;
    let annetStyrtW = 0;
    let berederbilde = null;
    if (this.bereder.konfigurert()) {
      const raa = HusKobling.verdi(enheter, innst.vvb.bryter);
      const bryter = raa === null ? null : Boolean(raa);
      const e = HusKobling.verdi(enheter, innst.vvb.effekt);
      const effektW = e === null || !Number.isFinite(Number(e)) ? null : Number(e);
      const r = this.bereder.tick({ ms: naa, bryter, effektW, spot: this.app.spot, kontekst });
      hendelser.push(...r.hendelser);
      berederbilde = r.bilde;
      if (r.paa !== null) await this._bryter(enheter, innst.vvb.bryter, r.paa, 'vvb', naa);
      reservertKw = this.bereder.reservasjon(naa, r.paa ?? bryter, effektW, kontekst).kw;
      if (effektW !== null) { annetStyrtW += effektW; reservertKw = Math.max(0, reservertKw - effektW / 1000); }
    }

    // --- Håndklevarmer ---
    let hanklebilde = null;
    const h = innst.hanklevarmer;
    if (h.styr && h.bryter && h.bryter.enhet) {
      const onske = hk.skalPaa(naa, h, kontekst);
      const raa = HusKobling.verdi(enheter, h.bryter);
      const erPaa = raa === null ? null : Boolean(raa);
      // Settes ved skiftene, ikke fortløpende: det du selv slår av eller på, står til neste skifte.
      const skal = hk.skriv(this.tilstand.hanklevarmer, naa, onske.paa, erPaa);
      if (skal !== null) await this._bryter(enheter, h.bryter, skal, 'hanklevarmer', naa);
      const manuelt = erPaa !== null && erPaa !== onske.paa && skal === null;
      hanklebilde = { paa: erPaa ?? onske.paa, onsket: onske.paa, grunn: manuelt ? `Slått ${erPaa ? 'på' : 'av'} for hånd — står til neste skifte (${onske.grunn.toLowerCase()})` : onske.grunn };
    }

    // --- Elbil: det bilen trekker er styrt last, ikke husets øvrige forbruk ---
    if (this.lading.konfigurert()) {
      const l = this._ladermaalinger(enheter, innst.lading);
      annetStyrtW += this.lading.styrtW(l.pa, l.maaltKw);
    }

    await this._hendelser(hendelser, kontekst);
    const hus = this.hus.bilde(naa, this.vaner);
    this.bilde = {
      ...hus,
      hjemkomst_kl: hus.hjemkomst ? klokke(Date.parse(hus.hjemkomst)) : null,
      bereder: berederbilde,
      hanklevarmer: hanklebilde,
      lading: this.bilde ? this.bilde.lading : null,
      lys: this.bilde ? this.bilde.lys : {},
      vaner: this.vaner.bilde(),
      forslag: this.vaner.forslag({ dagStart: this.app.motor.innstillinger().dagStart, hjemkomstUkedag: innst.hjemkomstUkedag, hjemkomstTid: innst.hjemkomstTid }),
    };
    return { kontekst, reservertKw, annetStyrtW, vaner: this.vaner };
  }

  _ladermaalinger(enheter, l) {
    const tall = (kilde) => { const v = HusKobling.verdi(enheter, kilde); return v === null || !Number.isFinite(Number(v)) ? null : Number(v); };
    const jaNei = (kilde) => { const v = HusKobling.verdi(enheter, kilde); return v === null ? null : Boolean(v); };
    const w = tall(l.effekt);
    return { pa: jaNei(l.bryter), maaltKw: w === null ? null : w / 1000, soc: tall(l.soc), tilkoblet: l.tilkoblet && l.tilkoblet.enhet ? jaNei(l.tilkoblet) : null };
  }

  /**
   * Kjøres etter motoren i hvert tick: bilen får effekten varmen ikke bruker, og lysreglene går.
   * Endrer `motorbilde` så det viser hva ladingen tar.
   */
  async etterMotor(naa, enheter, motorbilde) {
    const innst = this.innstillinger();
    if (this.lading.konfigurert()) {
      const l = this._ladermaalinger(enheter, innst.lading);
      const v = this.lading.vurder({ ms: naa, ledigKw: Math.max(0, motorbilde.ledig_kw ?? 0), ...l });
      let skrevet = true;
      if (v.handling === 'start' || v.handling === 'endre') skrevet = await this._bryter(enheter, innst.lading.strom, v.trinn, 'lading_strom', naa, true);
      if (v.handling === 'start') skrevet = (await this._bryter(enheter, innst.lading.bryter, true, 'lading', naa, true)) && skrevet;
      if (v.handling === 'stopp') skrevet = await this._bryter(enheter, innst.lading.bryter, false, 'lading', naa, true);
      if (skrevet) this.lading.utfort(v, naa);
      this.bilde.lading = { ...v, satt_trinn: this.lading.m.satt_trinn, soc: l.soc, maalt_kw: l.maaltKw };
      motorbilde.lading_kw = v.kw;
      motorbilde.ledig_kw = Math.max(0, Math.round(((motorbilde.ledig_kw ?? 0) - v.kw) * 100) / 100);
    }

    const regler = this.lys.regler;
    if (regler.length) {
      const lys = {};
      for (const r of regler) {
        const e = enheter[r.lys];
        const k = e && e.capabilitiesObj;
        const n = r.naervaer && r.naervaer.enhet ? enheter[r.naervaer.enhet] : null;
        const nk = n && n.capabilitiesObj && n.capabilitiesObj[r.naervaer.kap];
        lys[r.key] = {
          pa: k && k.onoff && k.onoff.value !== undefined && k.onoff.value !== null ? Boolean(k.onoff.value) : null,
          dim: k && k.dim ? Number(k.dim.value) : null,
          dimbar: Boolean(k && k.dim),
          naervaer: nk && nk.value !== null && nk.value !== undefined ? Boolean(nk.value) : null,
          naervaerEndretMs: nk && nk.lastUpdated ? Date.parse(nk.lastUpdated) || null : null,
        };
      }
      const motor = this.app.motor.innstillinger();
      const r = this.lys.tick({ ms: naa, lys, innst: motor });
      for (const h of r.handlinger) {
        const regel = regler.find((x) => x.key === h.key);
        if (h.type === 'av') await this._bryter(enheter, { enhet: regel.lys, kap: 'onoff' }, false, `lys_${h.key}`, naa, true);
        else await this._bryter(enheter, { enhet: regel.lys, kap: 'dim' }, h.verdi, `lys_${h.key}`, naa, true);
      }
      this.bilde.lys = r.status;
    }
  }

  async _bryter(enheter, kilde, paa, navn, naa, alltid = false) {
    const e = kilde && enheter[kilde.enhet];
    if (!e) return false;
    // Skyggemodus gjelder alt appen styrer, ikke bare termostatene.
    const motor = this.app.motor.innstillinger();
    if (motor.skygge || !motor.aktiv) return false;
    const sist = this.sistSkrevet[navn];
    // Releet rekker ikke alltid å melde tilbake på ett minutt. `alltid`: handlingen er alt
    // vurdert mot forrige tilstand (lading, lys), så samme verdi kan trygt sendes igjen.
    if (!alltid && sist && sist.verdi === paa && naa - sist.ms < 3 * 60000) return false;
    this.sistSkrevet[navn] = { verdi: paa, ms: naa };
    const tekst = typeof paa === 'boolean' ? (paa ? 'på' : 'av') : String(paa);
    try {
      await e.setCapabilityValue({ capabilityId: kilde.kap || 'onoff', value: paa });
      this.app.log(`${e.name}: ${tekst}`);
      return true;
    } catch (feil) {
      this.app.log(`Kunne ikke sette ${e.name} til ${tekst}: ${feil.message}`);
      return false;
    }
  }

  async _hendelser(hendelser, kontekst) {
    const u = this.app.utloser;
    for (const h of hendelser) {
      this.app.log(h.tekst);
      if (VARSLES.has(h.type)) this.homey.notifications.createNotification({ excerpt: `KI Energi: ${h.tekst}` }).catch(() => {});
      if (h.type === 'borte_paa') u.bortemodus_endret.trigger({ borte: true }).catch(this.app.error);
      if (h.type === 'kom_hjem') { u.noen_kom_hjem.trigger({}).catch(this.app.error); u.bortemodus_endret.trigger({ borte: false }).catch(this.app.error); }
      if (h.type === 'mettet') u.bereder_varm.trigger({}).catch(this.app.error);
      if (h.type === 'ikke_klar') u.bereder_ikke_klar.trigger({ grunn: h.tekst }).catch(this.app.error);
    }
    if (hendelser.length) this.lagre();
    return kontekst;
  }

  // ------------------------------------------------------------------
  //  Handlinger
  // ------------------------------------------------------------------
  settBorte(paa) {
    const var_ = this.hus.t.borte;
    this.hus.settBorte(paa, Date.now());
    if (var_ !== Boolean(paa)) this.app.utloser.bortemodus_endret.trigger({ borte: Boolean(paa) }).catch(this.app.error);
    this.lagre();
  }

  settHjemkomst(naar) {
    const tid = this.hus.settHjemkomst(naar, Date.now());
    this.lagre();
    return new Date(tid).toISOString();
  }

  forleng() { this.hus.forleng(Date.now()); this.lagre(); }

  berederHandling(handling, minutter) {
    if (handling === 'boost') this.bereder.boost(Date.now(), Number(minutter) || 60);
    else if (handling === 'avbryt') this.bereder.avbrytBoost(Date.now());
    else if (handling === 'tving') this.bereder.tvingSyklus();
    else throw new Error(`Ukjent handling: ${handling}`);
    this.lagre();
  }

  // ------------------------------------------------------------------
  //  Oppsett
  // ------------------------------------------------------------------
  /** Det en person kan følge: Homey-brukere og logikkvariabler som er ja/nei. */
  async personkilder() {
    const api = await this.app.api();
    const brukere = await api.users.getUsers().catch(() => ({}));
    const variabler = await api.logic.getVariables().catch(() => ({}));
    return [
      ...Object.values(brukere).map((b) => ({ type: 'bruker', id: b.id, navn: `${b.name} (Homey-bruker)`, verdi: b.present })),
      ...Object.values(variabler).filter((v) => v.type === 'boolean').map((v) => ({ type: 'variabel', id: v.id, navn: `${v.name} (variabel)`, verdi: v.value })),
    ].sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }

  /** Alle enheter med det de kan måle og styre — til oppsettet av lader og lys. */
  async alleEnheter() {
    const api = await this.app.api();
    const enheter = await api.devices.getDevices();
    return Object.values(enheter)
      .filter((e) => !(e.driverId || '').includes(this.app.manifest.id))
      .map((e) => ({
        id: e.id, navn: e.name, klasse: e.class,
        kap: Object.entries(e.capabilitiesObj || {}).map(([id, k]) => ({ id, type: k.type, kanSettes: Boolean(k.setable), verdi: k.value ?? null })),
      }))
      .sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }

  /** Enheter som kan slås av og på, med effektmåling hvis de har det. */
  async brytere() {
    const api = await this.app.api();
    const enheter = await api.devices.getDevices();
    return Object.values(enheter)
      .filter((e) => (e.capabilities || []).includes('onoff') && !(e.capabilities || []).includes('target_temperature') && e.class !== 'light')
      .map((e) => ({ id: e.id, navn: e.name, harEffekt: e.capabilities.includes('measure_power') }))
      .sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }
}

module.exports = { HusKobling };
