'use strict';

const { Motor, STANDARD } = require('../lib/motor');
const { Vaer, hent: hentVaer } = require('../lib/vaer');

const TREG_NAVN = /gulv|varmekabel|floor/i;
const VANNBAAREN_NAVN = /oljefyr|radiator|vannb/i;
const VARMEPUMPE_NAVN = /varmepumpe|heat ?pump|aircondition/i;

/** Nøkkel fra et navn: «Kjøkken gulv» → «kjokken_gulv». */
const nokkel = (navn) => String(navn).toLowerCase()
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'rom';

/**
 * Koblingen mellom effektmotoren (ren logikk i lib/motor.js) og Homey: leser termostatene,
 * skriver settpunkter, henter værvarsel og holder motorens innstillinger og tilstand lagret.
 */
class MotorKobling {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this.tilstand = this.homey.settings.get('motor_tilstand') || {};
    this.motor = new Motor(this.tilstand, this.innstillinger());
    this.vaer = new Vaer(...(this.homey.settings.get('vaer') || [[], 0]));
    this.bilde = null;
    this.sistSkrevet = {};      // key → {verdi, ms}
  }

  innstillinger() {
    return { ...STANDARD, ...(this.homey.settings.get('motor') || {}) };
  }

  /** Lagre endringer i motorens innstillinger (bare nøklene som er med). */
  settInnstillinger(endringer) {
    const ny = { ...this.innstillinger() };
    for (const k of Object.keys(STANDARD).concat(['ute'])) {
      if (endringer && Object.prototype.hasOwnProperty.call(endringer, k)) ny[k] = endringer[k];
    }
    this.homey.settings.set('motor', ny);
    this.motor.settInnstillinger(ny);
    return ny;
  }

  lagre() {
    this.homey.settings.set('motor_tilstand', this.tilstand);
  }

  // ------------------------------------------------------------------
  //  Lesing
  // ------------------------------------------------------------------
  static verdi(enheter, kilde) {
    if (!kilde || !kilde.enhet) return null;
    const e = enheter[kilde.enhet];
    const k = e && e.capabilitiesObj && e.capabilitiesObj[kilde.kap];
    const v = k ? Number(k.value) : NaN;
    return Number.isFinite(v) ? v : null;
  }

  /** Målingene motoren trenger for hvert rom: {key: {temp, settpunkt, effektW, levende}}. */
  maalinger(enheter) {
    const ut = {};
    for (const s of this.motor.soner()) {
      const termostater = (s.termostater || []).map((id) => enheter[id]).filter(Boolean);
      const levende = termostater.length > 0 && termostater.some((e) => e.available !== false);
      const forste = termostater[0];
      let temp = MotorKobling.verdi(enheter, s.temp);
      if (temp === null && forste) temp = MotorKobling.verdi(enheter, { enhet: forste.id, kap: 'measure_temperature' });
      const settpunkt = forste ? MotorKobling.verdi(enheter, { enhet: forste.id, kap: 'target_temperature' }) : null;
      const effekter = (s.effekt || []).map((k) => MotorKobling.verdi(enheter, k)).filter((v) => v !== null);
      ut[s.key] = { temp, settpunkt, effektW: effekter.length ? effekter.reduce((a, b) => a + b, 0) : null, levende };
    }
    return ut;
  }

  // ------------------------------------------------------------------
  //  Hovedløkke
  // ------------------------------------------------------------------
  async tick(naa) {
    const innst = this.innstillinger();
    const api = await this.app.api();
    const enheter = await api.devices.getDevices();
    const kalkBilde = this.app.bilde;
    this.bilde = this.motor.tick({
      ms: naa,
      kalk: this.app.kalkulator,
      spot: this.app.spot,
      vaer: this.vaer,
      uteMaalt: MotorKobling.verdi(enheter, innst.ute),
      totalW: this.app.siste.effekt,
      timeKwh: kalkBilde && kalkBilde.time ? kalkBilde.time.kwh : null,
      maalinger: this.maalinger(enheter),
    });
    await this._skriv(enheter, naa);
    return this.bilde;
  }

  /** Skriv settpunktene motoren vil ha. Klemmes til termostatens egne grenser. */
  async _skriv(enheter, naa) {
    const soner = Object.fromEntries(this.motor.soner().map((s) => [s.key, s]));
    for (const { key, settpunkt } of Motor.skriveliste(this.bilde)) {
      const sist = this.sistSkrevet[key];
      // Samme verdi skrives ikke på nytt før det har gått ti minutter — termostaten kan være treg med å melde tilbake.
      if (sist && sist.verdi === settpunkt && naa - sist.ms < 10 * 60000) continue;
      for (const id of soner[key].termostater || []) {
        const e = enheter[id];
        const kap = e && e.capabilitiesObj && e.capabilitiesObj.target_temperature;
        if (!kap) continue;
        const verdi = Math.min(kap.max ?? 35, Math.max(kap.min ?? 5, settpunkt));
        try {
          await e.setCapabilityValue({ capabilityId: 'target_temperature', value: verdi });
        } catch (feil) {
          this.app.log(`Kunne ikke sette ${e.name} til ${verdi} °C: ${feil.message}`);
        }
      }
      this.sistSkrevet[key] = { verdi: settpunkt, ms: naa };
    }
  }

  async hentVaer(naa) {
    const lat = this.homey.geolocation.getLatitude();
    const lon = this.homey.geolocation.getLongitude();
    const brukeragent = `KI-Energi-Homey/${this.app.manifest.version} github.com/SebastianKristo/ki-strom`;
    const antall = await hentVaer(this.vaer, lat, lon, naa, (adresse, valg) => fetch(adresse, valg), brukeragent);
    if (antall) {
      this.homey.settings.set('vaer', [this.vaer.punkter.slice(0, 72), this.vaer.hentetMs]);
      this.app.log(`Hentet værvarsel: ${antall} punkter`);
    }
  }

  // ------------------------------------------------------------------
  //  Oppsett
  // ------------------------------------------------------------------
  /** Termostatene i Homey, med sone og hva de kan måle. */
  async termostater() {
    const api = await this.app.api();
    const enheter = await api.devices.getDevices();
    const soner = await api.zones.getZones().catch(() => ({}));
    return Object.values(enheter)
      .filter((e) => (e.capabilities || []).includes('target_temperature'))
      .map((e) => ({
        id: e.id, navn: e.name, sone: (soner[e.zone] && soner[e.zone].name) || 'Uten sone',
        harTemp: e.capabilities.includes('measure_temperature'), harEffekt: e.capabilities.includes('measure_power'),
        klasse: e.class,
      }))
      .sort((a, b) => a.sone.localeCompare(b.sone, 'no') || a.navn.localeCompare(b.navn, 'no'));
  }

  /** Temperatursensorer som kan være utetemperatur. */
  async temperatursensorer() {
    const api = await this.app.api();
    const enheter = await api.devices.getDevices();
    return Object.values(enheter)
      .filter((e) => (e.capabilities || []).includes('measure_temperature') && !(e.capabilities || []).includes('target_temperature'))
      .map((e) => ({ id: e.id, navn: e.name, verdi: MotorKobling.verdi(enheter, { enhet: e.id, kap: 'measure_temperature' }) }))
      .sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }

  /**
   * Forslag til rom: ett per Homey-sone som har termostater. Rom som alt er satt opp
   * beholder innstillingene sine; bare termostatlista oppdateres.
   */
  async forslag() {
    const termostater = await this.termostater();
    const eksisterende = Object.fromEntries(this.innstillinger().soner.map((s) => [s.key, s]));
    const grupper = new Map();
    for (const t of termostater) {
      if (t.klasse === 'car' || /bil|car|tesla/i.test(t.navn)) continue;      // bilens klima er ikke et rom
      if (!grupper.has(t.sone)) grupper.set(t.sone, []);
      grupper.get(t.sone).push(t);
    }
    const ut = [];
    for (const [sone, liste] of grupper) {
      const key = nokkel(sone);
      const navnene = liste.map((t) => t.navn).join(' ');
      const type = VARMEPUMPE_NAVN.test(navnene) ? 'varmepumpe' : liste.every((t) => TREG_NAVN.test(t.navn)) ? 'gulv' : VANNBAAREN_NAVN.test(navnene) && liste.length === 1 ? 'vannbaaren' : 'panel';
      const bad = /bad|dusj/i.test(sone);
      const sjelden = /\bdo\b|toalett|vaskerom|vaskegang|bod|gang/i.test(sone) && !/trappegang/i.test(sone);
      const ny = {
        key, navn: sone, type, prio: bad ? 2 : sjelden ? 4 : 3,
        nominell: Math.round(liste.length * (type === 'gulv' ? 0.6 : 1.0) * 10) / 10,
        profil: bad ? 'konstant' : sjelden ? 'sjelden' : 'fellesrom',
        dag: bad ? 24 : sjelden ? 20 : 22, natt: bad ? 24 : sjelden ? 18 : 19,
        aktiv: true, styrt: true,
        ...(eksisterende[key] || {}),
        termostater: liste.map((t) => t.id),
        termostatnavn: liste.map((t) => t.navn),
        effekt: liste.filter((t) => t.harEffekt).map((t) => ({ enhet: t.id, kap: 'measure_power' })),
      };
      if (!ny.temp) {
        const medTemp = liste.find((t) => t.harTemp);
        ny.temp = medTemp ? { enhet: medTemp.id, kap: 'measure_temperature' } : null;
      }
      ut.push(ny);
    }
    return ut.sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }

  overstyr(key, temp, minutter) {
    if (!this.motor.soner().some((s) => s.key === key)) throw new Error(`Ukjent rom: ${key}`);
    this.motor.overstyr(key, temp, minutter || 120, Date.now());
    this.lagre();
  }

  fjernOverstyring(key) {
    this.motor.fjernOverstyring(key || null);
    this.lagre();
  }
}

module.exports = { MotorKobling, nokkel };
