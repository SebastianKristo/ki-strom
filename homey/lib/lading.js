'use strict';

/**
 * Elbillading: bilen får effekten varmen ikke bruker.
 *
 * Laderen styres med en bryter (lad / ikke lad) og en ladestrøm i ampere. Hvert tick får
 * ladingen vite hvor mye effekt som er ledig etter at rommene har fått sitt, og velger det
 * høyeste trinnet som får plass. Den fortrenger aldri en ovn.
 *
 * Samme regler som Home Assistant-versjonen (lading.py), med rettelsene derfra:
 *  - ned går alltid med en gang; dødbånd og minsteavstand gjelder bare oppover
 *  - bilen regnes som styrt last, ikke som husets øvrige forbruk
 *  - det er målt ladeeffekt som telles, så en nesten full bil holder ikke av mer enn den bruker
 *  - batterinivået har hysterese: stopper ved øvre grense, starter igjen under den nedre
 */

const { osloDeler } = require('./kalender');
const { minutter, mellom } = require('./program');

const SQRT3 = 1.7320508;

const STANDARD = {
  bryter: null,               // {enhet, kap} — av/på for ladingen
  strom: null,                // {enhet, kap} — ladestrøm i ampere (tall som kan settes)
  effekt: null,               // {enhet, kap} — bilens ladeeffekt (W)
  soc: null,                  // {enhet, kap} — batterinivå i prosent
  tilkoblet: null,            // {enhet, kap} — ja/nei: bilen står i laderen her
  automatikk: true,
  trinn: [6, 8, 10, 13, 16],  // ampere laderen kan settes til
  faser: 1,
  volt: 230,
  stoppVed: 80,               // prosent
  startUnder: 70,
  kunNatt: false,
  nattFra: '22:00',
  nattTil: '06:00',
  minMellomMin: 5,            // minste tid mellom to økninger
  dodbandKw: 0.6,             // en økning må gi minst så mye
};

/** Effekten et trinn gir i kW: målt hvis vi har sett den, ellers regnet fra faser og spenning. */
function trinnKw(ampere, faser = 1, volt = 230, maalt = null) {
  if (maalt && maalt[ampere]) return Math.round(maalt[ampere] * 100) / 100;
  const kw = Number(faser) >= 3 ? (SQRT3 * volt * ampere) / 1000 : (ampere * volt) / 1000;
  return Math.round(kw * 100) / 100;
}

/** Høyeste trinn som får plass i `ledigKw`, eller null når ikke engang det laveste gjør det. */
function velgTrinn(ledigKw, trinn, faser, volt, maalt) {
  const kandidater = trinn.filter((a) => trinnKw(a, faser, volt, maalt) <= ledigKw);
  return kandidater.length ? Math.max(...kandidater) : null;
}

class Lading {
  constructor(tilstand, innstillinger) {
    this.m = tilstand;
    for (const [k, v] of Object.entries({ satt_trinn: null, sist_endret: null, soc_full: false, kw_maalt: {} })) {
      if (this.m[k] === undefined) this.m[k] = v;
    }
    this.settInnstillinger(innstillinger);
  }

  settInnstillinger(innstillinger) {
    this.i = { ...STANDARD, ...(innstillinger || {}) };
    this.i.trinn = [...new Set((this.i.trinn || []).map(Number).filter((a) => a >= 1 && a <= 99))].sort((a, b) => a - b);
  }

  konfigurert() {
    return Boolean(this.i.bryter && this.i.bryter.enhet && this.i.strom && this.i.strom.enhet && this.i.trinn.length);
  }

  kwFor(ampere) {
    return trinnKw(ampere, this.i.faser, this.i.volt, this.m.kw_maalt);
  }

  /** Skal bilen lades i det hele tatt? Hysterese på batterinivået. Returnerer [skal, grunn]. */
  borLade(soc) {
    if (soc === null || soc === undefined) return [true, ''];
    if (soc >= this.i.stoppVed) { this.m.soc_full = true; return [false, `Batteriet er på ${soc.toFixed(0)} % — ferdig ladet til ${this.i.stoppVed} %`]; }
    if (soc < this.i.startUnder) { this.m.soc_full = false; return [true, '']; }
    if (this.m.soc_full) return [false, `Batteriet er på ${soc.toFixed(0)} % — lader igjen først under ${this.i.startUnder} %`];
    return [true, ''];
  }

  iNattvindu(ms) {
    const d = osloDeler(ms);
    return mellom(minutter(this.i.nattFra, 22 * 60), minutter(this.i.nattTil, 6 * 60), d.time * 60 + d.minutt);
  }

  /** Lær hva et trinn faktisk gir, når bilen har stått stabilt på det og trekker nesten det den kan. */
  _laer(ms, maaltKw) {
    const m = this.m;
    if (!m.satt_trinn || m.sist_endret === null || ms - m.sist_endret < 3 * 60000) return;
    if (maaltKw === null || maaltKw < 0.5) return;
    if (maaltKw < trinnKw(m.satt_trinn, this.i.faser, this.i.volt) * 0.7) return;      // bilen struper selv
    const gammel = m.kw_maalt[m.satt_trinn];
    m.kw_maalt[m.satt_trinn] = Math.round((gammel ? 0.7 * gammel + 0.3 * maaltKw : maaltKw) * 1000) / 1000;
  }

