"""Adaptiv usikkerhetsmargin lært av prognosefeil.

To reserver som må holdes fra hverandre (se README «Reserver»):

* **Strategisk reserve** — `number.ki_reserve_topp_kwh` (kWh på døgnmaks). Brukes BARE i
  `nettleie.vurder()` når rommet for dagens døgnmaks regnes mot månedens topp-tre-snitt.
  Den påvirker timegrensen (kWh), ikke prognosen for timen.
* **Usikkerhetsmargin for timen** — det denne modulen lærer, i kWh på *sluttforbruket i
  inneværende klokketime*. Brukes BARE i `engine.fordel()` når forventet effekt måles mot tillatt
  effekt: marginen (kWh) deles på timer igjen og trekkes fra tilgjengelig effekt. Den erstatter
  den faste `number.ki_reserve_uregulert_kwh` når læringen er aktiv; ellers gjelder den faste.
  Den settes ALDRI inn i nettleie-regnestykket, så en lært timefeil kan ikke bli til tre ganger
  så mye på månedssnittet.

Hva som lagres (hub.minne["prognose"]):
  prognoser: {time_nokkel(UTC): {horisont: {...frosset øyeblikk...}}}   — inntil 48 timer
  feil:      liste av observasjoner {ts, time, horisont, feil, faktisk, forventet, segment, pavirket,
             margin_brukt, innenfor}                                     — inntil 400
  margin:    {horisont: kWh}  (glattet)
  n_pavirket, n_utelatt_kvalitet
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

MODELLVERSJON = 1
HORISONTER = (60, 45, 30, 15)       # minutter igjen der et øyeblikk fryses (første tick ≤ grensen)
MAKS_FEIL = 400
MAKS_PROGNOSE_TIMER = 48
HALVERINGSTID_DAGER = 14.0          # nyere feil veier mer
PERSENTIL = 0.80                    # høy persentil av signerte feil → undervurderingsrisiko
OPP_ALFA, NED_ALFA = 0.5, 0.1       # marginen øker raskt, synker sakte
MIN_SEGMENT = 12                    # observasjoner før segment (tid × hverdag/helg) brukes
MIN_HORISONT_STD = 8                # observasjoner før horisonten alene brukes (kan stilles)


def segment_for(dt: datetime) -> str:
    """Grov klasse: tid på døgnet × hverdag/helg. Brukes bare når det finnes nok data."""
    t = dt.hour
    del_ = "natt" if t < 6 else "morgen" if t < 10 else "dag" if t < 16 else "kveld" if t < 22 else "natt"
    return f"{del_}_{'helg' if dt.weekday() >= 5 else 'hverdag'}"


def vektet_persentil(verdier: list[tuple[float, float]], p: float) -> float | None:
    """Vektet persentil av (verdi, vekt). Returnerer None uten data."""
    if not verdier:
        return None
    s = sorted(verdier, key=lambda x: x[0])
    total = sum(w for _v, w in s)
    if total <= 0:
        return None
    akk = 0.0
    for v, w in s:
        akk += w
        if akk / total >= p:
            return v
    return s[-1][0]


class KiPrognoselaering:
    def __init__(self, hub) -> None:
        self.hub = hub
        self.m: dict = hub.minne.setdefault("prognose", {})
        self.m.setdefault("prognoser", {})
        self.m.setdefault("feil", [])
        self.m.setdefault("margin", {})
        self.m.setdefault("n_pavirket", 0)
        self.m.setdefault("n_utelatt_kvalitet", 0)
        self._sist_time: str | None = None
        self._senket_naa: set[str] = set()

    # ------------------------------------------------------------------
    #  Innstillinger
    # ------------------------------------------------------------------
    def aktiv(self) -> bool:
        return self.hub.on("ki_adaptiv_reserve", True)

    def grenser(self) -> tuple[float, float, int]:
        h = self.hub
        return (h.num("ki_prognose_margin_min", 0.0), h.num("ki_prognose_margin_maks", 1.5),
                int(h.num("ki_prognose_min_obs", MIN_HORISONT_STD)))

    def nullstill(self) -> None:
        self.m["prognoser"].clear()
        self.m["feil"].clear()
        self.m["margin"].clear()
        self.m["n_pavirket"] = 0
        self.m["n_utelatt_kvalitet"] = 0
        self.hub.lagre()

    # ------------------------------------------------------------------
    #  Registrering av prognoser (fryses)
    # ------------------------------------------------------------------
    @staticmethod
    def time_nokkel(naa: datetime) -> str:
        u = naa.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
        return u.isoformat(timespec="minutes")

    def registrer(self, budsjett: dict, forventet_kw: float, plan: list[dict], datakvalitet: str,
                  styrt_kw: float, vvb_kw: float, margin_kwh: float) -> None:
        """Kalles hvert tick med motorens ferske prognose. Fryser et øyeblikk per horisont."""
        naa = dt_util.now()
        nk = self.time_nokkel(naa)
        min_igjen = float(budsjett.get("minutter_igjen", 0))
        senket = sorted(p["key"] for p in plan if p.get("handling") == "senket")
        if nk != self._sist_time:
            self._sist_time = nk
            self._senket_naa = set(senket)
        # nye senkinger etter at en prognose ble laget → merk prognosen som påvirket
        nye = set(senket) - self._senket_naa
        self._senket_naa |= set(senket)
        rad = self.m["prognoser"].setdefault(nk, {})
        if nye:
            for h_key, pr in rad.items():
                if not pr.get("pavirket"):
                    pr["pavirket"] = True
                    pr["pavirket_av"] = sorted(nye)
        forventet_slutt = float(budsjett.get("forbrukt", 0.0)) + forventet_kw * float(budsjett.get("timer_igjen", 0.0))
        for hz in HORISONTER:
            if min_igjen <= hz and str(hz) not in rad:
                rad[str(hz)] = {
                    "opprettet": naa.isoformat(timespec="seconds"), "time": nk, "horisont": hz,
                    "min_igjen": round(min_igjen, 1), "forbrukt": round(float(budsjett.get("forbrukt", 0.0)), 3),
                    "forventet_slutt": round(forventet_slutt, 3), "forventet_kw": round(forventet_kw, 3),
                    "datakvalitet": datakvalitet, "modell": MODELLVERSJON, "margin_brukt": round(margin_kwh, 3),
                    "forutsetninger": {"senket": senket, "styrt_kw": round(styrt_kw, 3), "vvb_kw": round(vvb_kw, 3),
                                       "skygge": bool(self.hub.on("ki_skyggemodus"))},
                    "pavirket": False,
                }
                break   # én horisont per tick er nok — neste tick tar neste
        # begrens
        if len(self.m["prognoser"]) > MAKS_PROGNOSE_TIMER:
            for k in sorted(self.m["prognoser"])[:-MAKS_PROGNOSE_TIMER]:
                self.m["prognoser"].pop(k, None)

    # ------------------------------------------------------------------
    #  Evaluering når timen er lukket
    # ------------------------------------------------------------------
    def evaluer(self, lukkede: list[dict]) -> int:
        """`lukkede` = rader fra Timemaler.oppdater(). Returnerer antall nye observasjoner."""
        n = 0
        for rad in lukkede:
            start = rad.get("start")
            if start is None:
                continue
            nk = datetime.fromtimestamp(start, tz=timezone.utc).isoformat(timespec="minutes")
            prog = self.m["prognoser"].pop(nk, None)
            if not prog:
                continue
            if rad.get("kwh") is None or rad.get("kvalitet") not in ("malt", "estimert"):
                self.m["n_utelatt_kvalitet"] += len(prog)
                continue
            faktisk = float(rad["kwh"])
            for hz_str, pr in prog.items():
                if pr.get("datakvalitet") in ("mangler", "forelopig_delvis"):
                    self.m["n_utelatt_kvalitet"] += 1
                    continue
                feil = faktisk - float(pr["forventet_slutt"])
                obs = {
                    "ts": pr["opprettet"], "time": nk, "horisont": int(hz_str), "feil": round(feil, 3),
                    "faktisk": round(faktisk, 3), "forventet": round(float(pr["forventet_slutt"]), 3),
                    "segment": segment_for(dt_util.parse_datetime(pr["opprettet"])),
                    "pavirket": bool(pr.get("pavirket")), "skygge": bool(pr["forutsetninger"].get("skygge")),
                    "margin_brukt": float(pr.get("margin_brukt", 0.0)),
                    "innenfor": faktisk <= float(pr["forventet_slutt"]) + float(pr.get("margin_brukt", 0.0)),
                }
                if obs["pavirket"]:
                    self.m["n_pavirket"] += 1
                self.m["feil"].append(obs)
                n += 1
        if len(self.m["feil"]) > MAKS_FEIL:
            self.m["feil"] = self.m["feil"][-MAKS_FEIL:]
        if n:
            self._oppdater_marginer()
            self.hub.lagre()
        return n

    # ------------------------------------------------------------------
    #  Margin
    # ------------------------------------------------------------------
    def _vekt(self, obs: dict, naa: datetime) -> float:
        try:
            alder_d = (naa - dt_util.parse_datetime(obs["ts"])).total_seconds() / 86400.0
        except (TypeError, ValueError):
            alder_d = 30.0
        return 0.5 ** (max(alder_d, 0.0) / HALVERINGSTID_DAGER)

    def _gyldige(self) -> list[dict]:
        # Påvirkede timer (motoren senket etter at prognosen ble laget) holdes utenfor:
        # sluttforbruket der sier ikke hva prognosen ville truffet uten tiltak.
        return [o for o in self.m["feil"] if not o.get("pavirket")]

    def _raa_margin(self, horisont: int, segment: str | None, naa: datetime) -> tuple[float | None, int, str]:
        """P80 av signerte feil (gulv 0) for horisonten; segment først, så hele horisonten."""
        _mn, _mx, min_obs = self.grenser()
        gyld = [o for o in self._gyldige() if o["horisont"] == horisont]
        if segment:
            seg = [o for o in gyld if o["segment"] == segment]
            if len(seg) >= MIN_SEGMENT:
                v = vektet_persentil([(o["feil"], self._vekt(o, naa)) for o in seg], PERSENTIL)
                return (max(0.0, v) if v is not None else None), len(seg), "segment"
        if len(gyld) >= min_obs:
            v = vektet_persentil([(o["feil"], self._vekt(o, naa)) for o in gyld], PERSENTIL)
            return (max(0.0, v) if v is not None else None), len(gyld), "horisont"
        return None, len(gyld), "for_faa"

    def _oppdater_marginer(self) -> None:
        """Glatting: opp raskt (α=0,5), ned sakte (α=0,1). Lagres per horisont."""
        naa = dt_util.now()
        mn, mx, _ = self.grenser()
        for hz in HORISONTER:
            raa, _n, _kilde = self._raa_margin(hz, None, naa)
            if raa is None:
                continue
            raa = max(mn, min(mx, raa))
            gammel = self.m["margin"].get(str(hz))
            if gammel is None:
                ny = raa
            else:
                alfa = OPP_ALFA if raa > gammel else NED_ALFA
                ny = gammel + alfa * (raa - gammel)
            self.m["margin"][str(hz)] = round(max(mn, min(mx, ny)), 3)

    def margin(self, minutter_igjen: float) -> dict[str, Any]:
        """Aktiv usikkerhetsmargin (kWh på sluttforbruket) for nåværende tid igjen i timen."""
        h = self.hub
        mn, mx, min_obs = self.grenser()
        fallback_kwh = h.num("ki_reserve_uregulert_kwh", 0.35) * max(minutter_igjen, 1) / 60.0
        naa = dt_util.now()
        hz = min(HORISONTER, key=lambda x: abs(x - minutter_igjen))
        seg = segment_for(naa)
        raa, n, kilde = self._raa_margin(hz, seg, naa)
        glattet = self.m["margin"].get(str(hz))
        n_alle = len(self._gyldige())
        ut: dict[str, Any] = {"horisont": hz, "segment": seg, "n": n, "n_alle": n_alle,
                              "n_pavirket": self.m["n_pavirket"], "n_utelatt_kvalitet": self.m["n_utelatt_kvalitet"],
                              "min_kwh": mn, "maks_kwh": mx, "min_obs": min_obs, "fallback_kwh": round(fallback_kwh, 3)}
        if not self.aktiv():
            ut.update(kwh=round(fallback_kwh, 3), status="av", kilde="fast",
                      grunn="Adaptiv reserve er av — fast reserve for uregulert last gjelder.")
            return ut
        if raa is None or glattet is None:
            ut.update(kwh=round(fallback_kwh, 3), status="laerer", kilde="fast",
                      grunn=f"Lærer: {n} gyldige observasjoner for {hz} min igjen, trenger {min_obs}. Fast reserve imens.")
            return ut
        # bruk segmentets råverdi som "trekk" på den glattede horisontmarginen (aldri under horisont-glattet ned)
        kwh = glattet if kilde != "segment" else max(mn, min(mx, glattet + OPP_ALFA * (raa - glattet)))
        # skjev utvalg? mange påvirkede timer utelatt → ikke la marginen bli mindre enn fallback
        andel_pavirket = self.m["n_pavirket"] / max(1, self.m["n_pavirket"] + n_alle)
        status = "aktiv"
        grunn = ""
        if andel_pavirket > 0.4:
            kwh = max(kwh, fallback_kwh)
            status = "usikkert_grunnlag"
            grunn = (f"{self.m['n_pavirket']} av timene ble påvirket av motorens egne tiltak og er holdt utenfor — "
                     "grunnlaget mangler de vanskelige timene, så marginen holdes minst på fast nivå. ")
        # begrunnelse
        gyld = [o for o in self._gyldige() if o["horisont"] == hz and (kilde != "segment" or o["segment"] == seg)]
        under = sum(1 for o in gyld if o["feil"] > 0.05)
        if kwh > fallback_kwh * 1.2:
            grunn += (f"Marginen er økt fordi forbruket {seg.replace('_', ' på ')} ofte har blitt høyere enn prognosen "
                      f"({under} av {len(gyld)} ganger).")
        elif kwh < fallback_kwh * 0.8:
            grunn += f"Prognosene {seg.replace('_', ' på ')} har truffet godt ({len(gyld) - under} av {len(gyld)} innenfor) — mindre margin."
        else:
            grunn += "Prognosefeilen ligger nær den faste reserven."
        treff = [o for o in self.m["feil"] if not o.get("pavirket") and o.get("margin_brukt") is not None]
        dekning = (sum(1 for o in treff if o["innenfor"]) / len(treff)) if treff else None
        # empirisk intervall: P20–P80 av feilen for horisonten (ikke en garanti)
        alle_hz = [o for o in self._gyldige() if o["horisont"] == hz]
        p20 = vektet_persentil([(o["feil"], self._vekt(o, naa)) for o in alle_hz], 0.20) if len(alle_hz) >= min_obs else None
        p80 = vektet_persentil([(o["feil"], self._vekt(o, naa)) for o in alle_hz], 0.80) if len(alle_hz) >= min_obs else None
        ut.update(kwh=round(kwh, 3), status=status, kilde=kilde, grunn=grunn.strip(),
                  intervall_kwh=[round(p20, 3), round(p80, 3)] if p20 is not None else None,
                  dekning_observert=round(dekning, 2) if dekning is not None else None, n_dekning=len(treff))
        return ut

    # ------------------------------------------------------------------
    def publiser(self, m: dict, budsjett: dict, forventet_kw: float) -> None:
        h = self.hub
        forventet_slutt = float(budsjett.get("forbrukt", 0.0)) + forventet_kw * float(budsjett.get("timer_igjen", 0.0))
        iv = m.get("intervall_kwh")
        attrs = dict(m)
        attrs.update({
            "forventet_slutt_kwh": round(forventet_slutt, 3),
            "forventet_ovre_kwh": round(forventet_slutt + m["kwh"], 3),
            "prognoseintervall_kwh": [round(forventet_slutt + iv[0], 2), round(forventet_slutt + iv[1], 2)] if iv else None,
            "strategisk_reserve_kwh": h.num("ki_reserve_topp_kwh", 0.3),
            "margin_kw_naa": round(m["kwh"] / max(float(budsjett.get("timer_igjen", 0.02)), 0.02), 3),
            "modell": MODELLVERSJON,
            "forklaring": (f"Forventet {forventet_slutt:.2f} kWh ved timeslutt (+{m['kwh']:.2f} kWh margin = "
                           f"{forventet_slutt + m['kwh']:.2f}). Status: {m['status']}. {m.get('grunn', '')}").strip(),
        })
        h.sett_sensor("ki_prognoselaering", m["status"], attrs)
