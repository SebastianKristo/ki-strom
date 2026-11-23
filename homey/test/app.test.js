'use strict';

/**
 * Starter app.js, enheten og API-et mot en etterlignet Homey. Fanger feil i koblingskoden
 * (innstillinger, måler, flow, enhet) som de rene testene i lib/ ikke ser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const kal = require('../lib/kalender');
const { SENSORER } = require('../lib/sensorer');
const manifest = require('../app.json');

class Grunn { log() {} error(...a) { throw new Error(`appen logget en feil: ${a.join(' ')}`); } }
const falskHomey = { App: class extends Grunn {}, Driver: class extends Grunn {}, Device: class extends Grunn {} };

const ekteLast = Module._load;
Module._load = function last(navn, ...rest) {
  if (navn === 'homey') return falskHomey;
  if (navn === 'homey-api') return { HomeyAPI: { createAppAPI: async ({ homey }) => homey.falskApi } };
  return ekteLast.call(this, navn, ...rest);
};
test.after(() => { Module._load = ekteLast; });

function lagHomey(innstillinger) {
  const lager = { innstillinger };
  const lyttere = [];
  const utlost = [];
  const maaler = {
    id: 'maaler1', name: 'Strømmåler', zone: 'z1', driverId: 'homey:app:no.annen:han',
    capabilities: ['measure_power', 'meter_power'],
    capabilitiesObj: { measure_power: { value: 2400 }, meter_power: { value: 166682.27 } },
    lyttere: {},
    makeCapabilityInstance(kap, cb) {
      this.lyttere[kap] = cb;
      return { value: this.capabilitiesObj[kap].value, destroy() {} };
    },
  };
  const homey = {
    maaler,
    utlost,
    settings: {
      get: (k) => lager[k],
      set: (k, v) => { lager[k] = JSON.parse(JSON.stringify(v)); lyttere.forEach((f) => f(k)); },
      on: (hendelse, f) => lyttere.push(f),
    },
    setInterval: () => 0,
    flow: {
      getTriggerCard: (id) => ({ trigger: async (tokens) => { utlost.push([id, tokens]); } }),
      getConditionCard: (id) => ({ registerRunListener: (f) => { homey.betingelser[id] = f; } }),
    },
    betingelser: {},
    enheter: [],
    drivers: { getDriver: () => ({ getDevices: () => homey.enheter }) },
    falskApi: {
      devices: { getDevices: async () => ({ maaler1: maaler }), getDevice: async () => maaler },
      zones: { getZones: async () => ({ z1: { name: 'Gang' } }) },
    },
    __: (k) => k,
  };
  return homey;
}

test('appen starter, leser måleren, fyller enheten og svarer på API-et', async (t) => {
  const naa = kal.osloTilUtc(2026, 11, 23, 12, 0);
  t.mock.timers.enable({ apis: ['Date'], now: naa });
  const dato = (ms) => new Date(ms).toISOString();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => Array.from({ length: 24 }, (_, n) => {
      const a = kal.osloTilUtc(2026, 11, 23) + n * 3600000;
      return { NOK_per_kWh: 1.0, time_start: dato(a), time_end: dato(a + 3600000) };
    }),
  }));

  const KiEnergiApp = require('../app');
  const Device = require('../drivers/stromkalkulator/device');
  const Driver = require('../drivers/stromkalkulator/driver');
  const api = require('../api');

  const homey = lagHomey({ nettselskap: 'elvia', maalerEnhet: 'maaler1', effektKapabilitet: 'measure_power', energiKapabilitet: 'meter_power' });
  const app = new KiEnergiApp();
  app.homey = homey;
  app.manifest = manifest;
  homey.app = app;
  await app.onInit();

  // Enheten får alle sensorene
  const verdier = {};
  const enhet = new Device();
  enhet.homey = homey;
  enhet.hasCapability = () => true;
  enhet.addCapability = async () => {};
  enhet.getCapabilityValue = (id) => verdier[id];
  enhet.setCapabilityValue = async (id, v) => { verdier[id] = v; };
  homey.enheter.push(enhet);
  await enhet.onInit();
  assert.equal(verdier.measure_power, 2400);
  assert.equal(verdier.ki_tariff, 'dag');
  assert.equal(verdier.ki_kapasitetsledd, 150);
  assert.ok(Math.abs(verdier.ki_spotpris - 1.25) < 1e-9);
  assert.equal(verdier.ki_maleproblem, false);
  for (const s of SENSORER) assert.ok(s.id in verdier, `${s.id} ble ikke satt`);

  // Måleren går: 3 kWh på en time
  t.mock.timers.setTime(naa + 3600000 + 10000);
  homey.maaler.lyttere.meter_power(166685.27);
  app._tick();
  assert.equal(app.status().maaned.kwh, 3);
  // Første prøve kom på hel time, så timen 12–13 er en hel, målt time: flow-kortet utløses.
  assert.deepEqual(homey.utlost.filter(([id]) => id === 'time_lukket').map(([, tok]) => tok), [{ kwh: 3, ny_topp: true }]);
  assert.equal(app.status().nettleie.topper[0].kw, 3);

  // API-et
  assert.equal((await api.status({ homey })).nettselskap, 'Elvia');
  assert.equal((await api.priser({ homey })).prisomraade, 'NO1');
  assert.ok((await api.nettselskap({ homey })).some((n) => n.id === 'elvia'));
  assert.deepEqual((await api.enheter({ homey }))[0].sone, 'Gang');
  const ny = await api.settInnstillinger({ homey, body: { harNorgespris: true, ukjent: 'x' } });
  assert.equal(ny.harNorgespris, true);
  assert.equal(ny.ukjent, undefined);
  assert.equal(ny.maalerEnhet, 'maaler1');
  await new Promise((r) => setImmediate(r));
  app._tick();
  assert.equal(app.status().pris.norgespris_aktiv, true);
  assert.equal(await homey.betingelser.norgespris_aktiv({}), true);
  assert.equal(await homey.betingelser.totalpris_over({ grense: 5 }), false);

  // Paring og lagring
  const driver = new Driver();
  driver.homey = homey;
  assert.equal((await driver.onPairListDevices()).length, 1);
  await app.onUninit();
  assert.equal(homey.settings.get('tilstand').maaned, '2026-11');
});

test('app.json er bygget fra tabellene', () => {
  assert.deepEqual(manifest.drivers[0].capabilities, ['measure_power', ...SENSORER.map((s) => s.id)]);
  for (const s of SENSORER) assert.ok(manifest.capabilities[s.id], s.id);
  const api = require('../api');
  assert.deepEqual(Object.keys(manifest.api).sort(), Object.keys(api).sort());
  assert.equal(path.basename(manifest.images.small), 'small.png');
});
