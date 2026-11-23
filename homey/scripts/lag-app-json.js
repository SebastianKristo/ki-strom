'use strict';

/**
 * Bygger app.json fra tabellene i lib/. Kjør `npm run bygg` etter endringer i sensorene,
 * flow-kortene eller API-et, og sjekk inn resultatet.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SENSORER, MOTOR_SENSORER } = require('../lib/sensorer');
const pakke = require('../package.json');

const kapabiliteter = {};
for (const s of [...SENSORER, ...MOTOR_SENSORER]) {
  const k = {
    type: s.type, title: { no: s.no, en: s.en }, getable: true, setable: false,
    uiComponent: 'sensor', icon: '/assets/sensor.svg',
  };
  if (s.type === 'number') {
    k.units = { no: s.enhet, en: s.enhet };
    k.decimals = s.desimaler;
    k.insights = true;
  }
  if (s.type === 'boolean') {
    k.insights = true;
    k.insightsTitleTrue = { no: `${s.no}: ja`, en: `${s.en}: yes` };
    k.insightsTitleFalse = { no: `${s.no}: nei`, en: `${s.en}: no` };
  }
  kapabiliteter[s.id] = k;
}
kapabiliteter.ki_skyggemodus = {
  type: 'boolean', title: { no: 'Skyggemodus', en: 'Shadow mode' }, getable: true, setable: true,
  uiComponent: 'toggle', icon: '/assets/sensor.svg', insights: false,
};

const statusvalg = [['gronn', 'God margin', 'Good margin'], ['gul', 'Følger med', 'Watching'], ['oransje', 'Nær grensen', 'Near the limit'],
  ['rod', 'På grensen', 'At the limit'], ['kritisk', 'Over grensen', 'Over the limit'], ['av', 'Av', 'Off']]
  .map(([id, no, en]) => ({ id, label: { no, en } }));
const romArg = { name: 'rom', type: 'autocomplete', placeholder: { no: 'Rom', en: 'Room' } };
const bilder = (driver) => ({ small: `/drivers/${driver}/assets/images/small.png`, large: `/drivers/${driver}/assets/images/large.png` });
const paring = [
  { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } },
  { id: 'add_devices', template: 'add_devices' },
];

const app = {
  _comment: 'Bygget av scripts/lag-app-json.js — ikke rediger for hånd.',
  id: pakke.name,
  version: pakke.version,
  compatibility: '>=12.0.0',
  sdk: 3,
  platforms: ['local'],
  name: { no: 'KI Energi', en: 'KI Energi' },
  description: {
    no: 'Strømkalkulator og smart energistyring: nettleie, kapasitetstrinn, strømstøtte og Norgespris.',
    en: 'Electricity calculator and smart energy control for Norway: grid rent, capacity steps and subsidies.',
  },
  category: ['energy'],
  brandColor: '#1565C0',
  permissions: ['homey:manager:api', 'homey:manager:geolocation'],
  images: { small: '/assets/images/small.png', large: '/assets/images/large.png', xlarge: '/assets/images/xlarge.png' },
  author: { name: 'Sebastian Kristo' },
  api: {
    status: { method: 'GET', path: '/status' },
    priser: { method: 'GET', path: '/priser' },
    nettselskap: { method: 'GET', path: '/nettselskap' },
    enheter: { method: 'GET', path: '/enheter' },
    hentInnstillinger: { method: 'GET', path: '/innstillinger' },
    settInnstillinger: { method: 'PUT', path: '/innstillinger' },
    motor: { method: 'GET', path: '/motor' },
    hentMotorinnstillinger: { method: 'GET', path: '/motorinnstillinger' },
    settMotorinnstillinger: { method: 'PUT', path: '/motorinnstillinger' },
    termostater: { method: 'GET', path: '/termostater' },
    temperatursensorer: { method: 'GET', path: '/temperatursensorer' },
    romforslag: { method: 'GET', path: '/romforslag' },
    overstyr: { method: 'POST', path: '/overstyr' },
    fjernOverstyring: { method: 'POST', path: '/fjernoverstyring' },
  },
  capabilities: kapabiliteter,
  drivers: [{
    id: 'stromkalkulator',
    name: { no: 'Strømkalkulator', en: 'Electricity calculator' },
    class: 'sensor',
    capabilities: ['measure_power', ...SENSORER.map((s) => s.id)],
    images: bilder('stromkalkulator'),
    pair: paring,
  }, {
    id: 'energimotor',
    name: { no: 'Energimotor', en: 'Energy engine' },
    class: 'other',
    capabilities: ['onoff', 'ki_skyggemodus', 'measure_temperature', ...MOTOR_SENSORER.map((s) => s.id)],
    capabilitiesOptions: {
      onoff: { title: { no: 'Motoren er på', en: 'Engine on' } },
      measure_temperature: { title: { no: 'Utetemperatur', en: 'Outdoor temperature' } },
    },
    images: bilder('energimotor'),
    pair: paring,
  }],
  flow: {
    triggers: [
      {
        id: 'kapasitetsvarsel_paa',
        title: { no: 'Kapasitetsvarsel: nær neste trinn', en: 'Capacity warning: close to next step' },
        tokens: [
          { name: 'margin', type: 'number', title: { no: 'Margin (kW)', en: 'Margin (kW)' }, example: 0.4 },
          { name: 'neste_pris', type: 'number', title: { no: 'Neste trinn (kr/mnd)', en: 'Next step (kr/month)' }, example: 420 },
        ],
      },
      {
        id: 'kapasitetstrinn_endret',
        title: { no: 'Kapasitetstrinnet endret seg', en: 'Capacity step changed' },
        tokens: [
          { name: 'trinn', type: 'string', title: { no: 'Trinn', en: 'Step' }, example: '5-10 kW' },
          { name: 'pris', type: 'number', title: { no: 'Kr per måned', en: 'Kr per month' }, example: 420 },
        ],
      },
      {
        id: 'time_lukket',
        title: { no: 'En time er ferdig', en: 'An hour has ended' },
        tokens: [
          { name: 'kwh', type: 'number', title: { no: 'Forbruk (kWh)', en: 'Consumption (kWh)' }, example: 3.2 },
          { name: 'ny_topp', type: 'boolean', title: { no: 'Ny døgntopp', en: 'New daily peak' } },
        ],
      },
      {
        id: 'tariff_endret',
        title: { no: 'Tariffen skiftet (dag/natt)', en: 'Tariff changed (day/night)' },
        tokens: [{ name: 'tariff', type: 'string', title: { no: 'Tariff', en: 'Tariff' }, example: 'natt' }],
      },
      {
        id: 'pris_endret',
        title: { no: 'Strømprisen endret seg', en: 'Electricity price changed' },
        tokens: [
          { name: 'total', type: 'number', title: { no: 'Totalpris (kr/kWh)', en: 'Total price (kr/kWh)' }, example: 1.42 },
          { name: 'spot', type: 'number', title: { no: 'Spotpris inkl. mva', en: 'Spot incl. VAT' }, example: 1.1 },
        ],
      },
      {
        id: 'motor_status_endret',
        title: { no: 'Energimotorens status endret seg', en: 'Energy engine status changed' },
        tokens: [
          { name: 'status', type: 'string', title: { no: 'Status', en: 'Status' }, example: 'oransje' },
          { name: 'forklaring', type: 'string', title: { no: 'Forklaring', en: 'Explanation' }, example: 'Gang er senket' },
        ],
      },
      {
        id: 'rom_senket',
        title: { no: 'Et rom ble senket for å holde timen', en: 'A room was lowered to hold the hour' },
        tokens: [
          { name: 'rom', type: 'string', title: { no: 'Rom', en: 'Room' }, example: 'Gang' },
          { name: 'grader', type: 'number', title: { no: 'Grader', en: 'Degrees' }, example: 1.5 },
        ],
      },
    ],
    conditions: [
      { id: 'tariff_er_dag', title: { no: 'Tariffen !{{er|er ikke}} dagtariff', en: 'Tariff !{{is|is not}} day tariff' } },
      { id: 'norgespris_aktiv', title: { no: 'Norgespris !{{er|er ikke}} aktiv', en: 'Norgespris !{{is|is not}} active' } },
      { id: 'kapasitetsvarsel', title: { no: 'Kapasitetsvarsel !{{er|er ikke}} på', en: 'Capacity warning !{{is|is not}} on' } },
      {
        id: 'totalpris_over',
        title: { no: 'Totalprisen !{{er|er ikke}} over …', en: 'Total price !{{is|is not}} above …' },
        titleFormatted: { no: 'Totalprisen !{{er|er ikke}} over [[grense]] kr/kWh', en: 'Total price !{{is|is not}} above [[grense]] kr/kWh' },
        args: [{ name: 'grense', type: 'number', min: 0, max: 20, step: 0.01, placeholder: { no: '1.50', en: '1.50' } }],
      },
      {
        id: 'motor_status_er',
        title: { no: 'Energimotorens status !{{er|er ikke}} …', en: 'Energy engine status !{{is|is not}} …' },
        titleFormatted: { no: 'Energimotorens status !{{er|er ikke}} [[status]]', en: 'Energy engine status !{{is|is not}} [[status]]' },
        args: [{ name: 'status', type: 'dropdown', values: statusvalg }],
      },
    ],
    actions: [
      {
        id: 'overstyr_rom',
        title: { no: 'Overstyr temperaturen i et rom', en: 'Override the temperature in a room' },
        titleFormatted: { no: 'Sett [[rom]] til [[temp]] °C i [[minutter]] minutter', en: 'Set [[rom]] to [[temp]] °C for [[minutter]] minutes' },
        args: [romArg,
          { name: 'temp', type: 'number', min: 5, max: 30, step: 0.5, placeholder: { no: '22', en: '22' } },
          { name: 'minutter', type: 'number', min: 5, max: 1440, step: 5, placeholder: { no: '120', en: '120' } }],
      },
      {
        id: 'fjern_overstyring',
        title: { no: 'Fjern overstyringen i et rom', en: 'Remove the override in a room' },
        titleFormatted: { no: 'Fjern overstyringen i [[rom]]', en: 'Remove the override in [[rom]]' },
        args: [romArg],
      },
      {
        id: 'sett_skyggemodus',
        title: { no: 'Slå skyggemodus av eller på', en: 'Turn shadow mode on or off' },
        titleFormatted: { no: 'Slå skyggemodus [[modus]]', en: 'Turn shadow mode [[modus]]' },
        args: [{ name: 'modus', type: 'dropdown', values: [{ id: 'paa', label: { no: 'på', en: 'on' } }, { id: 'av', label: { no: 'av', en: 'off' } }] }],
      },
    ],
  },
};

fs.writeFileSync(path.join(__dirname, '..', 'app.json'), `${JSON.stringify(app, null, 2)}\n`);
console.log(`app.json: ${SENSORER.length} + ${MOTOR_SENSORER.length} sensorer, ${app.flow.triggers.length} utløsere, ${app.flow.conditions.length} betingelser, ${app.flow.actions.length} handlinger`);