  /**
   * Hva ladingen bør gjøre med `ledigKw` til rådighet. Endrer ikke annet enn det lærte.
   *
   * @param {object} inn {ms, ledigKw, pa: boolean|null, maaltKw: number|null, soc: number|null, tilkoblet: boolean|null}
   *   `ledigKw` er effekten bilen kan bruke i alt (det som er igjen etter hus og varme).
   * @returns {{handling: string, trinn: number|null, kw: number, forklaring: string}}
   *   handling: ingen | manuell | utilgjengelig | borte | av | start | stopp | hold | endre
   */
  vurder({ ms, ledigKw, pa, maaltKw = null, soc = null, tilkoblet = null }) {
    const i = this.i;
    const m = this.m;
    const svar = (handling, trinn, kw, forklaring) => ({ handling, trinn, kw, forklaring });
    if (!this.konfigurert()) return svar('ingen', null, 0, 'Lading er ikke satt opp');
    if (!i.automatikk) return svar('manuell', null, maaltKw || 0, 'Automatikken er av — ladingen styres manuelt');
    if (pa === null) return svar('utilgjengelig', null, 0, 'Laderen svarer ikke — rører den ikke');
    if (tilkoblet === false) { m.satt_trinn = null; return svar('borte', null, 0, 'Bilen er ikke tilkoblet her — rører ikke laderen'); }

    const [skal, grunn] = this.borLade(soc);
    if (!skal) return svar(pa ? 'stopp' : 'av', null, 0, grunn);
    if (i.kunNatt && !this.iNattvindu(ms)) {
      return svar(pa ? 'stopp' : 'av', null, 0, pa ? `Nattvinduet (${i.nattFra}–${i.nattTil}) er over — stopper ladingen` : `Lader bare om natten (${i.nattFra}–${i.nattTil})`);
    }

    this._laer(ms, maaltKw);
    // `ledigKw` er hele plassen bilen kan bruke: motoren holder bilens eget forbruk utenfor
    // husets øvrige last, så det er ikke trukket fra her. Trekker bilen mindre enn trinnet
    // (nesten full), er det heller ikke reservert noe sted.
    const ledig = ledigKw;

    const onsket = velgTrinn(ledig, i.trinn, i.faser, i.volt, m.kw_maalt);
    if (onsket === null) {
      if (!pa) return svar('av', null, 0, `Ingen ledig effekt (${ledig.toFixed(1)} kW) — ${this.kwFor(i.trinn[0]).toFixed(1)} kW trengs for laveste trinn`);
      return svar('stopp', null, 0, `Bare ${ledig.toFixed(1)} kW ledig — stopper ladingen`);
    }
    if (!pa) return svar('start', onsket, this.kwFor(onsket), `${ledig.toFixed(1)} kW ledig — starter på ${onsket} A`);
    const naaKw = maaltKw !== null ? maaltKw : this.kwFor(m.satt_trinn || onsket);
    if (m.satt_trinn === onsket) return svar('hold', onsket, naaKw, `Lader på ${onsket} A`);

    // Ned går alltid med en gang: et avbrudd for bilen koster mindre enn en time over grensen.
    if (m.satt_trinn !== null && this.kwFor(onsket) < this.kwFor(m.satt_trinn)) {
      return svar('endre', onsket, this.kwFor(onsket), `Bare ${ledig.toFixed(1)} kW ledig — går ned fra ${m.satt_trinn} A til ${onsket} A`);
    }
    if (m.satt_trinn !== null) {
      const gevinst = this.kwFor(onsket) - this.kwFor(m.satt_trinn);
      if (gevinst < i.dodbandKw) return svar('hold', m.satt_trinn, naaKw, `Holder ${m.satt_trinn} A — ${onsket} A gir bare ${gevinst.toFixed(1)} kW mer`);
      if (m.sist_endret !== null && ms - m.sist_endret < i.minMellomMin * 60000) {
        return svar('hold', m.satt_trinn, naaKw, `Vil opp til ${onsket} A, men venter litt siden forrige endring`);
      }
    }
    return svar('endre', onsket, this.kwFor(onsket), `${ledig.toFixed(1)} kW ledig — går fra ${m.satt_trinn || '?'} A til ${onsket} A`);
  }

  /** Bokfør at en vurdering er utført (appen har satt strøm og bryter). */
  utfort(v, ms) {
    if (v.handling === 'start' || v.handling === 'endre') { this.m.satt_trinn = v.trinn; this.m.sist_endret = ms; }
    else if (v.handling === 'stopp') { this.m.satt_trinn = null; this.m.sist_endret = ms; }
  }

  /** Ladeeffekten motoren selv styrer (W) — holdes utenfor husets øvrige forbruk. */
  styrtW(pa, maaltKw) {
    if (!this.konfigurert() || !this.i.automatikk || !pa) return 0;
    const kw = maaltKw !== null && maaltKw !== undefined ? maaltKw : (this.m.satt_trinn ? this.kwFor(this.m.satt_trinn) : 0);
    return Math.max(kw, 0) * 1000;
  }
}

module.exports = { Lading, STANDARD, trinnKw, velgTrinn };
