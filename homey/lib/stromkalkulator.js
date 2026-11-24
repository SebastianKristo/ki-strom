'use strict';

/**
 * Strømkalkulatoren: fra målerens register og spotpriser til nettleie, strømstøtte,
 * Norgespris og månedskostnad.
 *
 * Regner på samme måte som Strømkalkulator for Home Assistant (fredrik-lindseth/Stromkalkulator):
 *  - forbruket leses som delta fra målerens kWh-register (samme tall som Elhub og fakturaen);
 *    uten register Riemann-summeres effekten
 *  - hvert intervall prises med sin egen spotpris, tariff og sats, og bokføres da
 *  - kapasitetsleddet følger nettselskapets metode (se fastledd.js) og er et periodebeløp
 *
 * Klassen er ren: ingen Homey, ingen klokke, ingen nett. Appen mater den med prøver og
 * lagrer `tilstand` (et vanlig objekt) mellom omstarter.
 */

const kal = require('./kalender');
const avg = require('./avgifter');
const fl = require('./fastledd');
const kost = require('./kostnad');
const { Timemaler } = require('./timemaler');

const TIME_MS = 3600000;
const MAKS_EFFEKT_W = 500000;        // avvis åpenbart gale målinger
const MAKS_RIEMANN_TIMER = 0.1;      // 6 min — lengre hull integreres ikke (klokkehopp, utfall)
const MAKS_DELTA_KWH = 100;          // større sprang enn dette er ikke forbruk
const STILLE_PROVE_MS = 90 * 60000;   // uendret register: ny prøve til timemåleren etter så lenge
const EGENDEFINERT = 'custom';   // katalogens oppføring for egne satser

const rund = (v, n = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);

const STANDARD_INNSTILLINGER = {
  nettselskap: 'elvia',
  boligtype: 'bolig',
  harNorgespris: false,
  avgiftssone: null,            // null = følger nettselskapet
  sikringstrinn: null,          // bare nettselskap med fastledd etter hovedsikring
  varselTerskelKw: 2.0,
  // Egendefinert nettselskap, eller overstyring av katalogen (kr/kWh eks. mva og avgifter):
  energileddDagEksMva: null,
  energileddNattEksMva: null,
  egneTrinn: '',                // «2:155,5:250,10:415»
  prisomraade: null,            // null = følger nettselskapet
  // Månedens topper fra før appen begynte å måle (kW, fra nettselskapet). Gjelder bare måneden de ble lagt inn i.
  startTopper: [],
  startMaaned: null,            // «2026-11» — settes når toppene lagres
};

/** «5,2 4.8;4,6» eller [5.2, 4.8] → inntil tre positive tall. */
function tolkTopper(verdi) {
  const deler = Array.isArray(verdi) ? verdi : String(verdi ?? '').split(/[\s;]+|,(?=\s)/);
  return deler.map((x) => Number(String(x).replace(',', '.'))).filter((x) => Number.isFinite(x) && x > 0 && x < 100).slice(0, 3);
}

class Stromkalkulator {
  /**
   * @param {object} tilstand lagret tilstand (endres på stedet)
   * @param {object} innstillinger se STANDARD_INNSTILLINGER
   * @param {object} tariffer innholdet i tariffer.json
   */
  constructor(tilstand, innstillinger, tariffer) {
    this.t = tilstand;
    this.tariffer = tariffer;
    this.settInnstillinger(innstillinger);
    const t = this.t;
    t.maler = t.maler || {};
    t.doegnmaks = t.doegnmaks || {};      // dato → {kw, time} for inneværende og forrige måned
    t.ukestopper = t.ukestopper || {};    // mandag → {kw, dato}, løpende tolv måneder
    t.kroner = t.kroner || kost.ingenKroner();
    t.kwh_dag = t.kwh_dag || 0;
    t.kwh_natt = t.kwh_natt || 0;
    t.dag = t.dag || { dato: null, energi_kr: 0, kwh: 0 };
    t.syntetisk_kwh = t.syntetisk_kwh || 0;
    if (t.maaned === undefined) t.maaned = null;
    if (t.sist === undefined) t.sist = null;
    if (t.forrige === undefined) t.forrige = null;
    if (t.sist_effekt === undefined) t.sist_effekt = null;
    this.maler = new Timemaler(t.maler);
  }

