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
  const skrevet = [];
  const termostat = (id, navn, sone, temp, settpunkt, effekt) => ({
    id, name: navn, zone: sone, class: 'thermostat', available: true, driverId: 'homey:app:no.annen:ovn',
    capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
    capabilitiesObj: { target_temperature: { value: settpunkt, min: 5, max: 30 }, measure_temperature: { value: temp }, measure_power: { value: effekt } },
    async setCapabilityValue({ capabilityId, value }) { skrevet.push([id, capabilityId, value]); this.capabilitiesObj[capabilityId].value = value; },
  });
  const enheterIHomey = {
    maaler1: maaler,
    ovn1: termostat('ovn1', 'Stue Panelovn', 'z2', 20.5, 19, 900),
    ovn2: termostat('ovn2', 'Stue Oljefyr', 'z2', 20.5, 19, 600),
    gulv1: termostat('gulv1', 'Bad Gulvvarme', 'z3', 24.5, 24, 0),
    bil: { ...termostat('bil', 'Bil klima', 'z1', 3, 20, 0), class: 'car' },
    ute1: { id: 'ute1', name: 'Outdoor Meter', zone: 'z1', capabilities: ['measure_temperature'], capabilitiesObj: { measure_temperature: { value: -3.3 } } },
    vvb: {
      id: 'vvb', name: 'Varmtvannsbereder', zone: 'z3', class: 'socket', capabilities: ['onoff', 'measure_power'],
      capabilitiesObj: { onoff: { value: true }, measure_power: { value: 0 } },
      async setCapabilityValue({ capabilityId, value }) { skrevet.push(['vvb', capabilityId, value]); this.capabilitiesObj[capabilityId].value = value; },
    },
  };
  const variabler = { v1: { id: 'v1', name: 'Rune Posisjon', type: 'boolean', value: true }, v2: { id: 'v2', name: 'Teller', type: 'number', value: 3 } };
  const varsler = [];
  const homey = {
    maaler,
    utlost,
    skrevet,
    enheterIHomey,
    variabler,
    varsler,
    notifications: { createNotification: async (v) => { varsler.push(v.excerpt); } },
    geolocation: { getLatitude: () => 59.91, getLongitude: () => 10.75 },
    settings: {
      get: (k) => lager[k],
      set: (k, v) => { lager[k] = JSON.parse(JSON.stringify(v)); lyttere.forEach((f) => f(k)); },
      on: (hendelse, f) => lyttere.push(f),
    },
    setInterval: () => 0,
    flow: {
      getTriggerCard: (id) => ({ trigger: async (tokens) => { utlost.push([id, tokens]); } }),
      getConditionCard: (id) => ({ registerRunListener: (f) => { homey.betingelser[id] = f; } }),
      getActionCard: (id) => ({
        registerRunListener: (f) => { homey.handlinger[id] = f; },
        registerArgumentAutocompleteListener: (navn, f) => { homey.autofullfor[id] = f; },
      }),
    },
    betingelser: {},
    handlinger: {},
    autofullfor: {},
    enheter: [],
    motorenheter: [],
    drivers: { getDriver: (id) => ({ getDevices: () => (id === 'energimotor' ? homey.motorenheter : homey.enheter) }) },
    falskApi: {
      devices: { getDevices: async () => enheterIHomey, getDevice: async () => maaler },
      zones: { getZones: async () => ({ z1: { name: 'Gang' }, z2: { name: 'Stue' }, z3: { name: 'Bad' } }) },
      users: { getUsers: async () => ({ u1: { id: 'u1', name: 'Sebastian', present: false } }) },
      logic: { getVariables: async () => variabler },
    },
    __: (k) => k,
  };
  return homey;
}

