'use strict';

/**
 * Appens lokale API: http://<homey>/api/app/no.kristo.kienergi/<sti>
 *
 * Brukes av innstillingssiden, og av Home Assistant i «kontrollversjon» (med en API-nøkkel
 * fra Homey som Bearer-token). Alt her er en tynn inngang til app.js.
 */

const NOKLER = ['nettselskap', 'boligtype', 'harNorgespris', 'avgiftssone', 'sikringstrinn', 'varselTerskelKw',
  'energileddDagEksMva', 'energileddNattEksMva', 'egneTrinn', 'prisomraade',
  'maalerEnhet', 'effektKapabilitet', 'energiKapabilitet'];

module.exports = {
  async status({ homey }) {
    return homey.app.status();
  },

  async priser({ homey }) {
    return homey.app.priser();
  },

  async nettselskap({ homey }) {
    return homey.app.nettselskap();
  },

  async enheter({ homey }) {
    return homey.app.maalere();
  },

  async hentInnstillinger({ homey }) {
    return homey.app.innstillinger();
  },

  async motor({ homey }) {
    return homey.app.motor.bilde || { status: 'starter', soner: [] };
  },

  async hentMotorinnstillinger({ homey }) {
    return homey.app.motor.innstillinger();
  },

  async settMotorinnstillinger({ homey, body }) {
    return homey.app.motor.settInnstillinger(body || {});
  },

  async termostater({ homey }) {
    return homey.app.motor.termostater();
  },

  async temperatursensorer({ homey }) {
    return homey.app.motor.temperatursensorer();
  },

  async romforslag({ homey }) {
    return homey.app.motor.forslag();
  },

  /** body: { rom, temp, minutter } */
  async overstyr({ homey, body }) {
    homey.app.motor.overstyr(body.rom, Number(body.temp), Number(body.minutter) || 120);
    return { ok: true };
  },

  /** body: { rom } — uten rom fjernes alle overstyringer. */
  async fjernOverstyring({ homey, body }) {
    homey.app.motor.fjernOverstyring(body && body.rom);
    return { ok: true };
  },

  async hus({ homey }) {
    return homey.app.hus.bilde || { modus: 'starter', personer: [] };
  },

  async hentHusinnstillinger({ homey }) {
    return homey.app.hus.innstillinger();
  },

  async settHusinnstillinger({ homey, body }) {
    return homey.app.hus.settInnstillinger(body || {});
  },

  async personkilder({ homey }) {
    return homey.app.hus.personkilder();
  },

  async brytere({ homey }) {
    return homey.app.hus.brytere();
  },

  /** body: { paa } */
  async bortemodus({ homey, body }) {
    homey.app.hus.settBorte(Boolean(body && body.paa));
    return { ok: true };
  },

  /** body: { tid } — «HH:MM» (neste gang det inntreffer) eller et tidspunkt i millisekunder. */
  async hjemkomst({ homey, body }) {
    return { hjemkomst: homey.app.hus.settHjemkomst(body.tid) };
  },

  async forleng({ homey }) {
    homey.app.hus.forleng();
    return { ok: true };
  },

  /** body: { handling: 'boost' | 'avbryt' | 'tving', minutter } */
  async bereder({ homey, body }) {
    homey.app.hus.berederHandling(body.handling, body.minutter);
    return { ok: true };
  },

  /** Bare kjente nøkler tas imot; resten av innstillingene står urørt. */
  async settInnstillinger({ homey, body }) {
    const ny = { ...homey.app.innstillinger() };
    for (const k of NOKLER) {
      if (body && Object.prototype.hasOwnProperty.call(body, k)) ny[k] = body[k];
    }
    homey.settings.set('innstillinger', ny);
    return ny;
  },
};