  settInnstillinger(innstillinger) {
    this.i = { ...STANDARD_INNSTILLINGER, ...(innstillinger || {}) };
    const fusjonert = (this.tariffer.fusjoner || {})[this.i.nettselskap];
    if (fusjonert) this.i.nettselskap = fusjonert;
  }

  // ------------------------------------------------------------------
  //  Tariff og satser
  // ------------------------------------------------------------------
  /** Nettselskapets oppføring, med brukerens egne satser og trinn lagt oppå. */
  dso() {
    const i = this.i;
    const katalog = this.tariffer.nettselskap[i.nettselskap];
    const grunn = katalog || {
      name: 'Egendefinert', prisomrade: i.prisomraade || 'NO1', supported: true,
      energiledd_dag_eks_mva: 0, energiledd_natt_eks_mva: 0, kapasitetstrinn: [],
    };
    const dso = { ...grunn };
    if (i.energileddDagEksMva !== null && i.energileddDagEksMva !== undefined && i.energileddDagEksMva !== '') {
      dso.energiledd_dag_eks_mva = Number(i.energileddDagEksMva);
      delete dso.energiledd_perioder;
    }
    if (i.energileddNattEksMva !== null && i.energileddNattEksMva !== undefined && i.energileddNattEksMva !== '') {
      dso.energiledd_natt_eks_mva = Number(i.energileddNattEksMva);
      delete dso.energiledd_perioder;
    }
    if (i.egneTrinn && String(i.egneTrinn).trim()) {
      try {
        this.trinnfeil = null;
        dso.kapasitetstrinn = fl.parseKapasitetstrinn(i.egneTrinn);
        delete dso.kapasitetstrinn_per_boligtype;
        delete dso.kjent_fastledd_maks_kw;
      } catch (e) {
        this.trinnfeil = e.message;
      }
    }
    return dso;
  }

  avgiftssone() {
    return this.i.avgiftssone || avg.avgiftssoneFor(this.dso());
  }

  prisomraade() {
    return this.i.prisomraade || this.dso().prisomrade || 'NO1';
  }

  /** Energileddet eks. mva som gjelder på tidspunktet: {dag, natt, periode}. Sesongperioder går foran. */
  energileddEksMva(ms) {
    const dso = this.dso();
    const periode = fl.finnAktivPeriode(dso.energiledd_perioder, kal.osloDato(ms).slice(5));
    if (periode) return { dag: periode.dag_eks_mva, natt: periode.natt_eks_mva, periode };
    return { dag: dso.energiledd_dag_eks_mva, natt: dso.energiledd_natt_eks_mva, periode: null };
  }

  /** Satsene som gjelder for et intervall som begynner på `ms`. */
  satser(ms) {
    const sone = this.avgiftssone();
    const dag = kal.erDagtariff(ms, this.dso());
    const eks = this.energileddEksMva(ms);
    return {
      dag,
      energileddInklMva: avg.energileddInklMva(dag ? eks.dag : eks.natt, sone),
      avgifterInklMva: avg.avgifterInklMva(sone),
      mvaSats: avg.mvaSats(sone),
      norgesprisInklMva: avg.norgesprisInklMva(sone),
      stromstotteTerskel: avg.stromstotteTerskel(sone),
      stromstotteMaksKwh: avg.stromstotteMaksKwh(this.i.boligtype),
      norgesprisMaksKwh: avg.norgesprisMaksKwh(this.i.boligtype),
      harNorgespris: Boolean(this.i.harNorgespris),
    };
  }

  fastleddtariff() {
    return fl.lagTariff(this.dso(), {
      boligtype: this.i.boligtype, mvaSats: avg.mvaSats(this.avgiftssone()), sikringstrinn: this.i.sikringstrinn,
    });
  }

