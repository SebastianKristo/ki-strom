'use strict';

/**
 * Varmtvannsbereder: metning, vindu, prisstyring og legionella.
 *
 * Berederen har ingen temperatursensor, men den har en termostat. Bryter PÅ og effekt ~0
 * i noen minutter betyr at termostaten har koblet ut: vannet er på settpunkt. Det er både
 * «varmtvannet er klart» og legionellabekreftelsen, forutsatt at termostaten fysisk står
 * på 65–70 °C. Et ødelagt element gir samme signatur, så berederen må HA trukket effekt
 * siden bryteren ble slått på før null effekt telles som metning.
 *
 * Legionella er den ene tingen sparingen aldri får blokkere: er fristen passert, varmes
 * det uansett pris og effekt.
 *
 * Samme regler som Home Assistant-versjonen (vvb.py), med rettelsene derfra: en påbegynt
 * oppvarming får gå til termostaten kobler ut, tvungen syklus slås ikke av, uten priser
 * følges vinduet, og boosten avsluttes ved metning.
 */

const { osloDeler, osloTilUtc } = require('./kalender');
const { minutter, mellom } = require('./program');

const TIME_MS = 3600000;
const DOGN_MS = 86400000;

const STANDARD = {
  bryter: null,                 // {enhet, kap} — onoff på releet
  effekt: null,                 // {enhet, kap} — measure_power
  prisstyring: true,            // av = berederen står som den står
  alltidPa: false,
  vinduStart: '22:00',
  klarInnen: '05:00',
  folgSpotpris: false,          // velg de billigste timene fram til fristen i stedet for hele vinduet
  billigsteTimer: 6,
  legionellaAktiv: true,
  intervallDager: 3,            // ønsket: metning minst så ofte
  maksDager: 7,                 // hard frist: da tvinges den
  terskelW: 150,
  metningMinutter: 12,          // så lenge må elementet ha stått uten å trekke strøm før releet slås av
  maksMinUtenEffekt: 10,
  maksOppvarmingMin: 720,       // øvre grense for hvor lang en oppvarming antas å være (til planleggingen)
  nominellKw: 2.0,
  borteSparing: true,
  klarForAnkomstTimer: 3,
  fristSjekk: true,             // varm uansett pris og effekt når det ellers ikke rekker å bli ferdig til fristen
  standardOppvarmingMin: 180,   // antatt oppvarmingstid til berederen har vist sin egen
};

class Bereder {
  /** @param {object} tilstand lagret tilstand @param {object} innstillinger se STANDARD */
  constructor(tilstand, innstillinger) {
    this.m = tilstand;
    const m = this.m;
    for (const [k, v] of Object.entries({ siste_syklus: null, har_trukket: false, startet: null, tvungen: false, boost_til: null,
      under_siden: null, var_aktiv: false, var_mettet: false, siste_bryter: null, kritisk: false, billige: [],
      syklus: false, uten_effekt: 0, logg: [],
      varigheter: [], morgen: null, legionella_varslet: false })) {
      if (m[k] === undefined) m[k] = v;
    }
    this.settInnstillinger(innstillinger);
  }

  settInnstillinger(innstillinger) {
    this.i = { ...STANDARD, ...(innstillinger || {}) };
  }

  konfigurert() {
    return Boolean(this.i.bryter && this.i.bryter.enhet);
  }

  // ------------------------------------------------------------------
  //  Avledet
  // ------------------------------------------------------------------
  iVindu(ms) {
    const d = osloDeler(ms);
    return mellom(minutter(this.i.vinduStart, 22 * 60), minutter(this.i.klarInnen, 5 * 60), d.time * 60 + d.minutt);
  }

  dagerSiden(ms) {
    return this.m.siste_syklus === null ? null : (ms - this.m.siste_syklus) / DOGN_MS;
  }

  legionellaOk(ms) {
    const d = this.dagerSiden(ms);
    return d !== null && d < this.i.intervallDager;
  }

  forfalt(ms) {
    if (!this.i.legionellaAktiv) return false;
    const d = this.dagerSiden(ms);
    return d !== null && d > this.i.maksDager;
  }

  boostAktiv(ms) {
    return this.m.boost_til !== null && this.m.boost_til > ms;
  }

