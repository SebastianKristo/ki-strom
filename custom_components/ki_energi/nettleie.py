"""Nettleie etter Elvias døgnmaksmodell.

Tre lag, med de to nederste uten Home Assistant-avhengigheter så de kan testes rent:

1. `Timemaler`  — tidsstemplede prøver av energiregisteret → energi per hele klokketime
                  (målt / estimert / foreløpig / mangler). Timer nøkles i UTC, så sommertid
                  hverken mister eller dobler timer.
2. rene funksjoner — døgnmaks per lokal dato, topp tre fra tre ulike datoer, tarifftrinn,
                  og simulering av «hva skjer med snitt og fastledd hvis denne timen ender på X».
3. `KiNettleie`  — kobler laget over til hubben: leser sensorer, lagrer i minnet, henter
                  historikk fra recorder ved databrudd, og gir motoren en økonomisk timegrense.
"""
from __future__ import annotations

import calendar
import logging
from bisect import bisect_left
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.util import dt as dt_util

from .const import CONF_IMPORTERT_ENERGI, CONF_TOPP1, CONF_TOPP2, CONF_TOPP3

_LOGGER = logging.getLogger(__name__)

# Standard tarifftabell (inkl. avgifter). Øvre grense i kW → kr/mnd. Snitt ≥ siste grense = ukjent.
TARIFF_STANDARD: list[tuple[float, float]] = [(2, 150), (5, 250), (10, 420), (15, 585), (20, 755)]
TARIFF_STANDARD_TEKST = "2:150,5:250,10:420,15:585,20:755"

TOL_MALT_SEK = 15          # prøve innen ±15 s av timegrensen regnes som målt
MAKS_GAP_SEK = 61 * 60     # lengre hull enn dette interpoleres ikke — da er verdien «mangler».
                           # (Registre som bare oppdateres hver time gir da «estimert», ikke «mangler».)
VENT_PA_PROVE_SEK = 5 * 60 # så lenge venter vi på en forsinket prøve etter timeskiftet
RESET_TOLERANSE = 0.5      # registeret falt mer enn dette → nullstilt/byttet måler


# ----------------------------------------------------------------------
#  Rene funksjoner
# ----------------------------------------------------------------------
def parse_tariff(tekst: str | None) -> list[tuple[float, float]]:
    """'2:150,5:250,...' → [(2,150),(5,250),...] sortert. Ugyldig tekst gir standardtabellen."""
    if not tekst:
        return list(TARIFF_STANDARD)
    ut: list[tuple[float, float]] = []
    try:
        for del_ in str(tekst).replace(";", ",").split(","):
            del_ = del_.strip()
            if not del_:
                continue
            g, kr = del_.split(":")
            ut.append((float(g.replace(",", ".")), float(kr.replace(",", "."))))
    except (ValueError, AttributeError):
        return list(TARIFF_STANDARD)
    ut.sort()
    return ut or list(TARIFF_STANDARD)


def trinn(snitt: float | None, tabell: list[tuple[float, float]]) -> dict[str, Any]:
    """Tarifftrinn for et snitt. Ikke avrundet: nøyaktig 5,0 gir trinnet «fra 5 kW».

    Returnerer {kr, fra, til, ukjent}. `ukjent` når snittet er over tabellens siste grense
    (vi finner ikke på satser) eller når snittet er None.
    """
    if snitt is None:
        return {"kr": None, "fra": None, "til": None, "ukjent": True}
    fra = 0.0
    for grense, kr in tabell:
        if snitt < grense:
            return {"kr": kr, "fra": fra, "til": grense, "ukjent": False}
        fra = grense
    return {"kr": None, "fra": fra, "til": None, "ukjent": True}


def neste_grense(snitt: float, tabell: list[tuple[float, float]]) -> float | None:
    """Første trinngrense som er strengt større enn snittet."""
    for grense, _kr in tabell:
        if snitt < grense:
            return grense
    return None


def topp_tre(dager: dict[Any, float]) -> list[tuple[Any, float]]:
    """De tre høyeste verdiene fra tre ulike nøkler (datoer). Færre enn tre dager gir færre."""
    return sorted(dager.items(), key=lambda kv: (-kv[1], str(kv[0])))[:3]