  // ------------------------------------------------------------------
  //  Inndata
  // ------------------------------------------------------------------
  /**
   * Effektmåling (W). Brukes bare når måleren ikke har kWh-register: effekten
   * Riemann-summeres til et syntetisk register og går samme vei som et ekte.
   */
  effekt(ms, watt, spot) {
    if (!Number.isFinite(watt) || watt < 0 || watt > MAKS_EFFEKT_W) return [];
    const forrige = this.t.sist_effekt;
    if (forrige && ms > forrige.ms) {
      const timer = (ms - forrige.ms) / TIME_MS;
      // Venstre Riemann: effekten som gjaldt i perioden som gikk.
      if (timer <= MAKS_RIEMANN_TIMER) this.t.syntetisk_kwh += (forrige.w / 1000) * timer;
    }
    this.t.sist_effekt = { ms, w: watt };
    return this.energi(ms, this.t.syntetisk_kwh, spot);
  }

  /**
   * Registerprøve (kWh). Bokfører forbruket siden forrige prøve og lukker ferdige timer.
   * Returnerer timene som ble lukket: [{start, kwh, kvalitet}].
   */
  energi(ms, kwh, spot) {
    if (!Number.isFinite(kwh) || kwh < 0) return [];
    const t = this.t;
    if (t.maaned === null) t.maaned = kal.osloMaaned(ms);
    if (!t.startet_ms) t.startet_ms = ms;      // første måling noensinne: herfra kjenner vi forbruket
    const sist = t.sist;
    // Uendret register er ikke en ny måling. Mange HAN-målere oppdaterer registeret bare én
    // gang i timen; flyttet vi nullpunktet fram hvert minutt, ville hele timens forbruk blitt
    // bokført på det siste minuttet — med neste times pris og tariff.
    if (sist && kwh === sist.kwh) {
      // Står registeret stille lenge (ingen last, eller en måler som sover), får timemåleren
      // likevel en prøve i ny og ne — ellers blir hullet for langt til å interpolere over.
      if (ms - (t.sist_prove_ms || 0) >= STILLE_PROVE_MS) {
        this.maler.prove(ms / 1000, kwh);
        t.sist_prove_ms = ms;
      }
      return this.tikk(ms);
    }
    const nullstilt = this.maler.prove(ms / 1000, kwh);
    t.sist_prove_ms = ms;
    if (!sist || nullstilt || kwh < sist.kwh || ms <= sist.ms) {
      // Første prøve, målerbytte eller en prøve fra fortiden: nytt nullpunkt, ingenting bokføres.
      if (!sist || nullstilt || kwh < sist.kwh) t.sist = { ms, kwh };
    } else {
      const delta = kwh - sist.kwh;
      if (delta <= MAKS_DELTA_KWH) this._bokfor(sist.ms, ms, delta, spot);
      t.sist = { ms, kwh };
    }
    return this.tikk(ms);
  }

  /** Klokka går uten ny måling: månedsskifte og timer som kan lukkes. Returnerer lukkede timer. */
  tikk(ms) {
    if (this.t.maaned === null) return [];
    this._maanedsskifte(ms);
    const lukket = this.maler.oppdater(ms / 1000);
    for (const rad of lukket) this._timeLukket(rad);
    return lukket;
  }

  /** Fordel `kwh` jevnt over [fra, til) og bokfør hver klokketime for seg, med timens egen pris og tariff. */
  _bokfor(fra, til, kwh, spot) {
    const t = this.t;
    const varighet = til - fra;
    let a = fra;
    while (a < til) {
      const b = Math.min(til, kal.timestart(a) + TIME_MS);
      const del = kwh * ((b - a) / varighet);
      this._maanedsskifte(a);
      const satser = this.satser(a);
      const pris = spot ? spot.snitt(a, b) : null;
      const kroner = kost.kronerForIntervall({ kwh: del, dag: satser.dag, prisEksMva: pris }, satser, t.kroner.kwh);
      t.kroner = kost.pluss(t.kroner, kroner);
      if (satser.dag) t.kwh_dag += del; else t.kwh_natt += del;
      const dato = kal.osloDato(a);
      if (t.dag.dato !== dato) t.dag = { dato, energi_kr: 0, kwh: 0 };
      t.dag.energi_kr += kost.energiKr(kroner);
      t.dag.kwh += del;
      a = b;
    }
  }