  /** Har berederen nådd settpunktet siden vinduet sist åpnet? */
  ferdigIVinduet(ms) {
    const d = osloDeler(ms);
    const startMin = minutter(this.i.vinduStart, 22 * 60);
    let start = osloTilUtc(d.aar, d.mnd, d.dag, Math.floor(startMin / 60), startMin % 60);
    if (ms < start) start -= DOGN_MS;
    return this.m.siste_syklus !== null && this.m.siste_syklus > start;
  }

  /** Neste frist (UTC-ms): når vannet skal være varmt. */
  fristEtter(ms) {
    const d = osloDeler(ms);
    const klarMin = minutter(this.i.klarInnen, 5 * 60);
    const klar = osloTilUtc(d.aar, d.mnd, d.dag, Math.floor(klarMin / 60), klarMin % 60);
    return klar > ms ? klar : klar + DOGN_MS;
  }

  /** Hvor lang tid en oppvarming trenger (minutter): den lengste av de siste, med margin. */
  behovMin() {
    const v = this.m.varigheter;
    const grunnlag = v.length ? Math.max(...v) * 1.2 + 15 : Number(this.i.standardOppvarmingMin) || 180;
    return Math.round(Math.min(this.i.maksOppvarmingMin, Math.max(45, grunnlag)));
  }

  /**
   * Fristen nærmer seg og vannet er ikke varmt: nå må berederen gå, uansett pris og effekt.
   * Gjelder bare når KI styrer berederen; i bortemodus bestemmer hvilereglene.
   */
  maaRekke(ms, kontekst = {}) {
    const i = this.i;
    if (!i.fristSjekk || !i.prisstyring || i.alltidPa) return false;
    if (this.m.var_mettet || this.ferdigIVinduet(ms)) return false;
    if (this.borteSparing(ms, kontekst)[0]) return false;
    return this.fristEtter(ms) - ms <= this.behovMin() * 60000;
  }

  /** Legionellastatus: 'sikret' (innen ønsket intervall), 'bor_varmes' eller 'forfalt' (hard frist passert). */
  legionellaStatus(ms) {
    if (this.forfalt(ms)) return 'forfalt';
    return this.legionellaOk(ms) ? 'sikret' : 'bor_varmes';
  }

  /**
   * Morgensjekken: én gang per døgn, i det fristen passerer. Ble vannet varmt siden vinduet åpnet?
   * @returns {object|null} hendelse hvis vannet ikke ble varmt
   */
  morgensjekk(ms, effektW, kontekst) {
    const m = this.m;
    const i = this.i;
    const d = osloDeler(ms);
    const dato = `${d.aar}-${String(d.mnd).padStart(2, '0')}-${String(d.dag).padStart(2, '0')}`;
    const klarMin = minutter(i.klarInnen, 5 * 60);
    const frist = osloTilUtc(d.aar, d.mnd, d.dag, Math.floor(klarMin / 60), klarMin % 60);
    if (ms < frist || ms - frist > TIME_MS || (m.morgen && m.morgen.dato === dato)) return null;
    const startMin = minutter(i.vinduStart, 22 * 60);
    let start = osloTilUtc(d.aar, d.mnd, d.dag, Math.floor(startMin / 60), startMin % 60);
    if (start >= frist) start -= DOGN_MS;
    let klar;
    let tekst;
    if (this.borteSparing(ms, kontekst)[0]) { klar = null; tekst = 'Huset står tomt — berederen hviler.'; }
    else if (effektW === null) { klar = null; tekst = 'Kan ikke bekreftes: releet har ingen effektmåling.'; }
    else if (m.siste_syklus !== null && m.siste_syklus > start) {
      const t = osloDeler(m.siste_syklus);
      klar = true;
      tekst = `Vannet var varmt kl. ${String(t.time).padStart(2, '0')}:${String(t.minutt).padStart(2, '0')}.`;
    } else {
      klar = false;
      tekst = m.kritisk ? 'Elementet trekker ikke strøm. Sjekk sikring og element.'
        : m.var_aktiv ? 'Den varmer fortsatt.'
          : `Termostaten har ikke koblet ut siden kl. ${i.vinduStart}.`;
    }
    m.morgen = { dato, ms, klar, tekst };
    return klar === false ? { type: 'ikke_klar', tekst: `Berederen ble ikke varm til kl. ${i.klarInnen}. ${tekst}` } : null;
  }

