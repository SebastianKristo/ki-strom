'use strict';

/**
 * Værvarsel fra Yr / MET Norway (locationforecast 2.0, compact).
 *
 *   GET https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.91&lon=10.75
 *
 * MET krever en User-Agent som sier hvem som spør. Varselet har timeverdier de første
 * døgnene og seksti­mersverdier etterpå; alt lagres som punkter og interpoleres.
 */

const TIME_MS = 3600000;

const adresse = (lat, lon) => `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${Number(lat).toFixed(4)}&lon=${Number(lon).toFixed(4)}`;

/** Gjør API-svaret om til [{ms, temp, sky, vind}], stigende i tid. */
function tolk(svar) {
  const serie = svar && svar.properties && svar.properties.timeseries;
  if (!Array.isArray(serie)) return [];
  const ut = [];
  for (const p of serie) {
    const ms = Date.parse(p && p.time);
    const d = p && p.data && p.data.instant && p.data.instant.details;
    if (!Number.isFinite(ms) || !d || !Number.isFinite(d.air_temperature)) continue;
    ut.push({ ms, temp: d.air_temperature, sky: d.cloud_area_fraction ?? null, vind: d.wind_speed ?? null });
  }
  return ut.sort((a, b) => a.ms - b.ms);
}

class Vaer {
  constructor(punkter = [], hentetMs = 0) {
    this.punkter = punkter;
    this.hentetMs = hentetMs;
  }

  sett(punkter, naaMs) {
    if (!punkter.length) return;
    this.punkter = punkter;
    this.hentetMs = naaMs;
  }

  /** Varslet temperatur på tidspunktet (lineært mellom punktene), eller null utenfor varselet. */
  tempVed(ms) {
    const p = this.punkter;
    if (!p.length || ms < p[0].ms - TIME_MS || ms > p[p.length - 1].ms) return null;
    if (ms <= p[0].ms) return p[0].temp;
    for (let i = 1; i < p.length; i++) {
      if (ms <= p[i].ms) {
        const f = (ms - p[i - 1].ms) / (p[i].ms - p[i - 1].ms);
        return p[i - 1].temp + f * (p[i].temp - p[i - 1].temp);
      }
    }
    return null;
  }

  /** Varslet verdi av et felt («vind» m/s, «sky» %) på tidspunktet, eller null. */
  feltVed(ms, felt) {
    const p = this.punkter;
    if (!p.length || ms < p[0].ms - TIME_MS || ms > p[p.length - 1].ms) return null;
    let forrige = p[0];
    for (const punkt of p) {
      if (punkt.ms >= ms) {
        const a = forrige[felt];
        const b = punkt[felt];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(b) ? b : (Number.isFinite(a) ? a : null);
        const f = punkt.ms === forrige.ms ? 0 : (ms - forrige.ms) / (punkt.ms - forrige.ms);
        return a + Math.min(1, Math.max(0, f)) * (b - a);
      }
      forrige = punkt;
    }
    return null;
  }

  /**
   * Vind (m/s) og skydekke (%) time for time fra `ms`. Målt vind nå retter varselet de første
   * timene, som for temperaturen. Uten varsel: målt vind (eller 0) og halvskyet.
   */
  vindOgSky(ms, antall, maaltVind = null) {
    const varselNaa = this.feltVed(ms, 'vind');
    const avvik = maaltVind !== null && varselNaa !== null ? maaltVind - varselNaa : 0;
    const ut = [];
    for (let n = 0; n < antall; n++) {
      const t = ms + (n + 0.5) * TIME_MS;
      const vind = this.feltVed(t, 'vind');
      ut.push({
        vind: vind === null ? (maaltVind ?? 0) : Math.max(0, vind + avvik * Math.max(0, 1 - n / 3)),
        sky: this.feltVed(t, 'sky'),
      });
    }
    return ut;
  }

  /**
   * Utetemperatur time for time fra `ms`. Den målte temperaturen nå brukes til å rette
   * varselet: avviket mellom måler og varsel fases ut over seks timer. Uten varsel holdes
   * den målte temperaturen (eller `reserve`) flatt.
   */
  timer(ms, antall, maaltNaa = null, reserve = 0) {
    const varselNaa = this.tempVed(ms);
    const avvik = maaltNaa !== null && varselNaa !== null ? maaltNaa - varselNaa : 0;
    const ut = [];
    for (let n = 0; n < antall; n++) {
      const varsel = this.tempVed(ms + (n + 0.5) * TIME_MS);
      if (varsel === null) ut.push(maaltNaa ?? (ut.length ? ut[ut.length - 1] : reserve));
      else ut.push(varsel + avvik * Math.max(0, 1 - n / 6));
    }
    return ut;
  }

  /** Er varselet for gammelt til å stole på? */
  utdatert(naaMs, maksTimer = 6) {
    return naaMs - this.hentetMs > maksTimer * TIME_MS;
  }
}

/** Hent nytt varsel hvis det gamle er eldre enn en time. Returnerer antall punkter, eller 0. */
async function hent(vaer, lat, lon, naaMs, hentFn, brukeragent) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
  if (!vaer.utdatert(naaMs, 1)) return 0;
  const svar = await hentFn(adresse(lat, lon), { headers: { 'User-Agent': brukeragent } });
  if (!svar || !svar.ok) return 0;
  const punkter = tolk(await svar.json());
  vaer.sett(punkter, naaMs);
  return punkter.length;
}

module.exports = { adresse, tolk, Vaer, hent };
