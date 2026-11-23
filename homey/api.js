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