def snitt_av(topper: list[tuple[Any, float]]) -> float | None:
    if not topper:
        return None
    return sum(v for _k, v in topper) / len(topper)


def simuler(dager: dict[Any, float], idag: Any, kandidat: float, tabell: list[tuple[float, float]]) -> dict[str, Any]:
    """Hva blir topp tre, snitt, trinn og fastledd-økning hvis dagens døgnmaks ender på `kandidat`?

    `dager` er månedens registrerte døgnmakser (kan inneholde `idag`). Dagens dato telles aldri
    mer enn én gang: kopien overskriver dagens verdi i stedet for å legge til en ny.
    """
    reg_topper = topp_tre(dager)
    reg_snitt = snitt_av(reg_topper)
    reg_trinn = trinn(reg_snitt, tabell)
    dagens_reg = dager.get(idag)

    kopi = dict(dager)
    kopi[idag] = max(kandidat, dagens_reg if dagens_reg is not None else 0.0)
    ny_topper = topp_tre(kopi)
    ny_snitt = snitt_av(ny_topper)
    ny_trinn = trinn(ny_snitt, tabell)

    hoyere_dognmaks = dagens_reg is None or kandidat > dagens_reg + 1e-9
    hoyere_snitt = (reg_snitt is None and ny_snitt is not None) or (
        reg_snitt is not None and ny_snitt is not None and ny_snitt > reg_snitt + 1e-9)
    if reg_trinn["kr"] is not None and ny_trinn["kr"] is not None:
        okning = max(0.0, ny_trinn["kr"] - reg_trinn["kr"])
    else:
        okning = None  # ukjent tariff — kan ikke tallfestes
    return {
        "registrert_topper": reg_topper, "registrert_snitt": reg_snitt, "registrert_trinn": reg_trinn,
        "ny_topper": ny_topper, "ny_snitt": ny_snitt, "ny_trinn": ny_trinn,
        "hoyere_dognmaks": hoyere_dognmaks, "hoyere_snitt": hoyere_snitt,
        "hoyere_fastledd": bool(okning) if okning is not None else None,
        "okning_kr": okning,
        # snittet stiger, men trinnet ikke: mindre rom for de andre dagene resten av måneden
        "redusert_margin": hoyere_snitt and not (okning or 0),
    }


def tak_for_idag(andre: list[float], mal_kw: float, reserve: float) -> float:
    """Høyeste døgnmaks i dag kan ha uten at snittet av topp tre passerer mal_kw − reserve.

    `andre` er de to høyeste døgnmaksene fra ANDRE datoer (fyll med placeholder hvis ukjent).
    """
    a = sorted(andre, reverse=True)[:2]
    while len(a) < 2:
        a.append(0.0)
    return 3.0 * (mal_kw - reserve) - a[0] - a[1]