  /** Releet står på, men elementet har ikke trukket strøm siden påslag (og vi har en måler som kunne sett det). */
  utenEffekt(ms, bryterPa, effektW) {
    if (!bryterPa || this.m.har_trukket || this.m.startet === null || effektW === null) return false;
    return (ms - this.m.startet) / 60000 >= this.i.maksMinUtenEffekt;
  }

  /** De billigste timene (UTC-ms timestart) fra nå til fristen. Tom uten priser. */
  billigeTimer(ms, spot) {
    if (!spot) return [];
    const d = osloDeler(ms);
    const klarMin = minutter(this.i.klarInnen, 5 * 60);
    let klar = osloTilUtc(d.aar, d.mnd, d.dag, Math.floor(klarMin / 60), klarMin % 60);
    if (klar <= ms) klar += DOGN_MS;
    return spot.timepriser(ms, 36)
      .filter((t) => t.start < klar)
      .sort((a, b) => a.pris - b.pris)
      .slice(0, Math.max(1, Math.round(this.i.billigsteTimer)))
      .map((t) => t.start)
      .sort((a, b) => a - b);
  }

  billigTimeNaa(ms, kontekst) {
    // Uten priser (kilden nede) er lista tom: da gjelder vinduet, ellers sto berederen kald.
    if (this.i.folgSpotpris && !kontekst.norgespris && this.m.billige.length) {
      return this.m.billige.includes(Math.floor(ms / TIME_MS) * TIME_MS);
    }
    return this.iVindu(ms);
  }

  /** Huset står tomt og ingenting haster: hvil. Returnerer [hviler, grunn]. */
  borteSparing(ms, kontekst) {
    if (!this.i.borteSparing || !kontekst.borte) return [false, ''];
    const d = this.dagerSiden(ms);
    if (d !== null && d >= this.i.maksDager - 1) return [false, 'bortemodus, men legionellafristen nærmer seg'];
    if (kontekst.hjemkomstMs && kontekst.hjemkomstMs - ms <= this.i.klarForAnkomstTimer * TIME_MS) return [false, 'varmer så vannet er klart til dere kommer'];
    return [true, 'huset står tomt — berederen hviler til noen kommer eller legionellafristen nærmer seg'];
  }

  /**
   * Skal releet stå på nå? Returnerer {paa, grunn}.
   *
   * Hovedregelen: en oppvarming som er startet, avsluttes bare av berederens egen termostat.
   * Pris, effekt og klokka bestemmer når den STARTER — aldri når den slutter. Releet slås av
   * først når elementet har trukket strøm og deretter stått uten i `metningMinutter`, også
   * om det er etter fristen. Slik er tanken alltid ferdig oppvarmet, og legionellasikringen
   * er reell.
   */
  avgjor(ms, bryterPa, effektW, kontekst) {
    const i = this.i;
    const m = this.m;
    const tvang = this.forfalt(ms) || m.tvungen;
    const boost = this.boostAktiv(ms);
    if (i.alltidPa) return { paa: true, grunn: 'alltid på' };
    if (!i.prisstyring && !tvang && !boost) return { paa: bryterPa, grunn: 'automatikken er av' };

    // --- En oppvarming er i gang ---
    if (bryterPa && m.syklus) {
      if (m.var_mettet) return { paa: false, grunn: 'termostaten har koblet ut' };
      // Har den først trukket strøm, står den til termostaten kobler ut — også om måleren faller ut en stund.
      if (m.har_trukket) return { paa: true, grunn: m.var_aktiv ? 'varmer' : 'venter på at termostaten kobler ut' };
      if (effektW === null) {
        // Uten effektmåling vet vi ikke når den er ferdig: stå på ut vinduet og la termostaten styre.
        const paa = this.iVindu(ms) || tvang || boost;
        return { paa, grunn: paa ? 'ingen effektmåling — står på ut vinduet' : 'ingen effektmåling — vinduet er slutt' };
      }
      // Har ikke trukket strøm siden påslag: enten er vannet alt varmt, eller så ser ikke
      // måleren elementet. Uansett skader det ikke å stå på — termostaten bestemmer.
      const paa = this.iVindu(ms) || tvang || boost || !this.utenEffekt(ms, bryterPa, effektW);
      return { paa, grunn: paa ? 'på, men trekker ikke strøm' : 'vinduet er slutt uten at den trakk strøm' };
    }

    // --- Skal en oppvarming starte? ---
    if (tvang) return { paa: true, grunn: 'legionellasikring' };
    if (boost) return { paa: true, grunn: 'boost' };
    const [hviler, hvilegrunn] = this.borteSparing(ms, kontekst);
    if (hviler) return { paa: false, grunn: hvilegrunn };
    if (effektW === null) return { paa: this.iVindu(ms), grunn: this.iVindu(ms) ? 'i vinduet' : 'utenfor vinduet' };
    if (this.ferdigIVinduet(ms) && this.legionellaOk(ms)) return { paa: false, grunn: 'ferdig for i natt' };
    if (this.maaRekke(ms, kontekst)) return { paa: true, grunn: `må starte nå for å være ferdig til kl. ${i.klarInnen}` };
    if (this.billigTimeNaa(ms, kontekst)) {
      return kontekst.trangt ? { paa: false, grunn: 'i vinduet, men timen er trang — venter med å starte' } : { paa: true, grunn: i.folgSpotpris ? 'billig time' : 'i vinduet' };
    }
    return { paa: false, grunn: 'utenfor vinduet' };
  }