test('appen starter, leser måleren, fyller enheten og svarer på API-et', async (t) => {
  const naa = kal.osloTilUtc(2026, 11, 23, 12, 0);
  t.mock.timers.enable({ apis: ['Date'], now: naa });
  const dato = (ms) => new Date(ms).toISOString();
  const hentet = [];
  t.mock.method(globalThis, 'fetch', async (url, valg) => {
    hentet.push([url, valg]);
    if (url.includes('api.met.no')) {
      return { ok: true, json: async () => ({ properties: { timeseries: Array.from({ length: 48 }, (_, n) => ({
        time: dato(naa + n * 3600000), data: { instant: { details: { air_temperature: -4 } } } })) } }) };
    }
    return {
      ok: true,
      json: async () => Array.from({ length: 24 }, (_, n) => {
        const a = kal.osloTilUtc(2026, 11, 23) + n * 3600000;
        return { NOK_per_kWh: 1.0, time_start: dato(a), time_end: dato(a + 3600000) };
      }),
    };
  });

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
  assert.deepEqual((await api.enheter({ homey })).find((e) => e.id === 'maaler1').sone, 'Gang');
  const ny = await api.settInnstillinger({ homey, body: { harNorgespris: true, ukjent: 'x' } });
  assert.equal(ny.harNorgespris, true);
  assert.equal(ny.ukjent, undefined);
  assert.equal(ny.maalerEnhet, 'maaler1');
  await new Promise((r) => setImmediate(r));
  app._tick();
  assert.equal(app.status().pris.norgespris_aktiv, true);
  assert.equal(await homey.betingelser.norgespris_aktiv({}), true);
  assert.equal(await homey.betingelser.totalpris_over({ grense: 5 }), false);

  // --- Energimotoren ---
  const vent = () => new Promise((r) => setImmediate(r));
  await vent();
  const met = hentet.find(([url]) => url.includes('api.met.no'));
  assert.match(met[1].headers['User-Agent'], /KI-Energi-Homey/);
  assert.equal(app.motor.vaer.punkter.length, 48);

  // Forslag: ett rom per Homey-sone med termostater; bilen er ikke et rom
  const forslag = await api.romforslag({ homey });
  assert.deepEqual(forslag.map((r) => r.key), ['bad', 'stue']);
  const stue = forslag.find((r) => r.key === 'stue');
  assert.deepEqual(stue.termostater, ['ovn2', 'ovn1']);     // sortert på navn: Oljefyr, Panelovn
  assert.equal(stue.effekt.length, 2);
  assert.equal(forslag.find((r) => r.key === 'bad').profil, 'konstant');
  assert.deepEqual((await api.temperatursensorer({ homey })).map((x) => x.id), ['ute1']);
  assert.equal((await api.termostater({ homey })).length, 4);
  assert.ok(!(await api.enheter({ homey })).some((e) => e.id === 'bil' && false));

  // Skyggemodus er standard: motoren regner, men rører ingenting
  await api.settMotorinnstillinger({ homey, body: { soner: forslag, ute: { enhet: 'ute1', kap: 'measure_temperature' } } });
  await app._motorTick(Date.now());
  let m = await api.motor({ homey });
  assert.equal(m.skygge, true);
  assert.equal(m.ute, -3.3);
  assert.equal(m.styrt_w, 1500);
  assert.equal(m.soner.find((p) => p.key === 'stue').mal, 22);
  assert.deepEqual(homey.skrevet, []);

  // Enheten «Energimotor» viser bildet, og bryteren for skyggemodus slår den av
  const Motorenhet = require('../drivers/energimotor/device');
  const mv = {};
  const lyttere = {};
  const me = new Motorenhet();
  me.homey = homey;
  me.hasCapability = () => true;
  me.addCapability = async () => {};
  me.getCapabilityValue = (id) => mv[id];
  me.setCapabilityValue = async (id, v) => { mv[id] = v; };
  me.registerCapabilityListener = (id, f) => { lyttere[id] = f; };
  homey.motorenheter.push(me);
  await me.onInit();
  assert.equal(mv.ki_skyggemodus, true);
  assert.equal(mv.measure_temperature, -3.3);
  assert.equal(typeof mv.ki_motor_forklaring, 'string');
  await lyttere.ki_skyggemodus(false);
  await app._motorTick(Date.now());
  // Stua (begge ovnene) settes til 22; badet står alt på 24
  assert.deepEqual(homey.skrevet, [['ovn2', 'target_temperature', 22], ['ovn1', 'target_temperature', 22]]);
  await app._motorTick(Date.now());
  assert.equal(homey.skrevet.length, 2, 'samme settpunkt skrives ikke på nytt');

  // Overstyring fra flow-kort og API
  assert.deepEqual(await homey.autofullfor.overstyr_rom('st'), [{ name: 'Stue', id: 'stue' }]);
  await homey.handlinger.overstyr_rom({ rom: { id: 'stue' }, temp: 24, minutter: 30 });
  await app._motorTick(Date.now());
  assert.deepEqual(homey.skrevet.slice(2), [['ovn2', 'target_temperature', 24], ['ovn1', 'target_temperature', 24]]);
  await api.fjernOverstyring({ homey, body: { rom: 'stue' } });
  await assert.rejects(async () => api.overstyr({ homey, body: { rom: 'finnes_ikke', temp: 20 } }), /Ukjent rom/);
  m = (await app.motor.tick(Date.now()));
  assert.equal(m.soner.find((p) => p.key === 'stue').mal, 22);
  assert.equal(await homey.betingelser.motor_status_er({ status: m.status }), true);
  await homey.handlinger.sett_skyggemodus({ modus: 'paa' });
  assert.equal(app.motor.innstillinger().skygge, true);

  // --- Huset: personer, bortemodus og bereder ---
  assert.deepEqual((await api.personkilder({ homey })).map((k) => `${k.type}:${k.id}`), ['variabel:v1', 'bruker:u1']);
  assert.deepEqual((await api.brytere({ homey })).map((b) => b.id), ['vvb']);
  homey.skrevet.length = 0;
  await api.settHusinnstillinger({ homey, body: {
    personer: [{ key: 'rune', navn: 'Rune', type: 'voksen', kilde: { type: 'variabel', id: 'v1' } },
      { key: 'sebastian', navn: 'Sebastian', type: 'ungdom', kilde: { type: 'bruker', id: 'u1' } }],
    borteAutoTimer: 1,
    vvb: { bryter: { enhet: 'vvb', kap: 'onoff' }, effekt: { enhet: 'vvb', kap: 'measure_power' } },
  } });
  assert.equal(app.hus.innstillinger().vvb.vinduStart, '22:00', 'uendrede bereder-innstillinger beholdes');
  // Skyggemodus står på: berederen vurderes, men releet røres ikke
  assert.equal(app.motor.innstillinger().skygge, true);
  assert.equal((await api.hus({ homey })).bereder.status, 'Venter på vinduet');
  assert.deepEqual(homey.skrevet, []);
  await app.motor.settInnstillinger({ skygge: false });
  await app._motorTick(Date.now());
  let hus = await api.hus({ homey });
  assert.equal(hus.modus, 'Hjemme');
  assert.deepEqual(hus.personer.map((p) => p.hjemme), [true, false]);
  // Kl. 13 er utenfor vinduet og berederen trekker ingenting: releet slås av
  assert.deepEqual(homey.skrevet.filter(([id]) => id === 'vvb'), [['vvb', 'onoff', false]]);
  assert.equal(hus.bereder.status, 'Venter på vinduet');
  await vent();          // enheten oppdateres uten at ticket venter på den
  assert.equal(mv.ki_modus, 'Hjemme');
  assert.equal(mv.ki_bereder_status, 'Venter på vinduet');

  // Rune drar: etter en time er huset i bortemodus, og stua får bortetemperatur
  homey.variabler.v1.value = false;
  await app._motorTick(Date.now());
  t.mock.timers.setTime(Date.now() + 61 * 60000);
  await app._motorTick(Date.now());
  hus = await api.hus({ homey });
  assert.equal(hus.borte, true);
  await vent();
  assert.equal(mv.ki_bortemodus, true);
  assert.match(homey.varsler[0], /bortemodus/);
  assert.ok(homey.utlost.some(([id, tok]) => id === 'bortemodus_endret' && tok.borte === true));
  assert.equal((await api.motor({ homey })).soner.find((p) => p.key === 'stue').krav, 16);
  assert.equal(await homey.betingelser.bortemodus_er_paa({}), true);
  assert.equal(await homey.betingelser.alle_er_borte({}), true);

  // Hjemkomst kl. 17 fra flow-kort, og så kommer Rune hjem
  await homey.handlinger.sett_hjemkomst({ tid: '17:00' });
  await app._motorTick(Date.now());
  assert.equal((await api.hus({ homey })).hjemkomst_kl, '17:00');
  homey.variabler.v1.value = true;
  await app._motorTick(Date.now());
  assert.equal((await api.hus({ homey })).borte, false);
  assert.ok(homey.utlost.some(([id]) => id === 'noen_kom_hjem'));
  assert.equal((await api.motor({ homey })).soner.find((p) => p.key === 'stue').krav, 22);

  // Bryteren på enheten og API-et
  await lyttere.ki_bortemodus(true);
  assert.equal(app.hus.hus.t.borte, true);
  await api.bortemodus({ homey, body: { paa: false } });
  await api.bereder({ homey, body: { handling: 'boost', minutter: 30 } });
  await app._motorTick(Date.now());
  assert.equal((await api.hus({ homey })).bereder.status, 'Boost');
  await assert.rejects(async () => api.bereder({ homey, body: { handling: 'tull' } }), /Ukjent handling/);

  // Svarene Home Assistant-kontrollversjonen leser. Skrives til tests/fixtures når
  // KI_SKRIV_FIXTUR er satt, så Python-testene der prøves mot det appen faktisk sender.
  if (process.env.KI_SKRIV_FIXTUR) {
    const fs = require('node:fs');
    const fixtur = {
      status: await api.status({ homey }), motor: await api.motor({ homey }), hus: await api.hus({ homey }),
      innstillinger: await api.hentInnstillinger({ homey }), motorinnstillinger: await api.hentMotorinnstillinger({ homey }),
      husinnstillinger: await api.hentHusinnstillinger({ homey }),
    };
    fs.mkdirSync(path.join(__dirname, '..', '..', 'tests', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'homey_svar.json'), `${JSON.stringify(fixtur, null, 1)}\n`);
  }

  // Widgeten får ett samlet sammendrag
  const oversikt = await require('../widgets/oversikt/api').oversikt({ homey });
  assert.equal(oversikt.modus, 'Hjemme');
  assert.equal(oversikt.bereder, 'Boost');
  assert.deepEqual(oversikt.rom.map((r) => r.navn).sort(), ['Bad', 'Stue']);
  assert.equal(typeof oversikt.time.grense, 'number');
  assert.equal(oversikt.trinn, '2-5 kW');

  // Paring og lagring
  assert.equal((await new (require('../drivers/energimotor/driver'))().onPairListDevices.call({ homey })).length, 1);
  const driver = new Driver();
  driver.homey = homey;
  assert.equal((await driver.onPairListDevices()).length, 1);
  await app.onUninit();
  assert.equal(homey.settings.get('tilstand').maaned, '2026-11');
  assert.ok(homey.settings.get('motor_tilstand').profil);
  assert.equal(homey.settings.get('hus_tilstand').hus.borte, false);
});

test('app.json er bygget fra tabellene', () => {
  const { MOTOR_SENSORER } = require('../lib/sensorer');
  assert.deepEqual(manifest.drivers[0].capabilities, ['measure_power', ...SENSORER.map((s) => s.id)]);
  assert.deepEqual(manifest.drivers[1].capabilities, ['onoff', 'ki_skyggemodus', 'ki_bortemodus', 'measure_temperature', ...MOTOR_SENSORER.map((s) => s.id)]);
  for (const s of [...SENSORER, ...MOTOR_SENSORER]) assert.ok(manifest.capabilities[s.id], s.id);
  const api = require('../api');
  assert.deepEqual(Object.keys(manifest.api).sort(), Object.keys(api).sort());
  assert.equal(path.basename(manifest.images.small), 'small.png');
  assert.deepEqual(Object.keys(manifest.widgets), ['oversikt']);
  assert.deepEqual(Object.keys(manifest.widgets.oversikt.api), Object.keys(require('../widgets/oversikt/api')));
});
