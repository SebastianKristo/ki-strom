'use strict';

const Homey = require('homey');
const { SENSORER } = require('../../lib/sensorer');

module.exports = class StromkalkulatorDevice extends Homey.Device {
  async onInit() {
    // Nye sensorer i en senere versjon legges til på enheter som alt finnes.
    for (const id of ['measure_power', ...SENSORER.map((s) => s.id)]) {
      if (!this.hasCapability(id)) await this.addCapability(id).catch(this.error);
    }
    if (this.homey.app.bilde) await this.oppdater(this.homey.app.bilde);
  }

  /** Skriv øyeblikksbildet til sensorene. Bare verdier som faktisk er endret sendes videre. */
  async oppdater(bilde) {
    const sett = async (id, verdi) => {
      const v = verdi === undefined ? null : verdi;
      if (this.hasCapability(id) && this.getCapabilityValue(id) !== v) await this.setCapabilityValue(id, v).catch(this.error);
    };
    await sett('measure_power', bilde.effekt_w);
    for (const s of SENSORER) await sett(s.id, s.hent(bilde));
  }
};