  /** Ny kalendermåned i Oslo: arkiver måneden som gikk og begynn på null. */
  _maanedsskifte(ms) {
    const t = this.t;
    const maaned = kal.osloMaaned(ms);
    if (t.maaned === null) { t.maaned = maaned; return; }
    if (maaned <= t.maaned) return;
    t.forrige = {
      maaned: t.maaned, kroner: t.kroner, kwh_dag: t.kwh_dag, kwh_natt: t.kwh_natt,
      har_norgespris: Boolean(this.i.harNorgespris), fastledd: this._fastledd(t.maaned),
    };
    t.maaned = maaned;
    t.kroner = kost.ingenKroner();
    t.kwh_dag = 0;
    t.kwh_natt = 0;
    // Behold døgnmaks for måneden som gikk (siste time lukkes etter skiftet); eldre ryddes.
    for (const dato of Object.keys(t.doegnmaks)) {
      if (dato.slice(0, 7) < t.forrige.maaned) delete t.doegnmaks[dato];
    }
  }

  /** En time er lukket: oppdater døgnmaks og ukestopp for timens egen dato. */
  _timeLukket(rad) {
    if (rad.kwh === null || rad.kwh === undefined) return;
    const t = this.t;
    const startMs = rad.start * 1000;
    const dato = kal.osloDato(startMs);
    const time = kal.osloDeler(startMs).time;
    const kw = rad.kwh;   // kWh i én time = snitteffekt i kW
    if (!t.doegnmaks[dato] || kw > t.doegnmaks[dato].kw) t.doegnmaks[dato] = { kw, time };
    const uke = kal.ukestart(dato);
    if (!t.ukestopper[uke] || kw > t.ukestopper[uke].kw) t.ukestopper[uke] = { kw, dato };
    // Ukestopper eldre enn tolv kalendermåneder (toppens egen dato) er ute.
    const d = kal.osloDeler(startMs);
    const grense = kal.isoDato(d.aar - 1, d.mnd, d.dag);
    for (const [k, v] of Object.entries(t.ukestopper)) {
      if (v.dato <= grense) delete t.ukestopper[k];
    }
    // Månedens siste time lukkes like etter månedsskiftet: fastleddet for forrige måned fryses da.
    if (t.forrige && dato.slice(0, 7) === t.forrige.maaned) t.forrige.fastledd = this._fastledd(t.forrige.maaned);
  }

  // ------------------------------------------------------------------
  //  Avledet
  // ------------------------------------------------------------------
  /** Månedens døgnmakser, høyeste først: [{dato, kw, time}]. */
  topper(maaned = this.t.maaned) {
    // Toppene fra før appen begynte å måle teller som egne dager i måneden de ble lagt inn for.
    const start = this.i.startMaaned === maaned
      ? tolkTopper(this.i.startTopper).map((kw, n) => ({ dato: `${maaned}-00 (${n + 1})`, kw, time: null, start: true }))
      : [];
    return Object.entries(this.t.doegnmaks)
      .filter(([dato]) => dato.slice(0, 7) === maaned)
      .map(([dato, v]) => ({ dato, kw: v.kw, time: v.time }))
      .concat(start)
      .sort((a, b) => b.kw - a.kw || (a.dato < b.dato ? -1 : 1));
  }

  /** Fastleddet for en måned med dagens tariff: grunnlag, trinn, pris og margin. */
  _fastledd(maaned = this.t.maaned) {
    const tariff = this.fastleddtariff();
    const topper = this.topper(maaned);
    const grunnlag = fl.fastleddGrunnlag(tariff, topper.map((x) => x.kw), Object.values(this.t.ukestopper));
    const trinn = fl.fastleddForGrunnlag(tariff, grunnlag);
    const ukjent = fl.fastleddBelopUkjent(tariff, grunnlag);
    const neste = fl.nesteTrinn(tariff, grunnlag, trinn.pris);
    return {
      metode: tariff.metode,
      grunnlag_kw: grunnlag,
      topp3: topper.slice(0, 3),
      pris: ukjent ? null : trinn.pris,
      trinn_nr: trinn.nummer,
      trinn_tekst: trinn.tekst,
      margin_kw: neste.marginKw,
      neste_terskel_kw: neste.terskel,
      neste_pris: neste.nestePris,
      har_neste: !(neste.marginKw === 0 && neste.nestePris === trinn.pris),
    };
  }

