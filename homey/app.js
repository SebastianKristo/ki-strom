'use strict';

const Homey = require('homey');
const tariffer = require('./lib/tariffer.json');
const { Stromkalkulator, STANDARD_INNSTILLINGER } = require('./lib/stromkalkulator');
const { Spotpriser, hentManglende } = require('./lib/spotpris');
const { MotorKobling } = require('./kobling/motor');
const { HusKobling } = require('./kobling/hus');

const TICK_MS = 60 * 1000;
const LAGRE_MS = 5 * 60 * 1000;
const SPOT_MS = 30 * 60 * 1000;
const VAER_MS = 20 * 60 * 1000;
const TIMER_BEHOLDES_SEK = 3 * 86400;

/**
 * KI Energi for Homey.
 *
 * Strømkalkulatoren: appen leser strømmåleren (effekt og kWh-register) fra en annen
 * Homey-enhet, henter spotpriser selv, og mater den rene kalkulatoren i lib/.
 * Effektmotoren: leser termostatene, henter værvarsel og setter settpunkter (kobling/motor.js).
 * Resultatet vises på enhetene «Strømkalkulator» og «Energimotor», i flow-kort og på appens lokale API.
 */
module.exports = class KiEnergiApp extends Homey.App {
  async onInit() {
    this.spot = new Spotpriser(this.homey.settings.get('spot') || []);
    this.tilstand = this.homey.settings.get('tilstand') || {};
    this.kalkulator = new Stromkalkulator(this.tilstand, this.innstillinger(), tariffer);
    this.siste = { effekt: null, energi: null, energiMs: null };
    this.forrige = {};          // forrige verdier, for å oppdage endringer til flow-kortene
    this.instanser = [];
    this.bilde = null;
    this.motor = new MotorKobling(this);
    this.hus = new HusKobling(this);

    this._registrerFlow();
    this.homey.settings.on('set', (nokkel) => {
      if (nokkel !== 'innstillinger') return;
      this.kalkulator.settInnstillinger(this.innstillinger());
      this._kobleMaaler().catch((e) => this.error('Kunne ikke koble til måleren:', e.message));
      this._hentSpot().catch((e) => this.error('Spotpris:', e.message));
    });

    this.homey.setInterval(() => this._tick(), TICK_MS);
    this.homey.setInterval(() => this._lagre(), LAGRE_MS);
    this.homey.setInterval(() => this._hentSpot().catch((e) => this.error('Spotpris:', e.message)), SPOT_MS);
    this.homey.setInterval(() => this.motor.hentVaer(Date.now()).catch((e) => this.error('Værvarsel:', e.message)), VAER_MS);
    this.motor.hentVaer(Date.now()).catch((e) => this.error('Værvarsel:', e.message));

    await this._hentSpot().catch((e) => this.error('Spotpris:', e.message));
    await this._kobleMaaler().catch((e) => this.error('Kunne ikke koble til måleren:', e.message));
    this._tick();
    this.log('KI Energi er startet');
  }

  async onUninit() {
    this._lagre();
  }

  innstillinger() {
    return { ...STANDARD_INNSTILLINGER, ...(this.homey.settings.get('innstillinger') || {}) };
  }

  // ------------------------------------------------------------------
  //  Strømmåleren
  // ------------------------------------------------------------------
  async api() {
    if (!this._api) {
      // Lastes her, så en manglende pakke gir en forståelig feil i loggen og ikke en død app.
      const { HomeyAPI } = require('homey-api');   // eslint-disable-line global-require
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._api;
  }

  /** Enheter som kan være strømmåler: alt med effekt (W) eller energiregister (kWh). */
  async maalere() {
    const api = await this.api();
    const enheter = await api.devices.getDevices();
    const soner = await api.zones.getZones().catch(() => ({}));
    const ut = [];
    for (const e of Object.values(enheter)) {
      const kap = (e.capabilities || []).filter((k) => k.startsWith('measure_power') || k.startsWith('meter_power'));
      if (!kap.length || (e.driverId || '').includes(this.manifest.id)) continue;
      ut.push({
        id: e.id, navn: e.name, sone: (soner[e.zone] && soner[e.zone].name) || '',
        kapabiliteter: kap.map((k) => ({ id: k, verdi: e.capabilitiesObj && e.capabilitiesObj[k] ? e.capabilitiesObj[k].value : null })),
      });
    }
    return ut.sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }

  async _kobleMaaler() {
    for (const i of this.instanser) i.destroy();
    this.instanser = [];
    this.siste = { effekt: null, energi: null, energiMs: null };
    const innst = this.innstillinger();
    if (!innst.maalerEnhet) return;
    const api = await this.api();
    const enhet = await api.devices.getDevice({ id: innst.maalerEnhet });
    const lytt = (kapabilitet, mottak) => {
      if (!kapabilitet || !(enhet.capabilities || []).includes(kapabilitet)) return;
      const instans = enhet.makeCapabilityInstance(kapabilitet, (verdi) => mottak(Number(verdi)));
      this.instanser.push(instans);
      if (instans.value !== null && instans.value !== undefined) mottak(Number(instans.value));
    };
    lytt(innst.effektKapabilitet, (w) => { this.siste.effekt = w; });
    // Hver registeroppdatering går rett til kalkulatoren: prøvene nær timeskiftet gjør timen «målt».
    lytt(innst.energiKapabilitet, (kwh) => this._energi(kwh));
    this.log(`Måler: ${enhet.name} (${innst.effektKapabilitet || '–'}, ${innst.energiKapabilitet || '–'})`);
  }

  _energi(kwh) {
    if (!Number.isFinite(kwh)) return;
    const naa = Date.now();
    this.siste.energi = kwh;
    this.siste.energiMs = naa;
    this._timerLukket(this.kalkulator.energi(naa, kwh, this.spot));
  }

  // ------------------------------------------------------------------
  //  Spotpris
  // ------------------------------------------------------------------
  async _hentSpot() {
    const nye = await hentManglende(this.spot, this.kalkulator.prisomraade(), Date.now(), (adresse) => fetch(adresse));
    if (nye) {
      this.homey.settings.set('spot', this.spot.intervaller);
      this.log(`Hentet ${nye} spotpriser for ${this.kalkulator.prisomraade()}`);
    }
  }

  // ------------------------------------------------------------------
  //  Hovedløkke
  // ------------------------------------------------------------------
  _tick() {
    try {
      const naa = this._tickKalkulator();
      this._motorTick(naa).catch((e) => this.error('Motoren feilet:', e));
    } catch (e) {
      this.error('Tick feilet:', e);
    }
  }

  /** Strømkalkulatorens del av ticket. Returnerer tidspunktet. */
  _tickKalkulator() {
    {
      const naa = Date.now();
      const innst = this.innstillinger();
      if (innst.energiKapabilitet) {
        // Registeret mates fra lytteren når det endrer seg. Her går klokka: timer og måned lukkes,
        // og et register som står stille får en kontrollprøve i ny og ne.
        this._timerLukket(this.siste.energi === null ? this.kalkulator.tikk(naa) : this.kalkulator.energi(naa, this.siste.energi, this.spot));
      } else if (!innst.energiKapabilitet && this.siste.effekt !== null) {
        this._timerLukket(this.kalkulator.effekt(naa, this.siste.effekt, this.spot));
      }
      this.bilde = this.kalkulator.snapshot(naa, this.spot);
      this.bilde.effekt_w = this.siste.effekt;
      this._flowVedEndring(this.bilde);
      for (const enhet of this.homey.drivers.getDriver('stromkalkulator').getDevices()) {
        enhet.oppdater(this.bilde).catch((e) => this.error('Enhet:', e.message));
      }
      return naa;
    }
  }

  /** Motoren har sin egen vakt: feiler den, regnes strømkalkulatoren videre. */
  async _motorTick(naa) {
    if (this._motorKjorer) return;      // et tick som venter på Homey skal ikke få et nytt oppå seg
    this._motorKjorer = true;
    try {
      const b = await this.motor.tick(naa);
      this._motorFlow(b);
      for (const enhet of this.homey.drivers.getDriver('energimotor').getDevices()) {
        enhet.oppdater(b).catch((e) => this.error('Enhet:', e.message));
      }
    } finally {
      this._motorKjorer = false;
    }
  }

  /**
   * Regn på nytt med en gang, etter en endring fra innstillingene eller API-et. Uten dette
   * ville svaret vise forrige minutts bilde, og en bryter i Home Assistant ville hoppet tilbake.
   */
  async regnNaa() {
    try {
      this._tickKalkulator();
      await this._motorTick(Date.now());
    } catch (e) {
      this.error('Kunne ikke regne på nytt:', e);
    }
  }

  _motorFlow(b) {
    const f = this.forrige;
    if (f.motorStatus !== undefined && f.motorStatus !== b.status) {
      this.utloser.motor_status_endret.trigger({ status: b.status, forklaring: b.forklaring }).catch(this.error);
    }
    f.motorStatus = b.status;
    const senket = Object.fromEntries(b.soner.filter((p) => p.handling === 'senket').map((p) => [p.key, p]));
    for (const [key, p] of Object.entries(senket)) {
      if (f.senket && !f.senket[key]) this.utloser.rom_senket.trigger({ rom: p.navn, grader: p.senket || 0 }).catch(this.error);
    }
    f.senket = senket;
  }

  _timerLukket(lukket) {
    for (const rad of lukket) {
      if (rad.kwh === null) continue;
      const dato = Object.entries(this.tilstand.doegnmaks || {}).find(([, v]) => v.kw === rad.kwh);
      this.utloser.time_lukket.trigger({ kwh: rad.kwh, ny_topp: Boolean(dato) }).catch(this.error);
    }
    if (lukket.length) {
      // Timeradene trengs bare til de er regnet inn i døgnmaksene.
      const gammel = Date.now() / 1000 - TIMER_BEHOLDES_SEK;
      for (const [k, r] of Object.entries(this.tilstand.maler.timer)) {
        if ((r.start || 0) < gammel) delete this.tilstand.maler.timer[k];
      }
      this._lagre();
    }
  }

  _lagre() {
    this.homey.settings.set('tilstand', this.tilstand);
    this.motor.lagre();
    this.hus.lagre();
  }

  // ------------------------------------------------------------------
  //  Flow
  // ------------------------------------------------------------------
  _registrerFlow() {
    const kort = (id) => this.homey.flow.getTriggerCard(id);
    this.utloser = {
      kapasitetsvarsel_paa: kort('kapasitetsvarsel_paa'),
      kapasitetstrinn_endret: kort('kapasitetstrinn_endret'),
      time_lukket: kort('time_lukket'),
      tariff_endret: kort('tariff_endret'),
      pris_endret: kort('pris_endret'),
      motor_status_endret: kort('motor_status_endret'),
      rom_senket: kort('rom_senket'),
      bortemodus_endret: kort('bortemodus_endret'),
      noen_kom_hjem: kort('noen_kom_hjem'),
      bereder_varm: kort('bereder_varm'),
      bereder_ikke_klar: kort('bereder_ikke_klar'),
    };
    const handling = (id, f) => this.homey.flow.getActionCard(id).registerRunListener(async (args) => { await f(args); });
    handling('sett_bortemodus', (args) => this.hus.settBorte(args.modus === 'paa'));
    handling('sett_hjemkomst', (args) => this.hus.settHjemkomst(args.tid));
    handling('forleng_borte', () => this.hus.forleng());
    handling('bereder_boost', (args) => this.hus.berederHandling('boost', args.minutter));
    handling('bereder_tving', () => this.hus.berederHandling('tving'));
    handling('sett_ladeautomatikk', (args) => { this.hus.settInnstillinger({ lading: { automatikk: args.modus === 'paa' } }); });
    this.homey.flow.getConditionCard('bortemodus_er_paa').registerRunListener(async () => Boolean(this.hus.hus.t.borte));
    this.homey.flow.getConditionCard('alle_er_borte').registerRunListener(async () => this.hus.hus.alleBorte() === true);
    const rom = async (sok) => this.motor.motor.soner()
      .filter((s) => (s.navn || s.key).toLowerCase().includes(String(sok || '').toLowerCase()))
      .map((s) => ({ name: s.navn || s.key, id: s.key }));
    const overstyr = this.homey.flow.getActionCard('overstyr_rom');
    overstyr.registerArgumentAutocompleteListener('rom', rom);
    overstyr.registerRunListener(async (args) => this.motor.overstyr(args.rom.id, args.temp, args.minutter));
    const fjern = this.homey.flow.getActionCard('fjern_overstyring');
    fjern.registerArgumentAutocompleteListener('rom', rom);
    fjern.registerRunListener(async (args) => this.motor.fjernOverstyring(args.rom.id));
    this.homey.flow.getActionCard('sett_skyggemodus').registerRunListener(async (args) => { this.motor.settInnstillinger({ skygge: args.modus === 'paa' }); });
    this.homey.flow.getConditionCard('motor_status_er').registerRunListener(async (args) => Boolean(this.motor.bilde) && this.motor.bilde.status === args.status);
    const betingelse = (id, test) => this.homey.flow.getConditionCard(id).registerRunListener(async (args) => Boolean(this.bilde) && test(this.bilde, args));
    betingelse('tariff_er_dag', (b) => b.nettleie.tariff === 'dag');
    betingelse('norgespris_aktiv', (b) => b.pris.norgespris_aktiv);
    betingelse('kapasitetsvarsel', (b) => b.nettleie.kapasitetsvarsel);
    betingelse('totalpris_over', (b, args) => b.pris.total !== null && b.pris.total > Number(args.grense));
  }

  _flowVedEndring(b) {
    const f = this.forrige;
    const endret = (nokkel, verdi) => {
      const var_ = f[nokkel];
      f[nokkel] = verdi;
      return var_ !== undefined && var_ !== verdi;
    };
    if (endret('varsel', b.nettleie.kapasitetsvarsel) && b.nettleie.kapasitetsvarsel) {
      this.utloser.kapasitetsvarsel_paa.trigger({ margin: b.nettleie.margin_kw, neste_pris: b.nettleie.neste_trinn_pris || 0 }).catch(this.error);
    }
    if (endret('trinn', b.nettleie.kapasitetstrinn) && b.nettleie.kapasitetsledd !== null) {
      this.utloser.kapasitetstrinn_endret.trigger({ trinn: b.nettleie.kapasitetstrinn, pris: b.nettleie.kapasitetsledd }).catch(this.error);
    }
    if (endret('tariff', b.nettleie.tariff)) {
      this.utloser.tariff_endret.trigger({ tariff: b.nettleie.tariff }).catch(this.error);
    }
    if (endret('total', b.pris.total) && b.pris.total !== null) {
      this.utloser.pris_endret.trigger({ total: b.pris.total, spot: b.pris.spot || 0 }).catch(this.error);
    }
  }

  // ------------------------------------------------------------------
  //  For api.js
  // ------------------------------------------------------------------
  status() {
    return this.bilde || this.kalkulator.snapshot(Date.now(), this.spot);
  }

  priser() {
    const sats = this.kalkulator.satser(Date.now());
    return {
      prisomraade: this.kalkulator.prisomraade(),
      mva: sats.mvaSats,
      timer: this.spot.timepriser(Date.now(), 48).map((t) => ({ start: new Date(t.start).toISOString(), spot_eks_mva: t.pris })),
    };
  }

  nettselskap() {
    return Object.entries(tariffer.nettselskap)
      .filter(([, d]) => d.supported !== false)
      .map(([id, d]) => ({
        id, navn: d.name, prisomraade: d.prisomrade, metode: d.fastledd_metode || 'TRE_DØGNMAX_MND',
        sikringstrinn: (d.fastledd_sikringstrinn || []).map((r) => ({ id: r.id, navn: r.label })),
      }))
      .sort((a, b) => a.navn.localeCompare(b.navn, 'no'));
  }
};
