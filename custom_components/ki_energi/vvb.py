"""Varmtvannsbereder: metning, vindu, prisstyring og legionella.

Berederen har ingen temperatursensor, men den har en termostat. Bryter PÅ og
effekt ~0 i noen minutter betyr at termostaten har koblet ut: vannet er på
settpunkt. Det er både «varmtvannet er klart» og legionellabekreftelsen,
forutsatt at termostaten fysisk står på 65–70 °C.

Fallgruven: ødelagt element gir samme signatur. Derfor kreves at berederen
HAR trukket effekt siden bryteren ble slått på før null effekt telles som
metning.

Legionella er den ene tingen energisparingen aldri får blokkere. Den
håndteres her, utenfor prioriteringsmotoren, og kan bare utsettes av
effektvakten mens fristen ikke er passert — aldri avlyses.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from homeassistant.util import dt as dt_util

from .const import CONF_NORDPOOL, CONF_NORGESPRIS_AKTIV, CONF_VVB_BRYTER, CONF_VVB_EFFEKT
from .hub import KiHub

_LOGGER = logging.getLogger(__name__)
GYLDIG_FRA = datetime(2000, 1, 1, tzinfo=dt_util.UTC)


class KiVvb:
    def __init__(self, hub: KiHub) -> None:
        self.hub = hub
        self.m = hub.minne.setdefault("vvb", {})
        self.over_siden: datetime | None = None
        self.under_siden: datetime | None = None
        self.var_aktiv = False
        self.var_mettet = False
        self.var_bor_varme: bool | None = None
        self.for_lenge_varslet = False
        self.sist_tvang: datetime | None = None
        self.billige_timer: list[int] = []
        self.billige_sist: datetime | None = None
        self._siste_bryter: str | None = None

    # ------------------------------------------------------------------
    def bryter(self) -> str:
        return self.hub.cfg(CONF_VVB_BRYTER) or ""

    def effekt(self) -> float | None:
        return self.hub.f(self.hub.cfg(CONF_VVB_EFFEKT))

    def konfigurert(self) -> bool:
        return bool(self.bryter())

    def bryter_pa(self) -> bool:
        return self.hub.st(self.bryter()) == "on"

    def varmer(self) -> bool:
        return self.var_aktiv

    def _dt(self, key: str) -> datetime | None:
        v = self.hub.dt(key)
        if v is None or v < GYLDIG_FRA:
            return None
        return v

    # ------------------------------------------------------------------
    #  Avledede tilstander
    # ------------------------------------------------------------------
    def i_vindu(self, naa_min: int | None = None) -> bool:
        h = self.hub
        return h.mellom(h.tid_min("ki_vvb_vindu_start", "22:00"), h.tid_min("ki_vvb_klar_innen", "05:00"), naa_min)

    def dager_siden(self) -> float | None:
        s = self._dt("ki_vvb_siste_godkjente_syklus")
        if s is None:
            return None
        return round((dt_util.now() - s).total_seconds() / 86400.0, 2)

    def legionella_ok(self) -> bool:
        d = self.dager_siden()
        return d is not None and d < self.hub.num("ki_vvb_intervall_dager", 3)

    def forfalt(self) -> bool:
        if not self.hub.on("ki_vvb_legionella_aktiv", True):
            return False
        d = self.dager_siden()
        return d is not None and d > self.hub.num("ki_vvb_maks_dager", 7)

    def boost_aktiv(self) -> bool:
        b = self._dt("ki_vvb_boost_til")
        return b is not None and b > dt_util.now()

    def ferdig_i_vinduet(self) -> bool:
        h = self.hub
        naa = dt_util.now()
        start_min = h.tid_min("ki_vvb_vindu_start", "22:00")
        start = naa.replace(hour=start_min // 60, minute=start_min % 60, second=0, microsecond=0)
        if naa < start:
            start -= timedelta(days=1)
        s = self._dt("ki_vvb_siste_godkjente_syklus")
        return s is not None and s > start

    def oppvarming_minutter(self) -> int:
        if not self.var_aktiv:
            return 0
        s = self._dt("ki_vvb_oppvarming_startet")
        if s is None:
            return 0
        return int((dt_util.now() - s).total_seconds() / 60)

    def ingen_respons(self) -> bool:
        h = self.hub
        s = self._dt("ki_vvb_oppvarming_startet")
        if s is None or not self.bryter_pa() or h.on("ki_vvb_har_trukket_effekt"):
            return False
        if self.effekt() is None:
            return False  # kan ikke vite — ikke rop ulv
        gikk = (dt_util.now() - s).total_seconds() / 60
        return gikk > h.num("ki_vvb_maks_min_uten_effekt", 10)

    def billig_time_na(self) -> bool:
        h = self.hub
        if h.on("ki_vvb_folg_spotpris") and h.cfg(CONF_NORDPOOL) and not h.pa(h.cfg(CONF_NORGESPRIS_AKTIV)):
            return dt_util.now().hour in self.billige_timer
        return self.i_vindu()

    def bor_varme(self) -> bool:
        h = self.hub
        if h.on("ki_vvb_alltid_pa"):
            return True
        if self.ingen_respons():
            return False
        if self.forfalt():
            return True
        if self.boost_aktiv():
            return not self.var_mettet
        if not h.on("ki_vvb_prisstyring", True):
            return self.bryter_pa()
        if self.effekt() is None:
            # Fail-safe uten effektmåling: følg vinduet, la termostaten styre
            return self.i_vindu()
        if self.var_mettet:
            return False
        if self.ferdig_i_vinduet() and self.legionella_ok():
            return False
        if self.billig_time_na():
            if self.var_aktiv:
                return True
            return h.sensor_state("ki_energi_status") not in ("rod", "kritisk")
        return False

    # ------------------------------------------------------------------
    #  Reservasjon av effekt for energimotoren
    # ------------------------------------------------------------------
    def reservasjon(self) -> tuple[float, str, bool]:
        h = self.hub
        if not self.konfigurert():
            if self.effekt() is not None:
                return 0.0, "Berederen måles, men har ingen bryter — regnes som uregulert last", False
            return 0.0, "Berederen er ikke konfigurert", False
        effekt = (self.effekt() or 0.0) / 1000.0
        nominell = h.num("ki_vvb_effekt_kw", 2.0) or 2.0
        if self.var_aktiv:
            return max(effekt, nominell * 0.9), "Berederen varmer nå", True
        if self.var_mettet:
            return 0.0, "Mettet — termostaten har koblet ut", False
        if self.forfalt() or h.on("ki_vvb_tvungen_syklus_aktiv"):
            return nominell, "Tvungen kjøring — legionella går foran all oppvarming", True
        if self.bor_varme():
            return nominell, "Berederen skal varme nå", False
        if self.i_vindu():
            return nominell * 0.5, "I oppvarmingsvinduet — kan starte når som helst", False
        if self.bryter_pa():
            return nominell * 0.25, "Innkoblet, men utenfor vinduet", False
        return 0.0, "Berederen er utkoblet", False

    def reservasjon_om(self, minutter: int) -> float:
        h = self.hub
        if not self.konfigurert():
            return 0.0
        nominell = h.num("ki_vvb_effekt_kw", 2.0) or 2.0
        if self.var_aktiv:
            return nominell * 0.9 if minutter <= 60 else nominell * 0.4
        if self.var_mettet or (self.ferdig_i_vinduet() and self.legionella_ok()):
            return 0.0
        t = (h.naa_min() + minutter) % (24 * 60)
        if self.i_vindu(t):
            return nominell * 0.6
        return 0.0

    # ------------------------------------------------------------------
    #  Hovedløkke
    # ------------------------------------------------------------------
    async def tick(self) -> None:
        h = self.hub
        if not self.konfigurert():
            for k in ("ki_vvb_oppvarming_aktiv", "ki_vvb_mettet", "ki_vvb_ingen_respons", "ki_vvb_i_vindu",
                      "ki_vvb_billig_time_na", "ki_vvb_boost_aktiv", "ki_vvb_ferdig_i_vinduet",
                      "ki_vvb_legionella_ok", "ki_vvb_legionella_forfalt", "ki_vvb_bor_varme"):
                h.sett_sensor(k, None)
            h.sett_sensor("ki_vvb_legionella_status", "Ikke konfigurert")
            if self.effekt() is not None:
                h.sett_sensor("ki_vvb_forklaring", f"Berederen måles ({self.effekt():.0f} W), men har ingen bryter. "
                              "Motoren lærer forbruket inn som uregulert last. Legg til et relé senere for prisstyring og legionella.")
            else:
                h.sett_sensor("ki_vvb_forklaring", "Ingen varmtvannsbereder er satt opp i integrasjonen.")
            return
        naa = dt_util.now()

        # Manglende dato → sett nå, så «dager siden» blir definert.
        if self._dt("ki_vvb_siste_godkjente_syklus") is None:
            h.sett("ki_vvb_siste_godkjente_syklus", naa)
            await h.logbook("KI VVB", "Datoen for siste metning manglet og er satt til nå. Første ekte metning overskriver den.")

        # Bryteren slått på → nullstill effektflagg
        bryter = h.st(self.bryter())
        if bryter == "on" and self._siste_bryter != "on":
            h.sett("ki_vvb_har_trukket_effekt", False)
            h.sett("ki_vvb_oppvarming_startet", naa)
            self.for_lenge_varslet = False
        self._siste_bryter = bryter

        # Effekt over/under terskel med debounce
        effekt = self.effekt()
        terskel = h.num("ki_vvb_metning_terskel_w", 150)
        if effekt is not None:
            if effekt > terskel:
                self.over_siden = self.over_siden or naa
                self.under_siden = None
            else:
                self.under_siden = self.under_siden or naa
                self.over_siden = None
        aktiv = bool(self.over_siden and (naa - self.over_siden).total_seconds() >= 20) if effekt is not None else False
        if effekt is not None and self.var_aktiv and self.under_siden and (naa - self.under_siden).total_seconds() < 20:
            aktiv = True  # delay_off

        if aktiv and not self.var_aktiv:
            h.sett("ki_vvb_har_trukket_effekt", True)
            h.sett("ki_vvb_kritisk_varslet", False)
        self.var_aktiv = aktiv

        # Metning
        mettet = (bryter == "on" and h.on("ki_vvb_har_trukket_effekt") and effekt is not None
                  and effekt <= terskel and self.under_siden is not None
                  and (naa - self.under_siden).total_seconds() >= h.num("ki_vvb_metning_minutter", 8) * 60)
        if mettet and not self.var_mettet:
            await self._metning(naa)
        self.var_mettet = mettet

        # Ingen respons
        ingen = self.ingen_respons()
        if ingen and not h.on("ki_vvb_kritisk_varslet"):
            h.sett("ki_vvb_kritisk_varslet", True)
            await h.varsle("Varmtvannsbereder svarer ikke",
                           f"Bryteren har stått på i {int(h.num('ki_vvb_maks_min_uten_effekt', 10))} minutter uten at "
                           "effekten har steget. Sjekk sikring, kontaktor og element fysisk.", alltid=True, kategori="vvb")

        # Varer for lenge
        minutter = self.oppvarming_minutter()
        if minutter > h.num("ki_vvb_maks_oppvarming_min", 300) and not self.for_lenge_varslet:
            self.for_lenge_varslet = True
            await h.varsle("Berederen har varmet lenge",
                           f"{minutter} minutter sammenhengende uten at termostaten har koblet ut. Verdt et blikk.", kategori="vvb")

        # Legionella: forfalt → tving. Prøver igjen hver 2. time til den er mettet.
        if self.forfalt() and not mettet:
            if not h.on("ki_vvb_tvungen_syklus_aktiv") or (
                    self.sist_tvang and (naa - self.sist_tvang) > timedelta(hours=2)):
                h.sett("ki_vvb_tvungen_syklus_aktiv", True)
                self.sist_tvang = naa
                if bryter != "on":
                    await h.kall("switch", "turn_on", {"entity_id": self.bryter()})
                await h.varsle("Legionellafrist passert",
                               f"Det er {self.dager_siden()} dager siden berederen sist nådde settpunktet. Tvinger oppvarming nå.",
                               alltid=True, kategori="vvb")
                if h.engine is not None:
                    h.engine.logg_hendelse("Legionellafrist passert — berederen tvinges på uansett pris og effekt.")

        # Billige timer (hvert 15. min)
        if self.billige_sist is None or (naa - self.billige_sist) > timedelta(minutes=15):
            self.billige_sist = naa
            self._beregn_billige_timer()

        # Følg beslutning
        bv = self.bor_varme()
        if h.on("ki_vvb_prisstyring", True) or self.boost_aktiv() or h.on("ki_vvb_tvungen_syklus_aktiv") or self.forfalt():
            if bv and bryter != "on":
                await h.kall("switch", "turn_on", {"entity_id": self.bryter()})
                await h.logbook("KI VVB", "På: " + self.forklaring())
            elif not bv and bryter == "on" and not self.var_aktiv and not self.forfalt():
                await h.kall("switch", "turn_off", {"entity_id": self.bryter()})
                await h.logbook("KI VVB", "Av: " + self.forklaring())
        self.var_bor_varme = bv

        self._publiser(bv, mettet, ingen)

    async def _metning(self, naa: datetime) -> None:
        h = self.hub
        s = self._dt("ki_vvb_oppvarming_startet")
        minutter = int((naa - s).total_seconds() / 60) if s else 0
        h.sett("ki_vvb_siste_godkjente_syklus", naa)
        h.sett("ki_vvb_tvungen_syklus_aktiv", False)
        h.sett("ki_vvb_kritisk_varslet", False)
        await h.logbook("KI VVB", f"Mettet etter {minutter} minutter. Termostaten koblet ut, så vannet er på settpunkt. "
                                  "Legionellasikringen er bekreftet.")
        if h.engine is not None:
            h.engine.logg_hendelse(f"Varmtvannsbereder mettet etter {minutter} min — legionella bekreftet.")
        if h.on("ki_vvb_prisstyring", True) and not h.on("ki_vvb_alltid_pa"):
            await h.kall("switch", "turn_off", {"entity_id": self.bryter()})

    def _doegn(self, raa: list, naa: datetime) -> list[dict]:
        """24 timer fra nå: pris (hvis kjent), om timen er valgt som billig, og om den er i vinduet."""
        h = self.hub
        pris: dict[tuple[int, int], float] = {}
        for p in raa:
            try:
                s = p.get("start")
                if isinstance(s, str):
                    s = dt_util.parse_datetime(s)
                s = dt_util.as_local(s)
                pris.setdefault((s.day, s.hour), float(p.get("value", 0) or 0))
            except Exception:  # noqa: BLE001
                continue
        folg = h.on("ki_vvb_folg_spotpris") and not h.pa(h.cfg(CONF_NORGESPRIS_AKTIV))
        ut = []
        for i in range(24):
            t = naa + timedelta(hours=i)
            ut.append({"t": t.hour, "pris": pris.get((t.day, t.hour)),
                       "valgt": (t.hour in self.billige_timer) if folg else self.i_vindu(t.hour * 60),
                       "vindu": self.i_vindu(t.hour * 60), "naa": i == 0})
        return ut

    def _beregn_billige_timer(self) -> None:
        h = self.hub
        nordpool = h.cfg(CONF_NORDPOOL)
        n = int(h.num("vvb_billigste_timer_dogn", 6))
        if not nordpool:
            self.billige_timer = []
            metode = ("Norgespris er aktiv — energiprisen er lik hele døgnet, så spotpris trengs ikke. "
                      "Berederen følger vinduet (billigste nettleie)." if h.pa(h.cfg(CONF_NORGESPRIS_AKTIV))
                      else "Ingen spotprissensor valgt. Berederen følger vinduet, ikke enkelttimer.")
            h.sett_sensor("ki_vvb_billige_timer", n, {"timer": [], "metode": metode, "antall_kandidater": 0,
                                                        "norgespris": bool(h.pa(h.cfg(CONF_NORGESPRIS_AKTIV))), "har_priser": False,
                                                        "doegn": self._doegn([], dt_util.now().replace(minute=0, second=0, microsecond=0))})
            return
        naa = dt_util.now().replace(minute=0, second=0, microsecond=0)
        klar_min = h.tid_min("ki_vvb_klar_innen", "05:00")
        klar = naa.replace(hour=klar_min // 60, minute=klar_min % 60)
        if klar <= dt_util.now():
            klar += timedelta(days=1)
        rt = h.attr(nordpool, "raw_today", []) or []
        rm = h.attr(nordpool, "raw_tomorrow", []) or []
        kand, sett = [], set()
        for p in list(rt) + list(rm):
            try:
                s = p.get("start")
                if isinstance(s, str):
                    s = dt_util.parse_datetime(s)
                s = dt_util.as_local(s)
                nokkel = s.day * 100 + s.hour
                if s >= naa and s < klar and nokkel not in sett:
                    sett.add(nokkel)
                    kand.append((float(p.get("value", 0) or 0), s.hour))
            except Exception:  # noqa: BLE001
                continue
        timer: list[int] = []
        for _v, hr in sorted(kand):
            if len(timer) < n and hr not in timer:
                timer.append(hr)
        self.billige_timer = sorted(timer)
        if not h.on("ki_vvb_folg_spotpris"):
            metode = "Ikke i bruk. Berederen følger vinduet, ikke enkelttimer."
        elif h.pa(h.cfg(CONF_NORGESPRIS_AKTIV)):
            metode = "Norgespris er aktiv, så energiprisen er lik hele natta. Vinduet brukes."
        else:
            metode = "De billigste timene etter spotpris fram til fristen."
        h.sett_sensor("ki_vvb_billige_timer", n, {"timer": self.billige_timer, "metode": metode,
                                                    "antall_kandidater": len(rt) + len(rm),
                                                    "norgespris": bool(h.pa(h.cfg(CONF_NORGESPRIS_AKTIV))),
                                                    "har_priser": bool(rt or rm),
                                                    "doegn": self._doegn(list(rt) + list(rm), naa)})

    def status_tekst(self) -> str:
        h = self.hub
        if h.on("ki_vvb_kritisk_varslet"):
            return "KRITISK - ingen respons fra berederen"
        if self.var_aktiv:
            return "Varmer nå"
        if self.var_mettet:
            return "Mettet - termostaten har koblet ut"
        if self.forfalt():
            return "Forfalt - tvungen kjøring"
        if self.ferdig_i_vinduet():
            return "Ferdig for i natt"
        if self.i_vindu():
            return "I vindu - venter på oppvarming"
        return "Venter på vinduet"

    def forklaring(self) -> str:
        h = self.hub
        start = h.tid_str("ki_vvb_vindu_start", "22:00")
        slutt = h.tid_str("ki_vvb_klar_innen", "05:00")
        if h.on("ki_vvb_kritisk_varslet"):
            return "Berederen har stått på uten å trekke effekt. Sjekk sikring, kontaktor og element."
        if h.on("ki_vvb_alltid_pa"):
            return "Står på alltid-på. Automatikken er koblet ut."
        if self.forfalt():
            return "Legionellafristen er passert. Kjører uansett pris og effektsituasjon."
        if self.boost_aktiv():
            b = self._dt("ki_vvb_boost_til")
            return f"Boost til kl. {b:%H:%M}." if b else "Boost aktiv."
        if not h.on("ki_vvb_prisstyring", True):
            return "Automatikken er av. Berederen står som den står."
        if self.effekt() is None:
            return "Effektsensoren svarer ikke — følger vinduet og lar termostaten styre (fail-safe)."
        if self.var_mettet:
            return "Mettet. Termostaten koblet ut, så vannet er på settpunkt."
        if self.ferdig_i_vinduet():
            return f"Ferdig for i natt. Neste vindu åpner kl. {start}."
        if self.var_aktiv:
            return "Varmer. Slår av av seg selv når termostaten kobler ut."
        if self.i_vindu():
            if h.sensor_state("ki_energi_status") in ("rod", "kritisk"):
                return f"I vinduet {start}-{slutt}, men effektvakten holder igjen starten."
            return f"I vinduet {start}-{slutt}, venter på start."
        return f"Utenfor vinduet. Åpner kl. {start}."

    def _publiser(self, bv: bool, mettet: bool, ingen: bool) -> None:
        h = self.hub
        h.sett_sensor("ki_vvb_oppvarming_aktiv", self.var_aktiv)
        h.sett_sensor("ki_vvb_mettet", mettet)
        h.sett_sensor("ki_vvb_ingen_respons", ingen)
        h.sett_sensor("ki_vvb_i_vindu", self.i_vindu())
        h.sett_sensor("ki_vvb_billig_time_na", self.billig_time_na())
        h.sett_sensor("ki_vvb_boost_aktiv", self.boost_aktiv())
        h.sett_sensor("ki_vvb_ferdig_i_vinduet", self.ferdig_i_vinduet())
        h.sett_sensor("ki_vvb_legionella_ok", self.legionella_ok())
        h.sett_sensor("ki_vvb_legionella_forfalt", self.forfalt())
        h.sett_sensor("ki_vvb_bor_varme", bv)
        h.sett_sensor("ki_vvb_dager_siden_siste_syklus", self.dager_siden())
        h.sett_sensor("ki_vvb_oppvarming_minutter", self.oppvarming_minutter())
        h.sett_sensor("ki_vvb_legionella_status", self.status_tekst(), {
            "dager_siden_syklus": self.dager_siden(),
            "intervall_dager": h.num("ki_vvb_intervall_dager", 3),
            "hard_frist_dager": h.num("ki_vvb_maks_dager", 7),
            "tvungen": h.on("ki_vvb_tvungen_syklus_aktiv"),
            "legionella_aktiv": h.on("ki_vvb_legionella_aktiv", True)})
        h.sett_sensor("ki_vvb_forklaring", self.forklaring())
        kw, grunn, _ma = self.reservasjon()
        siste = self._dt("ki_vvb_siste_godkjente_syklus")
        maks_d = h.num("ki_vvb_maks_dager", 7)
        intervall = h.num("ki_vvb_intervall_dager", 3)
        bryter = h.st(self.bryter())
        eff = self.effekt()
        terskel = h.num("ki_vvb_metning_terskel_w", 150)
        h.sett_sensor("ki_bereder", self.status_tekst(), {
            "reservert_kw": round(kw, 2), "forklaring": grunn,
            "dager_siden_syklus": self.dager_siden(), "tvungen_syklus": h.on("ki_vvb_tvungen_syklus_aktiv"),
            "bryter": self.bryter(), "bryter_pa": bryter == "on",
            "effekt_sensor": h.cfg("vvb_effekt") or "", "effekt_w": eff,
            "varmer": bryter == "on" and eff is not None and eff > terskel,
            "legionella_aktiv": h.on("ki_vvb_legionella_aktiv", True),
            "sikret": self.legionella_ok(), "forfalt": self.forfalt(),
            "siste_syklus": siste.isoformat() if siste else None,
            "neste_frist": (siste + timedelta(days=maks_d)).isoformat() if siste else None,
            "onsket_innen": (siste + timedelta(days=intervall)).isoformat() if siste else None,
            "intervall_dager": intervall, "hard_frist_dager": maks_d,
            "vindu": f"{h.tid_str('ki_vvb_vindu_start', '22:00')}–{h.tid_str('ki_vvb_klar_innen', '05:00')}",
            "boost_til": (self._dt("ki_vvb_boost_til").isoformat() if self.boost_aktiv() else None)})

    # ------------------------------------------------------------------
    #  Tjenester
    # ------------------------------------------------------------------
    async def boost(self, minutter: float | None = None) -> None:
        h = self.hub
        m = minutter or h.num("ki_vvb_boost_minutter", 60)
        h.sett("ki_vvb_boost_til", dt_util.now() + timedelta(minutes=float(m)))
        await h.kall("switch", "turn_on", {"entity_id": self.bryter()})
        await self.tick()

    async def avbryt_boost(self) -> None:
        self.hub.sett("ki_vvb_boost_til", dt_util.now() - timedelta(minutes=1))
        await self.tick()

    async def tving_syklus(self) -> None:
        h = self.hub
        h.sett("ki_vvb_tvungen_syklus_aktiv", True)
        await h.kall("switch", "turn_on", {"entity_id": self.bryter()})
        await h.logbook("KI VVB", "Tvungen kjøring startet manuelt.")
        await self.tick()
