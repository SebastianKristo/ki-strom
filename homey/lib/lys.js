'use strict';

/**
 * Lysregler: glemte lys og nattdemping.
 *
 *  glemt  Lyset slås av når ingen har vært i rommet på en stund (med nærværssensor), eller
 *         når det har stått på lenge (uten). Bare innenfor et tidsvindu. En sensor som har
 *         falt ut vet ikke om noen er der — da røres lyset ikke.
 *  demp   Lyset settes til et nattnivå når natten starter og et dagnivå når dagen starter.
 *         Endrer noen lysstyrken for hånd, får det stå til neste skifte.
 *
 * Klassen er ren: den får lysenes tilstand inn og gir handlinger ut.
 */

const { osloDeler } = require('./kalender');
const { minutter, mellom } = require('./program');

const STANDARD_REGEL = {
  type: 'glemt',          // 'glemt' | 'demp'
  lys: null,              // enhets-id
  naervaer: null,         // {enhet, kap}
  fravaerMin: 5,
  maksPaMin: 30,
  fra: null,              // «HH:MM» — standard 08–22 for glemt, natt–dag for demp
  til: null,
  nattProsent: 25,
  dagProsent: 80,
  aktiv: true,
};

class Lys {
  /** @param {object} tilstand {pa_siden: {key: ms}, dempet: {key: {fase, satt}}} */
  constructor(tilstand, regler) {
    this.m = tilstand;
    this.m.pa_siden = this.m.pa_siden || {};
    this.m.dempet = this.m.dempet || {};
    this.settRegler(regler);
  }

  settRegler(regler) {
    this.regler = (regler || []).filter((r) => r && r.key && r.lys).map((r) => ({ ...STANDARD_REGEL, ...r }));
  }

  _vindu(r, ms, innst) {
    const d = osloDeler(ms);
    const naa = d.time * 60 + d.minutt;
    if (r.type === 'demp') return mellom(minutter(r.fra, minutter(innst.nattStart, 23 * 60)), minutter(r.til, minutter(innst.dagStart, 6 * 60)), naa);
    return mellom(minutter(r.fra, 8 * 60), minutter(r.til, 22 * 60), naa);
  }

  /**
   * @param {object} inn
   * @param {number} inn.ms
   * @param {object} inn.lys {key: {pa: boolean|null, dim: number|null (0–1), dimbar: boolean,
   *                         naervaer: boolean|null, naervaerEndretMs: number|null}}
   * @param {object} inn.innst {dagStart, nattStart}
   * @returns {{handlinger: Array<{key, type: 'av'|'dim', verdi?: number}>, status: object}}
   */
  tick({ ms, lys, innst = {} }) {
    const handlinger = [];
    const status = {};
    for (const r of this.regler) {
      const l = lys[r.key];
      const st = { navn: r.navn || r.key, type: r.type };
      status[r.key] = st;
      if (!l || l.pa === null || l.pa === undefined) { Object.assign(st, { status: 'mangler', tekst: 'Lyset svarer ikke' }); continue; }
      if (l.pa && !this.m.pa_siden[r.key]) this.m.pa_siden[r.key] = ms;
      if (!l.pa) delete this.m.pa_siden[r.key];
      if (!r.aktiv) { Object.assign(st, { status: 'av', tekst: 'Regelen er slått av' }); continue; }
      if (r.type === 'demp') this._demp(r, l, ms, innst, st, handlinger);
      else this._glemt(r, l, ms, innst, st, handlinger);
    }
    return { handlinger, status };
  }

  _glemt(r, l, ms, innst, st, handlinger) {
    if (!l.pa) { Object.assign(st, { status: 'av_lys', tekst: 'Lyset er av' }); return; }
    if (!this._vindu(r, ms, innst)) { Object.assign(st, { status: 'utenfor', tekst: 'Utenfor tidsvinduet — rører ikke lyset' }); return; }
    let grunn;
    if (r.naervaer && r.naervaer.enhet) {
      if (l.naervaer === null || l.naervaer === undefined) { Object.assign(st, { status: 'mangler', tekst: 'Nærværssensoren svarer ikke — slår ikke av' }); return; }
      if (l.naervaer) { Object.assign(st, { status: 'i_bruk', tekst: 'Noen er i rommet — lyset får stå' }); return; }
      // Uten tidspunkt for siste bevegelse regnes fraværet fra da lyset ble slått på.
      const siden = Math.max(l.naervaerEndretMs || 0, this.m.pa_siden[r.key] || ms);
      const borteMin = (ms - siden) / 60000;
      if (borteMin < r.fravaerMin) { Object.assign(st, { status: 'venter', tekst: `Ingen bevegelse på ${borteMin.toFixed(0)} min — slår av etter ${r.fravaerMin}` }); return; }
      grunn = `ingen bevegelse på ${borteMin.toFixed(0)} min`;
    } else {
      const paMin = (ms - (this.m.pa_siden[r.key] || ms)) / 60000;
      if (paMin < r.maksPaMin) { Object.assign(st, { status: 'venter', tekst: `På i ${paMin.toFixed(0)} min — slår av etter ${r.maksPaMin} (ingen sensor i rommet)` }); return; }
      grunn = `stått på i ${paMin.toFixed(0)} min uten sensor i rommet`;
    }
    handlinger.push({ key: r.key, type: 'av', grunn });
    delete this.m.pa_siden[r.key];
    Object.assign(st, { status: 'slatt_av', tekst: `Slått av — ${grunn}` });
  }

  _demp(r, l, ms, innst, st, handlinger) {
    if (!l.dimbar) { Object.assign(st, { status: 'ikke_dimbar', tekst: 'Lyset kan ikke dempes — bruk «glemt lys»' }); return; }
    const natt = this._vindu(r, ms, innst);
    const fase = natt ? 'natt' : 'dag';
    const mal = Number(natt ? r.nattProsent : r.dagProsent);
    const d = this.m.dempet[r.key] || (this.m.dempet[r.key] = {});
    if (!l.pa) { delete d.satt; d.fase = fase; Object.assign(st, { status: 'av_lys', tekst: `Lyset er av (${fase})` }); return; }
    const naa = Math.round((l.dim ?? 0) * 100);
    if (d.fase !== fase || d.satt === undefined) {
      // Overgang: sett målnivået én gang.
      if (Math.abs(naa - mal) > 3) handlinger.push({ key: r.key, type: 'dim', verdi: mal / 100, grunn: fase });
      d.fase = fase; d.satt = mal;
      Object.assign(st, { status: 'satt', tekst: `Satt til ${mal} % ved ${fase}` });
    } else if (Math.abs(naa - d.satt) > 3) {
      Object.assign(st, { status: 'manuell', tekst: `Endret for hånd til ${naa} % — får stå til ${natt ? 'dag' : 'natt'}` });
    } else {
      Object.assign(st, { status: 'holder', tekst: `${fase === 'natt' ? 'Natt' : 'Dag'}: ${naa} %` });
    }
  }
}

module.exports = { Lys, STANDARD_REGEL };
