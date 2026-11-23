'use strict';

/**
 * Bygger app.json fra tabellene i lib/. Kjør `npm run bygg` etter endringer i sensorene,
 * flow-kortene eller API-et, og sjekk inn resultatet.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SENSORER } = require('../lib/sensorer');
const pakke = require('../package.json');

const kapabiliteter = {};
for (const s of SENSORER) {
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
  permissions: ['homey:manager:api'],
  images: { small: '/assets/images/small.png', large: '/assets/images/large.png', xlarge: '/assets/images/xlarge.png' },
  author: { name: 'Sebastian Kristo' },
  api: {
    status: { method: 'GET', path: '/status' },
    priser: { method: 'GET', path: '/priser' },
    nettselskap: { method: 'GET', path: '/nettselskap' },
    enheter: { method: 'GET', path: '/enheter' },
    hentInnstillinger: { method: 'GET', path: '/innstillinger' },
    settInnstillinger: { method: 'PUT', path: '/innstillinger' },
  },
  capabilities: kapabiliteter,
  drivers: [{
    id: 'stromkalkulator',
    name: { no: 'Strømkalkulator', en: 'Electricity calculator' },
    class: 'sensor',
    capabilities: ['measure_power', ...SENSORER.map((s) => s.id)],
    images: {
      small: '/drivers/stromkalkulator/assets/images/small.png',
      large: '/drivers/stromkalkulator/assets/images/large.png',
    },
    pair: [
      { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } },
      { id: 'add_devices', template: 'add_devices' },
    ],
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
    ],
  },
};

fs.writeFileSync(path.join(__dirname, '..', 'app.json'), `${JSON.stringify(app, null, 2)}\n`);
console.log(`app.json: ${SENSORER.length} sensorer, ${app.flow.triggers.length} utløsere, ${app.flow.conditions.length} betingelser`);