  borVarme(ms, bryterPa, effektW, kontekst) {
    return this.avgjor(ms, bryterPa, effektW, kontekst).paa;
  }

  // ------------------------------------------------------------------
  //  Hovedløkke
  // ------------------------------------------------------------------
  /**
   * @param {object} inn
   * @param {number} inn.ms
   * @param {boolean|null} inn.bryter releet er på / av / svarer ikke
   * @param {number|null} inn.effektW
   * @param {object} inn.spot Spotpriser
   * @param {object} inn.kontekst {borte, hjemkomstMs, norgespris, trangt}
   * @returns {{paa: boolean|null, hendelser: Array, bilde: object}} `paa` null = ikke rør releet
   */
  tick({ ms, bryter, effektW, spot, kontekst = {} }) {
    const m = this.m;
    const i = this.i;
    const hendelser = [];
    // Ukjent historikk (nyinstallert): anta at vannet var varmt for et døgn siden. «Nå» ville
    // fått berederen til å tro at den var ferdig for natta, og den første natta ble kald.
    if (m.siste_syklus === null) m.siste_syklus = ms - DOGN_MS;
    if (bryter === null) return { paa: null, hendelser, bilde: this.bilde(ms, bryter, effektW, kontekst, 'Releet svarer ikke — rører det ikke') };

    // Releet er nettopp slått på (av oss, eller av noen andre): en oppvarming har begynt.
    if (bryter && m.siste_bryter !== true) { m.har_trukket = false; m.startet = ms; m.syklus = true; m.under_siden = null; }
    if (!bryter) m.syklus = false;
    m.siste_bryter = bryter;

    const aktiv = effektW !== null && effektW > i.terskelW;
    if (effektW !== null) {
      if (aktiv) m.under_siden = null; else if (m.under_siden === null) m.under_siden = ms;
    }
    if (aktiv && !m.var_aktiv) { m.har_trukket = true; m.kritisk = false; }
    m.var_aktiv = aktiv;

    const mettet = bryter && m.har_trukket && effektW !== null && !aktiv && m.under_siden !== null
      && ms - m.under_siden >= i.metningMinutter * 60000;
    let paa = null;
    if (mettet && !m.var_mettet) {
      const min = m.startet ? Math.round((ms - m.startet) / 60000) : 0;
      m.siste_syklus = ms;
      m.tvungen = false;
      m.legionella_varslet = false;
      m.uten_effekt = 0;
      if (min >= 10) m.varigheter = [...m.varigheter, min].slice(-5);
      if (this.boostAktiv(ms)) m.boost_til = ms;            // boosten har gjort jobben sin
      hendelser.push({ type: 'mettet', tekst: `Berederen er varm etter ${min} minutter. Legionellasikringen er bekreftet.` });
      if (i.prisstyring && !i.alltidPa) paa = false;
    }
    m.var_mettet = Boolean(mettet);

    // Releet har stått på et helt døgn uten at elementet trekker strøm: da er noe galt.
    if (this.utenEffekt(ms, bryter, effektW) && (ms - m.startet) / TIME_MS >= 24 && !m.kritisk) {
      m.kritisk = true;
      hendelser.push({ type: 'feil', tekst: 'Berederen har stått på i et døgn uten å trekke strøm. Sjekk sikring og element, og at releet måler berederens effekt.' });
    }

    if (this.forfalt(ms) && !mettet && !m.tvungen) {
      m.tvungen = true;
      hendelser.push({ type: 'legionella', tekst: `Det er ${this.dagerSiden(ms).toFixed(1)} dager siden berederen sist var varm. Varmer nå uansett pris.` });
    }

    // Legionella: si fra når ønsket intervall er passert, lenge før den harde fristen tvinger.
    const dager = this.dagerSiden(ms);
    if (i.legionellaAktiv && !m.legionella_varslet && !mettet && !this.forfalt(ms) && dager > i.intervallDager
      && !this.borteSparing(ms, kontekst)[0]) {
      m.legionella_varslet = true;
      hendelser.push({ type: 'legionella_varsel', tekst: `Det er ${dager.toFixed(1)} dager siden berederen sist var varm (målet er hver ${i.intervallDager}. dag). Den varmes til termostaten kobler ut i neste vindu.` });
    }
    const morgen = this.morgensjekk(ms, effektW, kontekst);
    if (morgen) hendelser.push(morgen);

    if (!m.billige_ms || ms - m.billige_ms >= 15 * 60000) { m.billige = this.billigeTimer(ms, spot); m.billige_ms = ms; }

    const valg = this.avgjor(ms, bryter, effektW, kontekst);
    const styrer = i.prisstyring || this.boostAktiv(ms) || m.tvungen || this.forfalt(ms);
    if (paa === null && styrer) {
      if (valg.paa && !bryter) paa = true;
      else if (!valg.paa && bryter) {
        paa = false;
        // Sto på uten å trekke strøm: vi vet ikke om vannet var varmt. Det bekreftes ikke som
        // varmt, og gjentar det seg, sier vi fra — da måler trolig ikke releet berederen.
        if (m.syklus && !m.har_trukket && effektW !== null) {
          m.uten_effekt += 1;
          if (m.uten_effekt === 2) hendelser.push({ type: 'ingen_effekt', tekst: 'Berederen har stått på to netter uten at det er målt strømtrekk. Enten var vannet alt varmt, eller så måler ikke releet berederens effekt. Uten måling kan ikke appen bekrefte at vannet er varmt.' });
        }
      }
    }
    if (paa !== null) {
      const grunn = mettet && !valg.paa ? `termostaten koblet ut etter ${m.startet ? Math.round((ms - m.startet) / 60000) : 0} min` : valg.grunn;
      m.logg = m.logg.concat([{ ms, paa, grunn }]).slice(-12);
      if (paa) m.syklus = true;
    }
    return { paa, hendelser, bilde: this.bilde(ms, bryter, effektW, kontekst) };
  }

