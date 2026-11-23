'use strict';

const Homey = require('homey');

/** Én virtuell enhet som viser hva effektmotoren gjør, med bryter for motoren og skyggemodus. */
module.exports = class EnergimotorDriver extends Homey.Driver {
  async onPairListDevices() {
    return [{ name: this.homey.__('motor.navn'), data: { id: 'energimotor' } }];
  }
};
