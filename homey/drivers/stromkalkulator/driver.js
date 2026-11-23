'use strict';

const Homey = require('homey');

/** Én virtuell enhet som viser alt strømkalkulatoren regner ut. */
module.exports = class StromkalkulatorDriver extends Homey.Driver {
  async onPairListDevices() {
    return [{ name: this.homey.__('enhet.navn'), data: { id: 'stromkalkulator' } }];
  }
};