  /** Effekt motoren må holde av til berederen (kW), og om den går foran varmen. */
  reservasjon(ms, bryter, effektW, kontekst = {}) {
    if (!this.konfigurert() || bryter === null) return { kw: 0, maa: false };
    const nominell = Number(this.i.nominellKw) || 2;
    if (this.m.var_aktiv) return { kw: Math.max((effektW || 0) / 1000, nominell * 0.9), maa: true };
    if (this.m.var_mettet || this.borteSparing(ms, kontekst)[0]) return { kw: 0, maa: false };
    if (this.forfalt(ms) || this.m.tvungen || this.maaRekke(ms, kontekst)) return { kw: nominell, maa: true };
    if (this.borVarme(ms, bryter, effektW, kontekst)) return { kw: nominell, maa: false };
    if (this.iVindu(ms)) return { kw: nominell * 0.5, maa: false };
    return { kw: 0, maa: false };
  }

  bilde(ms, bryter, effektW, kontekst, feil = null) {
    const m = this.m;
    const d = this.dagerSiden(ms);
    const [hviler, hvilegrunn] = this.borteSparing(ms, kontekst || {});
    let status;
    let forklaring;
    if (feil) { status = 'Svarer ikke'; forklaring = feil; }
    else if (m.kritisk) { status = 'Feil'; forklaring = 'Har stått på uten å trekke strøm. Sjekk sikring og element.'; }
    else if (m.var_aktiv) { status = 'Varmer'; forklaring = 'Varmer. Slås ikke av før berederens egen termostat har koblet ut.'; }
    else if (bryter && m.syklus && m.har_trukket && !m.var_mettet) { status = 'Venter på termostaten'; forklaring = `Elementet trekker ikke strøm. Slås av når det har vart i ${this.i.metningMinutter} minutter.`; }
    else if (m.var_mettet) { status = 'Varm'; forklaring = 'Termostaten har koblet ut — vannet er på settpunkt.'; }
    else if (this.forfalt(ms) || m.tvungen) { status = 'Tvungen kjøring'; forklaring = 'Legionellasikring: varmer uansett pris og effekt.'; }
    else if (this.boostAktiv(ms)) { status = 'Boost'; forklaring = 'Boost — varmer nå.'; }
    else if (!this.i.prisstyring) { status = 'Manuell'; forklaring = 'Automatikken er av. Berederen står som den står.'; }
    else if (hviler) { status = 'Hviler (borte)'; forklaring = `Bortemodus: ${hvilegrunn}.`; }
    else if (this.maaRekke(ms, kontekst || {})) { status = 'Må rekke fristen'; forklaring = `Varmer uansett pris og effekt for å være ferdig til kl. ${this.i.klarInnen}.`; }
    else if (bryter && m.syklus && !m.har_trukket && effektW !== null && this.i.prisstyring && this.avgjor(ms, bryter, effektW, kontekst || {}).paa) { status = 'På, trekker ikke strøm'; forklaring = 'Står på, men elementet trekker ikke strøm: vannet er alt varmt, eller releet måler ikke berederens effekt.'; }
    else if (this.ferdigIVinduet(ms)) { status = 'Ferdig for i natt'; forklaring = `Neste vindu åpner kl. ${this.i.vinduStart}.`; }
    else if (this.iVindu(ms)) { status = 'Venter på start'; forklaring = kontekst && kontekst.trangt ? 'I vinduet, men timen er for trang akkurat nå.' : 'I vinduet, venter på start.'; }
    else { status = 'Venter på vinduet'; forklaring = `Vinduet åpner kl. ${this.i.vinduStart}.`; }
    return {
      status, forklaring,
      bryter, effekt_w: effektW, varmer: m.var_aktiv, mettet: m.var_mettet,
      dager_siden_varm: d === null ? null : Math.round(d * 10) / 10,
      legionella_ok: this.legionellaOk(ms), forfalt: this.forfalt(ms), tvungen: m.tvungen,
      legionella: this.legionellaStatus(ms),
      legionella_tekst: this.legionellaTekst(ms),
      sist_varm: m.siste_syklus === null ? null : new Date(m.siste_syklus).toISOString(),
      frist: this.i.klarInnen,
      klar_til_frist: m.morgen ? m.morgen.klar : null,
      frist_tekst: m.morgen ? m.morgen.tekst : 'Ikke sjekket ennå — første sjekk ved neste frist.',
      maa_rekke: this.maaRekke(ms, kontekst || {}),
      behov_min: this.behovMin(),
      boost_til: this.boostAktiv(ms) ? new Date(m.boost_til).toISOString() : null,
      billige_timer: m.billige.map((t) => osloDeler(t).time),
      logg: m.logg.slice(-8).map((h) => ({ tid: new Date(h.ms).toISOString(), paa: h.paa, grunn: h.grunn })),
    };
  }

  legionellaTekst(ms) {
    const d = this.dagerSiden(ms);
    const siden = d === null ? 'ukjent' : `${d.toFixed(1)} dager`;
    if (!this.i.legionellaAktiv) return `Legionellasikringen er slått av. Sist varm for ${siden} siden.`;
    const s = this.legionellaStatus(ms);
    if (s === 'sikret') return `Sikret: varm for ${siden} siden (målet er hver ${this.i.intervallDager}. dag).`;
    if (s === 'bor_varmes') return `Bør varmes: ${siden} siden sist. Tvinges etter ${this.i.maksDager} dager.`;
    return `Forfalt: ${siden} siden sist. Varmes nå uansett pris og effekt.`;
  }

  boost(ms, min = 60) { this.m.boost_til = ms + min * 60000; }

  avbrytBoost(ms) { this.m.boost_til = ms; }

  tvingSyklus() { this.m.tvungen = true; }
}

module.exports = { Bereder, STANDARD };