  /**
   * Hvor høy kan en time bli i dag uten at fastleddet går opp et trinn?
   * Returnerer kWh, eller null når metoden ikke har trinn / ingen høyere trinn finnes.
   * Brukes av effektmotoren (trinn 2).
   */
  takForIdag(ms, maalKw = null) {
    const tariff = this.fastleddtariff();
    if (!fl.TRINNBASERTE.has(tariff.metode) || !tariff.trinn.length) return null;
    const idag = kal.osloDato(ms);
    const andre = this.topper().filter((x) => x.dato !== idag).map((x) => x.kw);
    const f = this._fastledd();
    // Et ønsket trinn («hold meg under 5 kW») gjelder så lenge det kan nås. Er det alt
    // passert, er neste grense over dagens snitt det som står igjen å forsvare.
    let terskel = f.har_neste ? f.neste_terskel_kw : null;
    if (maalKw !== null && Number.isFinite(Number(maalKw)) && f.grunnlag_kw < Number(maalKw)) terskel = Number(maalKw);
    if (terskel === null) return null;
    if (tariff.metode === fl.METODE.MND_MAX) return terskel;
    // Dager vi ikke kjenner ennå regnes som om de når terskelen — ikke som null. Ellers ville
    // månedens første dager fått tre ganger så stort rom som resten.
    const toAndre = andre.slice(0, 2);
    while (toAndre.length < 2) toAndre.push(terskel);
    return 3 * terskel - toAndre[0] - toAndre[1];
  }

  /**
   * Hva én kWh til koster i timen som begynner på `ms`: kraft (etter strømstøtte, eller
   * Norgespris) pluss energiledd. Fastleddet er ikke med — det følger toppene, ikke kWh.
   * Uten spotpris brukes `reserve` for kraften, så planleggeren fortsatt ser dag/natt-tariffen.
   */
  marginalpris(ms, spot, reserve = 1.0) {
    const satser = this.satser(ms);
    const mnd = this.t.kroner.kwh;
    const eks = spot ? spot.snitt(kal.timestart(ms), kal.timestart(ms) + TIME_MS) : null;
    let kraft;
    if (satser.harNorgespris && mnd < satser.norgesprisMaksKwh) kraft = satser.norgesprisInklMva;
    else if (eks === null) kraft = reserve;
    else {
      const inkl = eks * (1 + satser.mvaSats);
      const stotte = !satser.harNorgespris && mnd < satser.stromstotteMaksKwh ? avg.stromstottePerKwh(inkl, satser.stromstotteTerskel) : 0;
      kraft = inkl - stotte;
    }
    return kraft + satser.energileddInklMva;
  }

