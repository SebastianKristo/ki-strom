'use strict';

const Homey = require('homey');
const { MOTOR_SENSORER } = require('../../lib/sensorer');

module.exports = class EnergimotorDevice extends Homey.Device {
  async onInit() {
    for (const id of ['onoff', 'ki_skyggemodus', 'measure_temperature', ...MOTOR_SENSORER.map((s) => s.id)]) {
      if (!this.hasCapability(id)) await this.addCapability(id).catch(this.error);
    }
    const kobling = this.homey.app.motor;
    this.registerCapabilityListener('onoff', async (verdi) => { kobling.settInnstillinger({ aktiv: Boolean(verdi) }); });
    this.registerCapabilityListener('ki_skyggemodus', async (verdi) => { kobling.settInnstillinger({ skygge: Boolean(verdi) }); });
    if (kobling.bilde) await this.oppdater(kobling.bilde);
  }

  async oppdater(bilde) {
    const sett = async (id, verdi) => {
      const v = verdi === undefined ? null : verdi;
      if (this.hasCapability(id) && this.getCapabilityValue(id) !== v) await this.setCapabilityValue(id, v).catch(this.error);
    };
    await sett('onoff', bilde.aktiv);
    await sett('ki_skyggemodus', bilde.skygge);
    await sett('measure_temperature', bilde.ute);
    for (const s of MOTOR_SENSORER) await sett(s.id, s.hent(bilde));
  }
};
