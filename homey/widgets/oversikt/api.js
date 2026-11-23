'use strict';

/** Det oversikts-widgeten viser: ett sammendrag av strømkalkulatoren, motoren og huset. */
module.exports = {
  async oversikt({ homey }) {
    const k = homey.app.status();
    const m = homey.app.motor.bilde;
    const h = homey.app.hus.bilde;
    return {
      status: m ? m.status : 'av',
      forklaring: m ? m.forklaring : 'Motoren har ikke regnet ennå.',
      skygge: Boolean(m && m.skygge),
      time: m ? { brukt: m.budsjett.forbrukt, forventet: m.forventet_time_kwh, grense: m.budsjett.grense } : null,
      pris: k.pris.total,
      tariff: k.nettleie.tariff,
      trinn: k.nettleie.kapasitetstrinn,
      margin: k.nettleie.margin_kw,
      maaned: { kwh: k.maaned.kwh, kr: k.maaned.kostnad_kr, estimert: k.maaned.estimert_kr },
      modus: h ? h.modus : null,
      hjemkomst: h ? h.hjemkomst_kl : null,
      bereder: h && h.bereder ? h.bereder.status : null,
      rom: m ? m.soner.map((p) => ({ navn: p.navn, temp: p.temp, settpunkt: p.settpunkt, handling: p.handling, forklaring: p.forklaring })) : [],
    };
  },
};