  /** Alt appen viser: priser nå, kapasitetstrinn, månedstall og forrige måned. */
  snapshot(ms, spot, naaKwh = null) {
    const t = this.t;
    const i = this.i;
    const satser = this.satser(ms);
    const sone = this.avgiftssone();
    const eks = this.energileddEksMva(ms);
    const f = this._fastledd();
    const kroner = t.kroner;
    const mndKwh = kroner.kwh;

    const spotEks = spot ? spot.prisVed(ms) : null;
    const spotInkl = spotEks === null ? null : spotEks * (1 + satser.mvaSats);
    const stotteGjenstaar = Math.max(0, satser.stromstotteMaksKwh - mndKwh);
    const stotte = spotInkl === null || i.harNorgespris || stotteGjenstaar <= 0 ? 0 : avg.stromstottePerKwh(spotInkl, satser.stromstotteTerskel);
    const norgesprisOverTak = mndKwh >= satser.norgesprisMaksKwh;
    const fastleddPerKwh = (f.pris || 0) / kal.dagerIMaaned(ms) / 24;
    const energiledd = satser.energileddInklMva;

    // Kraftprisen kunden betaler nå, og hva alternativet (Norgespris ↔ spot med støtte) ville kostet.
    const stotteUtenNorgespris = spotInkl === null || stotteGjenstaar <= 0 ? 0 : avg.stromstottePerKwh(spotInkl, satser.stromstotteTerskel);
    const kraftNorgespris = norgesprisOverTak ? spotInkl : satser.norgesprisInklMva;
    const kraftSpot = spotInkl === null ? null : spotInkl - stotteUtenNorgespris;
    const kraft = i.harNorgespris ? kraftNorgespris : kraftSpot;
    const alternativ = i.harNorgespris ? kraftSpot : kraftNorgespris;
    const total = kraft === null ? null : kraft + energiledd + fastleddPerKwh;

    const andel = kal.forloptAndelAvMaaned(ms);
    const fastleddHittil = kost.fastleddBelop(f.pris, andel);
    const energileddKr = kost.energileddKr(kroner);
    const energiKr = kost.energiKr(kroner);
    const [mndStart, mndSlutt] = kal.maanedsvindu(ms);
    const d = kal.osloDeler(ms);
    const sekunderIdag = (ms - kal.osloTilUtc(d.aar, d.mnd, d.dag)) / 1000;
    const dagensFastledd = kost.fastleddBelop(f.pris, (sekunderIdag * 1000) / (mndSlutt - mndStart));
    const idag = t.dag.dato === kal.osloDato(ms) ? t.dag : { energi_kr: 0, kwh: 0 };
    const [timeKwh, timeKvalitet] = this.maler.forelopig(ms / 1000, naaKwh ?? (t.sist ? t.sist.kwh : null));

    const problemer = [];
    if (spotEks === null) problemer.push('spotpris mangler');
    if (!this.tariffer.nettselskap[i.nettselskap] && i.nettselskap !== EGENDEFINERT) problemer.push('ukjent nettselskap');
    if (f.pris === null) problemer.push(f.trinn_tekst);
    if (this.trinnfeil) problemer.push(`egne trinn: ${this.trinnfeil}`);
    // Kapasitetstrinnet bygger på månedens topper. Uten målinger, eller med målinger fra bare en
    // del av måneden, er det for lavt — si fra i stedet for å vise et galt trinn uten forbehold.
    const harStart = i.startMaaned === t.maaned && tolkTopper(i.startTopper).length > 0;
    const maaltFra = t.startet_ms ? kal.osloDato(t.startet_ms) : null;
    const delAvMaaned = maaltFra !== null && maaltFra.slice(0, 7) === t.maaned && maaltFra.slice(8) !== '01';
    if (!t.sist) problemer.push('ingen målerdata ennå — sjekk at strømmåleren er valgt');
    const merknader = [];      // forbehold som ikke er feil: vises, men slår ikke ut som måledata-problem
    if (t.sist && !f.topp3.length) merknader.push('ingen topper ennå — den første kommer når en hel klokketime er målt');
    if (delAvMaaned && !harStart && fl.TRINNBASERTE.has(f.metode)) {
      merknader.push(`kapasitetstrinnet bygger bare på målinger fra ${maaltFra.slice(8)}.${maaltFra.slice(5, 7)}. — legg inn månedens topper fra nettselskapet under Strøm`);
    }
    if (kroner.kwh_uten_pris > 0.01) problemer.push(`${rund(kroner.kwh_uten_pris, 1)} kWh uten spotpris denne måneden`);

    const forrige = t.forrige ? this._forrigeSnapshot() : null;

    return {
      tid: new Date(ms).toISOString(),
      nettselskap: this.dso().name,
      prisomraade: this.prisomraade(),
      avgiftssone: sone,
      boligtype: i.boligtype,
      nettleie: {
        tariff: satser.dag ? 'dag' : 'natt',
        energiledd: rund(energiledd, 4),
        energiledd_dag: rund(avg.energileddInklMva(eks.dag, sone), 4),
        energiledd_natt: rund(avg.energileddInklMva(eks.natt, sone), 4),
        sesongperiode: eks.periode ? `${eks.periode.fra}–${eks.periode.til}` : null,
        offentlige_avgifter: rund(satser.avgifterInklMva, 4),
        fastledd_metode: f.metode,
        kapasitetsledd: f.pris,
        kapasitetstrinn_nr: f.trinn_nr,
        kapasitetstrinn: f.trinn_tekst,
        grunnlag_kw: rund(f.grunnlag_kw, 2),
        snitt_topp_kw: rund(f.topp3.length ? f.topp3.reduce((s, x) => s + x.kw, 0) / f.topp3.length : 0, 2),
        topper: f.topp3.map((x) => ({ dato: x.start ? null : x.dato, time: x.time, kw: rund(x.kw, 2), start: Boolean(x.start) })),
        maalt_fra: maaltFra,
        kapasitetstrinn_usikkert: delAvMaaned && !harStart && fl.TRINNBASERTE.has(f.metode),
        startverdier: harStart,
        margin_kw: f.margin_kw,
        neste_trinn_pris: f.neste_pris,
        kapasitetsvarsel: f.har_neste ? f.margin_kw < Number(i.varselTerskelKw) : false,
        tak_idag_kwh: rund(this.takForIdag(ms), 2),
        fastledd_per_kwh: rund(fastleddPerKwh, 4),
      },
      pris: {
        spot_eks_mva: rund(spotEks, 4),
        spot: rund(spotInkl, 4),
        stromstotte: rund(stotte, 4),
        spot_etter_stotte: rund(spotInkl === null ? null : spotInkl - stotte, 4),
        stromstotte_gjenstaaende_kwh: rund(stotteGjenstaar, 1),
        norgespris: satser.norgesprisInklMva,
        har_norgespris: Boolean(i.harNorgespris),
        norgespris_aktiv: Boolean(i.harNorgespris) && !norgesprisOverTak,
        kraft: rund(kraft, 4),
        strompris: rund(kraft === null ? null : kraft + energiledd, 4),
        total: rund(total, 4),
        total_uten_stotte: rund(spotInkl === null ? null : (i.harNorgespris ? kraftNorgespris : spotInkl) + energiledd + fastleddPerKwh, 4),
        prisforskjell_norgespris: rund(alternativ === null || kraft === null ? null : alternativ - kraft, 4),
      },
      maaned: {
        maaned: t.maaned,
        kwh: rund(mndKwh, 3),
        kwh_dag: rund(t.kwh_dag, 3),
        kwh_natt: rund(t.kwh_natt, 3),
        strom_kr: rund(kroner.strom_kr),
        stromstotte_kr: rund(kroner.stromstotte_kr),
        energiledd_kr: rund(energileddKr),
        avgifter_kr: rund(kroner.avgifter_kr),
        fastledd_kr: rund(fastleddHittil),
        nettleie_kr: rund(energileddKr + fastleddHittil),
        nettleie_total_kr: rund(energileddKr + fastleddHittil - kroner.stromstotte_kr),
        kostnad_kr: rund(energiKr + fastleddHittil),
        estimert_kr: andel > 0.01 ? rund(energiKr / andel + (f.pris || 0)) : null,
        norgespris_besparelse_kr: rund(kroner.norgespris_differanse_kr),
        norgespris_kompensasjon_kr: rund(kroner.norgespris_kompensasjon_kr),
        kwh_uten_pris: rund(kroner.kwh_uten_pris, 3),
      },
      idag: {
        kwh: rund(idag.kwh, 3),
        kostnad_kr: rund(idag.energi_kr + dagensFastledd),
      },
      time: { kwh: rund(timeKwh, 3), kvalitet: timeKvalitet },
      forrige_maaned: forrige,
      problemer,
      merknader,
    };
  }