# ----------------------------------------------------------------------
#  Timemåler
# ----------------------------------------------------------------------
class Timemaler:
    """Energi per hele klokketime fra tidsstemplede registerprøver. Ren Python, testbar.

    Tilstand (dict, lagres av hubben):
      prover:  [[ts, kwh], ...]  siste ~3 timer, stigende ts
      timer:   {"<utc-iso timestart>": {"kwh", "kvalitet", "start", "slutt", "start_kv", "slutt_kv"}}
      reset:   ts for siste registrerte nullstilling
      sist_lukket: ts for siste timegrense som er behandlet
    kvalitet: "malt" | "estimert" | "mangler"  (foreløpig time rapporteres som "forelopig")
    """

    def __init__(self, tilstand: dict) -> None:
        self.m = tilstand
        self.m.setdefault("prover", [])
        self.m.setdefault("timer", {})
        self.m.setdefault("reset", None)
        self.m.setdefault("sist_lukket", None)

    # -- prøver ---------------------------------------------------------
    def prove(self, ts: float, verdi: float) -> None:
        p = self.m["prover"]
        if p and ts <= p[-1][0]:
            # gammel/duplisert prøve — sett den inn sortert hvis den er ny
            tss = [q[0] for q in p]
            i = bisect_left(tss, ts)
            if i < len(p) and abs(p[i][0] - ts) < 0.5:
                return
            p.insert(i, [ts, verdi])
        else:
            if p and verdi < p[-1][1] - RESET_TOLERANSE:
                self.m["reset"] = ts
                _LOGGER.warning("ki_energi: energiregisteret falt fra %.3f til %.3f — tolkes som nullstilling/målerbytte",
                                p[-1][1], verdi)
            p.append([ts, verdi])

    def verdi_ved(self, ts: float) -> tuple[float | None, str]:
        """Registerverdi ved et tidspunkt: (verdi, 'malt'|'estimert'|'mangler')."""
        p = self.m["prover"]
        if not p:
            return None, "mangler"
        reset = self.m.get("reset")
        tss = [q[0] for q in p]
        i = bisect_left(tss, ts)
        # eksakt nok? velg den nærmeste prøven innenfor toleransen
        naer = [p[j] for j in (i - 1, i) if 0 <= j < len(p) and abs(p[j][0] - ts) <= TOL_MALT_SEK]
        if naer:
            return min(naer, key=lambda q: abs(q[0] - ts))[1], "malt"
        if i == 0 or i >= len(p):
            return None, "mangler"
        a, b = p[i - 1], p[i]
        if b[0] - a[0] > MAKS_GAP_SEK:
            return None, "mangler"
        if reset is not None and a[0] < reset <= b[0]:
            return None, "mangler"
        f = (ts - a[0]) / max(b[0] - a[0], 1e-9)
        return a[1] + f * (b[1] - a[1]), "estimert"

    # -- timer ----------------------------------------------------------
    @staticmethod
    def nokkel(start_ts: float) -> str:
        return datetime.fromtimestamp(start_ts, tz=timezone.utc).isoformat(timespec="minutes")

    @staticmethod
    def timestart(ts: float) -> float:
        return float(int(ts // 3600) * 3600)

    def lukk_time(self, start_ts: float) -> dict:
        slutt_ts = start_ts + 3600
        v0, k0 = self.verdi_ved(start_ts)
        v1, k1 = self.verdi_ved(slutt_ts)
        reset = self.m.get("reset")
        rad: dict[str, Any] = {"start": start_ts, "slutt": slutt_ts, "start_kv": k0, "slutt_kv": k1}
        if v0 is None or v1 is None or (reset is not None and start_ts < reset <= slutt_ts):
            rad.update(kwh=None, kvalitet="mangler")
        else:
            kwh = max(0.0, v1 - v0)
            rad.update(kwh=round(kwh, 4), kvalitet="malt" if k0 == "malt" and k1 == "malt" else "estimert")
        self.m["timer"][self.nokkel(start_ts)] = rad
        return rad

    def oppdater(self, naa_ts: float) -> list[dict]:
        """Lukk alle timer som er ferdige. Venter litt på forsinkede prøver rundt timegrensen.
        Returnerer radene som ble lukket i dette kallet."""
        lukket: list[dict] = []
        siste_grense = self.timestart(naa_ts)          # starten på inneværende time
        sist = self.m.get("sist_lukket")
        p = self.m["prover"]
        if sist is None:
            # første gang: begynn med den første hele timen prøvene dekker
            if p:
                sist = self.timestart(p[0][0])
                if p[0][0] > sist + TOL_MALT_SEK:
                    sist += 3600
                sist = min(sist, siste_grense)
            else:
                sist = siste_grense
        start = sist
        while start + 3600 <= siste_grense:
            slutt = start + 3600
            har_prove_etter = bool(p) and p[-1][0] >= slutt - TOL_MALT_SEK
            if not har_prove_etter and naa_ts - slutt < VENT_PA_PROVE_SEK:
                break  # vent på prøven etter timegrensen
            lukket.append(self.lukk_time(start))
            start = slutt
        self.m["sist_lukket"] = start
        # rydd prøver vi ikke trenger lenger: alt eldre enn hullet før neste ulukkede time
        grense = start - MAKS_GAP_SEK
        while len(p) > 2 and p[1][0] < grense:
            p.pop(0)
        # rydd: eldre enn 40 døgn
        gammel = naa_ts - 40 * 86400
        for k in [k for k, r in self.m["timer"].items() if r.get("start", 0) < gammel]:
            self.m["timer"].pop(k, None)
        return lukket

    def forelopig(self, naa_ts: float, naa_verdi: float | None) -> tuple[float | None, str]:
        """kWh hittil i inneværende time og kvaliteten på nullpunktet.

        Mangler prøve ved timegrensen (typisk rett etter omstart) brukes første prøve i timen som
        nullpunkt — verdien er da et gulv (forbruket før første prøve er ukjent) og merkes «delvis».
        """
        if naa_verdi is None:
            return None, "mangler"
        start = self.timestart(naa_ts)
        v0, k0 = self.verdi_ved(start)
        if v0 is not None:
            return max(0.0, naa_verdi - v0), "forelopig" if k0 == "malt" else "forelopig_estimert"
        forste = next((q for q in self.m["prover"] if start <= q[0] <= naa_ts), None)
        if forste is None:
            return None, "mangler"
        return max(0.0, naa_verdi - forste[1]), "forelopig_delvis"

    def mangler_rundt(self, start_ts: float) -> list[tuple[float, float]]:
        """Tidsvinduer der vi mangler prøver for å lukke timen [start, start+3600)."""
        ut = []
        for ts in (start_ts, start_ts + 3600):
            if self.verdi_ved(ts)[0] is None:
                ut.append((ts - MAKS_GAP_SEK, ts + MAKS_GAP_SEK))
        return ut


# ----------------------------------------------------------------------
#  Kobling mot hubben
# ----------------------------------------------------------------------
class KiNettleie:
    def __init__(self, hub) -> None:
        self.hub = hub
        self.m: dict = hub.minne.setdefault("nettleie", {})
        self.maler = Timemaler(self.m.setdefault("maler", {}))
        self._rekonstruert: set[str] = set()

    # -- inndata --------------------------------------------------------
    def prove_fra_state(self, state) -> None:
        if state is None:
            return
        try:
            v = float(state.state)
        except (TypeError, ValueError):
            return
        ts = state.last_updated.timestamp() if getattr(state, "last_updated", None) else dt_util.utcnow().timestamp()
        self.maler.prove(ts, v)

    async def _rekonstruer(self, fra_ts: float, til_ts: float) -> int:
        """Hent prøver fra recorder for et tidsrom (databrudd/omstart). Returnerer antall funnet."""
        h = self.hub
        eid = h.cfg(CONF_IMPORTERT_ENERGI)
        if not eid:
            return 0
        try:
            from homeassistant.components.recorder import get_instance, history  # noqa: PLC0415
            inst = get_instance(h.hass)
        except Exception:  # noqa: BLE001
            return 0
        fra = datetime.fromtimestamp(fra_ts, tz=timezone.utc)
        til = datetime.fromtimestamp(til_ts, tz=timezone.utc)
        try:
            res = await inst.async_add_executor_job(
                history.state_changes_during_period, h.hass, fra, til, eid, True, False, None, True)
        except Exception as e:  # noqa: BLE001
            _LOGGER.debug("ki_energi: recorder-oppslag feilet: %s", e)
            return 0
        n = 0
        for st in (res or {}).get(eid, []):
            try:
                self.maler.prove(st.last_updated.timestamp(), float(st.state))
                n += 1
            except (TypeError, ValueError, AttributeError):
                continue
        return n

    async def oppdater(self) -> list[dict]:
        """Kalles hvert tick: ta prøve nå, lukk ferdige timer, forsøk rekonstruksjon ved hull."""
        h = self.hub
        eid = h.cfg(CONF_IMPORTERT_ENERGI)
        if eid:
            self.prove_fra_state(h.hass.states.get(eid))
        naa = dt_util.utcnow().timestamp()
        # Første kjøring etter oppstart: hent prøver rundt starten på inneværende time fra
        # recorder, så nullpunktet blir riktig selv om integrasjonen startet midt i timen.
        if not getattr(self, "_start_rekonstruert", False):
            self._start_rekonstruert = True
            start = self.maler.timestart(naa)
            if self.maler.verdi_ved(start)[0] is None:
                n = await self._rekonstruer(start - MAKS_GAP_SEK, min(naa, start + MAKS_GAP_SEK))
                if n:
                    _LOGGER.info("ki_energi: %d prøver hentet fra historikken for inneværende time", n)
        lukket = self.maler.oppdater(naa)
        # rekonstruer timer som ble lukket som «mangler» — én gang per time
        for rad in [r for r in lukket if r["kvalitet"] == "mangler"]:
            nk = self.maler.nokkel(rad["start"])
            if nk in self._rekonstruert:
                continue
            self._rekonstruert.add(nk)
            n = 0
            for a, b in self.maler.mangler_rundt(rad["start"]):
                n += await self._rekonstruer(a, b)
            if n:
                ny = self.maler.lukk_time(rad["start"])
                rad.update(ny)
                if ny["kvalitet"] != "mangler":
                    _LOGGER.info("ki_energi: time %s rekonstruert fra historikk (%s)", nk, ny["kvalitet"])
        if lukket:
            h.lagre()
        return lukket

    # -- avledede verdier -----------------------------------------------
    def siste_prove_ts(self) -> float | None:
        p = self.maler.m.get("prover") or []
        return p[-1][0] if p else None

    def forelopig_time(self) -> tuple[float | None, str]:
        h = self.hub
        eid = h.cfg(CONF_IMPORTERT_ENERGI)
        return self.maler.forelopig(dt_util.utcnow().timestamp(), h.f(eid) if eid else None)

    @staticmethod
    def _lokal(ts: float) -> datetime:
        return dt_util.as_local(datetime.fromtimestamp(ts, tz=timezone.utc))

    def dogn(self, maned: tuple[int, int] | None = None) -> dict[str, dict]:
        """Døgnmaks per lokal dato fra lukkede timer: {dato: {kwh, time, kvalitet, kjente_timer}}."""
        ut: dict[str, dict] = {}
        for rad in self.m["maler"]["timer"].values():
            if rad.get("start") is None:
                continue
            lok = self._lokal(rad["start"])
            if maned and (lok.year, lok.month) != maned:
                continue
            d = lok.strftime("%Y-%m-%d")
            r = ut.setdefault(d, {"kwh": None, "time": None, "kvalitet": "mangler", "kjente_timer": 0, "manglende_timer": 0})
            if rad.get("kwh") is None:
                r["manglende_timer"] += 1
                continue
            r["kjente_timer"] += 1
            if r["kwh"] is None or rad["kwh"] > r["kwh"]:
                r.update(kwh=rad["kwh"], time=lok.strftime("%H"), kvalitet=rad["kvalitet"])
        return ut

    def eksterne_topper(self) -> list[float]:
        h = self.hub
        ut = []
        for k in (CONF_TOPP1, CONF_TOPP2, CONF_TOPP3):
            v = h.f(h.cfg(k))
            if v is not None and v > 0:
                ut.append(round(float(v), 3))
        return sorted(ut, reverse=True)

    def tabell(self) -> list[tuple[float, float]]:
        return parse_tariff(self.hub.tekst("ki_tariff_tabell", TARIFF_STANDARD_TEKST))

    def grunnlag(self) -> dict[str, Any]:
        """Månedens døgnmakser med kilde og kvalitet, avstemt mot eksterne toppsensorer.

        Prioritering: egne daterte døgnmakser er fasit. Eksterne tall uten dato brukes bare for
        det de kan si: at det finnes dager (før installasjon / ved hull) med minst så høy topp.
        En ekstern verdi som er lik en egen dag (±0,06 kWh) regnes som samme dag. Resten legges
        inn som udaterte dager — de kan aldri være «i dag», og trekker dermed alltid i
        konservativ retning.
        """
        naa = dt_util.now()
        maned = (naa.year, naa.month)
        idag = naa.strftime("%Y-%m-%d")
        egne = self.dogn(maned)
        dager: dict[str, float] = {d: r["kwh"] for d, r in egne.items() if r["kwh"] is not None}
        info: dict[str, dict] = {d: dict(r, kilde="egen", dato=d) for d, r in egne.items() if r["kwh"] is not None}
        udaterte = 0
        for i, v in enumerate(self.eksterne_topper()):
            if any(abs(v - e) <= 0.06 for e in dager.values()):
                continue
            k = f"ukjent-{i + 1}"
            dager[k] = v
            info[k] = {"kwh": v, "time": None, "kvalitet": "udatert", "kilde": "ekstern", "dato": None,
                       "kjente_timer": 0, "manglende_timer": 0}
            udaterte += 1
        kjente_dager = len([d for d in dager if not d.startswith("ukjent")])
        dagens = egne.get(idag)
        ufullstendige = [d for d, r in egne.items() if r["manglende_timer"] > 0]
        return {"dager": dager, "info": info, "idag": idag, "dagens": dagens, "udaterte": udaterte,
                "kjente_dager": kjente_dager, "ufullstendige": ufullstendige,
                "dager_igjen": calendar.monthrange(naa.year, naa.month)[1] - naa.day,
                "estimerte_timer": sum(1 for r in self.m["maler"]["timer"].values()
                                       if r.get("kvalitet") == "estimert")}

    def datakvalitet(self, g: dict) -> tuple[str, list[str]]:
        grunner = []
        if g["udaterte"]:
            grunner.append(f"{g['udaterte']} topp(er) fra eksterne sensorer uten dato")
        if g["kjente_dager"] < 3:
            grunner.append(f"bare {g['kjente_dager']} dag(er) med egen måling denne måneden")
        if g["idag"] in g["ufullstendige"]:
            grunner.append("timer mangler i dag")
        if g["dagens"] and g["dagens"].get("kvalitet") == "estimert":
            grunner.append("dagens døgnmaks er estimert (prøve ved timegrensen manglet)")
        if g["udaterte"] or g["kjente_dager"] < 2 or g["idag"] in g["ufullstendige"]:
            return "usikker", grunner
        if grunner:
            return "delvis", grunner
        return "god", grunner

    # -- økonomisk timegrense -------------------------------------------
    def vurder(self, forventet_time_kwh: float | None = None) -> dict[str, Any]:
        """Alt motoren og kortet trenger. Rene tall fra funksjonene over, pluss reserve og valg."""
        h = self.hub
        tab = self.tabell()
        g = self.grunnlag()
        kv, kv_grunner = self.datakvalitet(g)
        hard = h.num("ki_maks_time_kwh", 4.9)          # absolutt elektrisk/komfort-tak per time
        laveste = h.num("ki_min_time_kwh", 3.0)
        mal_kw = h.num("ki_mal_trinn_kw", 5.0)         # ønsket: snitt under denne grensen
        basis_reserve = h.num("ki_reserve_topp_kwh", 0.3)
        tillat_dyrere = h.on("ki_tillat_dyrere_trinn", False)

        idag = g["idag"]
        dagens_kwh = g["dagens"]["kwh"] if g["dagens"] and g["dagens"]["kwh"] is not None else None
        andre = sorted([v for d, v in g["dager"].items() if d != idag], reverse=True)

        # Reserve: fast grunnreserve + påslag for usikkerhet. Enkelt og forklarbart.
        reserve = basis_reserve
        reserve_grunner = [f"grunnreserve {basis_reserve:.2f}"]
        if kv == "usikker":
            reserve += 0.2
            reserve_grunner.append("+0,20 usikker historikk")
        elif kv == "delvis":
            reserve += 0.1
            reserve_grunner.append("+0,10 delvis historikk")
        # Reservemodus: færre enn to kjente «andre» dager → fyll med det som er sannsynlig
        # framover, ikke null. Placeholder = høyeste av kjente dager og hard grense.
        placeholder = None
        if len(andre) < 2 and g["dager_igjen"] > 0:
            placeholder = max([hard] + andre + ([dagens_kwh] if dagens_kwh else []))
            andre_for_tak = andre + [placeholder] * (2 - len(andre))
            reserve_grunner.append(f"reservemodus: ukjente dager regnes som {placeholder:.2f} kWh")
        else:
            andre_for_tak = andre

        # Registrert nå
        reg_topper = topp_tre(g["dager"])
        reg_snitt = snitt_av(reg_topper)
        reg_trinn = trinn(reg_snitt, tab)

        # Mål: ønsket trinn — eller neste grense over dagens snitt hvis målet alt er tapt
        mal_tapt = reg_snitt is not None and reg_snitt >= mal_kw
        if mal_tapt:
            eff_mal = neste_grense(reg_snitt, tab)
        else:
            eff_mal = mal_kw
        tariff_ukjent = eff_mal is None or (reg_trinn["ukjent"] and reg_snitt is not None)

        fri_tak = dagens_kwh or 0.0                    # timer opp hit endrer ikke døgnmaksen
        if eff_mal is None:
            tak_ok = hard                              # utenfor tabellen: kan ikke regne kroner
        else:
            tak_ok = tak_for_idag(andre_for_tak, eff_mal, reserve)
        okonomisk = max(fri_tak, tak_ok)
        if tillat_dyrere:
            okonomisk = hard
        grense = max(laveste, min(hard, okonomisk))

        # Begrunnelse for grensen
        if tillat_dyrere:
            hvorfor = "Bryteren «tillat dyrere trinn» er på — bare den absolutte timegrensen gjelder."
        elif grense >= hard - 1e-9 and okonomisk >= hard:
            hvorfor = f"Økonomisk rom ({okonomisk:.2f} kWh) er over den absolutte grensen — {hard:.2f} kWh gjelder."
        elif fri_tak >= tak_ok and dagens_kwh:
            hvorfor = (f"Dagens døgnmaks er alt {dagens_kwh:.2f} kWh (kl. {g['dagens']['time']}). "
                       f"Timer opp til det endrer ingenting — derfor er grensen {grense:.2f}.")
        elif grense <= laveste + 1e-9:
            hvorfor = f"Regnestykket ga {tak_ok:.2f} kWh, men laveste tillatte timegrense er {laveste:.2f}."
        else:
            hvorfor = (f"For å holde snittet under {eff_mal:.2f} kW med {reserve:.2f} kWh reserve kan i dag "
                       f"toppe på {tak_ok:.2f} kWh (de to andre toppene er {andre_for_tak[0]:.2f} og {andre_for_tak[1]:.2f}).")
        if mal_tapt and eff_mal is not None:
            hvorfor += (f" Målet «under {mal_kw:.0f} kW» er alt passert denne måneden (snitt {reg_snitt:.2f}); "
                        f"motoren holder nå snittet under neste grense, {eff_mal:.0f} kW.")

        ut: dict[str, Any] = {
            "grense_kwh": round(grense, 2), "hvorfor": hvorfor,
            "fri_tak_kwh": round(fri_tak, 3), "tak_okonomi_kwh": round(tak_ok, 3), "hard_kwh": hard,
            "reserve_kwh": round(reserve, 3), "reserve_grunner": reserve_grunner,
            "mal_kw": mal_kw, "effektivt_mal_kw": eff_mal, "mal_tapt": mal_tapt,
            "tillat_dyrere_trinn": tillat_dyrere, "tariff_ukjent": bool(tariff_ukjent),
            "datakvalitet": kv, "datakvalitet_grunner": kv_grunner,
            "dagens_maks_kwh": dagens_kwh, "dagens_maks_time": g["dagens"]["time"] if g["dagens"] else None,
            "dagens_kvalitet": g["dagens"]["kvalitet"] if g["dagens"] else "mangler",
            "topp_tre": [dict(g["info"][d], kwh=v) for d, v in reg_topper],
            "registrert_snitt": round(reg_snitt, 3) if reg_snitt is not None else None,
            "registrert_trinn_kr": reg_trinn["kr"], "registrert_trinn_fra": reg_trinn["fra"],
            "registrert_trinn_til": reg_trinn["til"],
            "kjente_dager": g["kjente_dager"], "udaterte_topper": g["udaterte"], "dager_igjen": g["dager_igjen"],
            "placeholder_kwh": placeholder, "tabell": [list(t) for t in tab],
            # siste 12 lukkede timer, til «Forbruk per time mot grensen» i kortet
            "timer_siste_12": [dict(start=r["start"], kwh=r.get("kwh"), kvalitet=r.get("kvalitet"))
                               for r in sorted(self.m["maler"]["timer"].values(), key=lambda r: r["start"])[-12:]],
            # alle egne dager i måneden, til grafen i kortet
            "dogn_maned": [dict(dato=d, kwh=r["kwh"], time=r["time"], kvalitet=r["kvalitet"],
                                kjente_timer=r["kjente_timer"], manglende_timer=r["manglende_timer"],
                                topp=d in {k for k, _v in reg_topper})
                           for d, r in sorted(g["info"].items()) if r.get("kilde") == "egen"],
        }

        # Prognose for inneværende time
        if forventet_time_kwh is not None:
            sim = simuler(g["dager"], idag, forventet_time_kwh, tab)
            ut.update({
                "forventet_time_kwh": round(forventet_time_kwh, 3),
                "forventet_dognmaks_kwh": round(max(forventet_time_kwh, dagens_kwh or 0.0), 3),
                "forventet_topp_tre": [dict(g["info"].get(d, {"dato": d, "kilde": "prognose"}), kwh=v,
                                            prognose=(d == idag)) for d, v in sim["ny_topper"]],
                "forventet_snitt": round(sim["ny_snitt"], 3) if sim["ny_snitt"] is not None else None,
                "forventet_trinn_kr": sim["ny_trinn"]["kr"],
                "okning_fastledd_kr": sim["okning_kr"],
                "hoyere_dognmaks": sim["hoyere_dognmaks"], "hoyere_snitt": sim["hoyere_snitt"],
                "hoyere_fastledd": sim["hoyere_fastledd"], "redusert_margin": sim["redusert_margin"],
            })
        return ut

    def publiser(self, v: dict) -> None:
        """Skriv sensor.ki_nettleie. Tilstand = registrert trinn i kr (eller 'ukjent')."""
        h = self.hub
        state = v["registrert_trinn_kr"] if v["registrert_trinn_kr"] is not None else "ukjent"
        attrs = dict(v)
        attrs["forklaring"] = self.forklaring(v)
        h.sett_sensor("ki_nettleie", state, attrs)

    @staticmethod
    def forklaring(v: dict) -> str:
        deler = []
        if v.get("dagens_maks_kwh") is not None:
            deler.append(f"Dagens døgnmaks {v['dagens_maks_kwh']:.2f} kWh (kl. {v['dagens_maks_time']}, {v['dagens_kvalitet']}).")
        else:
            deler.append("Ingen fullført time registrert i dag ennå.")
        if v.get("registrert_snitt") is not None:
            kr = f"{v['registrert_trinn_kr']:.0f} kr/mnd" if v["registrert_trinn_kr"] is not None else "ukjent trinn"
            deler.append(f"Topp tre gir snitt {v['registrert_snitt']:.2f} kW → {kr}.")
        if v.get("forventet_time_kwh") is not None:
            if v.get("hoyere_fastledd"):
                deler.append(f"Denne timen ligger an til {v['forventet_time_kwh']:.2f} kWh — det ville øke fastleddet "
                             f"med {v['okning_fastledd_kr']:.0f} kr (til {v['forventet_trinn_kr']:.0f}).")
            elif v.get("hoyere_snitt"):
                deler.append(f"Denne timen ligger an til {v['forventet_time_kwh']:.2f} kWh — samme trinn, men snittet "
                             f"stiger til {v['forventet_snitt']:.2f} og gir mindre rom resten av måneden.")
            elif v.get("hoyere_dognmaks"):
                deler.append(f"Denne timen ligger an til {v['forventet_time_kwh']:.2f} kWh — ny døgnmaks, men uten "
                             f"virkning på topp tre.")
            else:
                deler.append(f"Denne timen ligger an til {v['forventet_time_kwh']:.2f} kWh — under dagens døgnmaks, "
                             f"påvirker ingenting.")
        deler.append(v["hvorfor"])
        if v["datakvalitet"] != "god":
            deler.append("Datakvalitet " + v["datakvalitet"] + ": " + "; ".join(v["datakvalitet_grunner"]) + ".")
        return " ".join(deler)