  _forrigeSnapshot() {
    const p = this.t.forrige;
    const f = p.fastledd || {};
    const energileddKr = kost.energileddKr(p.kroner);
    return {
      maaned: p.maaned,
      kwh: rund(p.kroner.kwh, 3),
      kwh_dag: rund(p.kwh_dag, 3),
      kwh_natt: rund(p.kwh_natt, 3),
      strom_kr: rund(p.kroner.strom_kr),
      stromstotte_kr: rund(p.kroner.stromstotte_kr),
      energiledd_kr: rund(energileddKr),
      avgifter_kr: rund(p.kroner.avgifter_kr),
      kapasitetsledd: f.pris ?? null,
      kapasitetstrinn: f.trinn_tekst || null,
      snitt_topp_kw: rund(f.grunnlag_kw, 2),
      topper: (f.topp3 || []).map((x) => ({ dato: x.dato, time: x.time, kw: rund(x.kw, 2) })),
      nettleie_kr: rund(energileddKr + (f.pris || 0)),
      kostnad_kr: rund(kost.energiKr(p.kroner) + (f.pris || 0)),
      norgespris_kompensasjon_kr: rund(p.kroner.norgespris_kompensasjon_kr),
    };
  }
}

module.exports = { Stromkalkulator, STANDARD_INNSTILLINGER, EGENDEFINERT, MAKS_DELTA_KWH };
