"""Billading: bilen får det varmen ikke bruker.

Bilen er husets ideelle fleksible last. En panelovn som ikke får strøm blir kald og
må hentes igjen; bilen mister bare tid. Derfor ligger den nederst, og får bare
`ledig` — det motoren har til overs etter prognosen, berederen, marginen og varmen.
Den fortrenger aldri varme.

Ladestrømmen settes med fire knapper — 5, 10, 16 og 18 A — ikke med et tall. Vi kan
altså ikke regulere jevnt, bare velge det høyeste trinnet som holder seg under det
ledige. Får ikke engang 5 A plass, står ladingen.

Effektsensoren oppdaterer seg ved hver strømendring. Den brukes til å KONTROLLERE,
ikke til å styre: ligger bilen lavere enn trinnet vi satte — fordi den er nesten
full, eller kald — frigjøres differansen til de andre lastene i stedet for å stå
reservert til noe som ikke bruker den.

To sperrer holder den i ro:

  · minsteavstand mellom endringer, fordi hver endring gir bilen et lite avbrudd
  · dødbånd, så den ikke veksler mellom 16 og 18 A hver gang måleren spretter

Begge er nødvendige nettopp fordi sensoren er rask ved endring: uten dem ville hver
måling utløst en ny endring, som utløste en ny måling.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

from homeassistant.util import dt as dt_util

from .const import (
    CONF_LADER_BRYTER,
    CONF_LADER_EFFEKT,
    CONF_LADER_SOC,
    CONF_LADER_STED,
    CONF_LADER_STED_NAVN,
    CONF_LADESTROM_KNAPPER,
)
from .hub import KiHub

_LOGGER = logging.getLogger(__name__)

# Trinnene knappene gir, i ampere. Rekkefølgen er stigende og betyr noe.
TRINN = (5, 10, 16, 18)
# 230 V enfase. Brukes bare til å anslå hva et trinn koster i kW før vi har målt.
VOLT = 230.0


def trinn_kw(ampere: int) -> float:
    """Anslått effekt for et trinn, i kW."""
    return round(ampere * VOLT / 1000.0, 2)


def velg_trinn(ledig_kw: float, minste: int = 0) -> int | None:
    """Høyeste trinn som holder seg under `ledig_kw`.

    Returnerer None når ikke engang det laveste trinnet får plass — altså «ikke lad».
    `minste` lar en fremtidig innstilling kreve et gulv uten å røre logikken her.
    """
    kandidater = [a for a in TRINN if a >= minste and trinn_kw(a) <= ledig_kw]
    return max(kandidater) if kandidater else None


class KiLading:
    def __init__(self, hub: KiHub) -> None:
        self.hub = hub
        self.m = hub.minne.setdefault("lading", {})
        self.sist_endret: datetime | None = None
        self.satt_trinn: int | None = None
        self.var_pa = False

    # ------------------------------------------------------------------ oppsett
    def konfigurert(self) -> bool:
        return bool(self.hub.cfg(CONF_LADER_BRYTER)) and bool(self._knapper())

    def _knapper(self) -> dict[int, str]:
        """Trinn → entitets-ID for knappen. Bare trinn som faktisk er satt opp.

        Oppsettet kan gi to former, og begge må virke: et oppslag fra YAML
        (`{"16": "button..."}`) og en rein liste fra konfigurasjonsskjemaet, der
        brukeren bare velger knappene. For lista leses ampere ut av entitets-ID-en —
        «tesla_ladestrom_16a_button» gir 16. Finner vi ikke et tall, hopper vi over
        knappen i stedet for å gjette, for en knapp på feil trinn er verre enn en
        manglende knapp.
        """
        rå = self.hub.cfg(CONF_LADESTROM_KNAPPER)
        ut: dict[int, str] = {}
        if isinstance(rå, dict):
            for a in TRINN:
                eid = rå.get(str(a)) or rå.get(a)
                if eid:
                    ut[a] = eid
            return ut
        if isinstance(rå, str):
            rå = [rå]
        for eid in (rå or []):
            m = re.search(r"(\d{1,2})\s*a(?![a-z0-9])", str(eid).lower())
            if not m:
                _LOGGER.warning(
                    "ki_energi lading: fant ingen ampere i %s — knappen hoppes over. "
                    "Entitets-ID-en må inneholde trinnet, som «..._16a_...».", eid)
                continue
            a = int(m.group(1))
            if a in TRINN:
                ut[a] = eid
            else:
                _LOGGER.warning("ki_energi lading: %s A er ikke et kjent trinn %s — hopper over %s",
                                a, TRINN, eid)
        return ut

    def _bryter(self) -> str | None:
        return self.hub.cfg(CONF_LADER_BRYTER)

    def lader(self) -> bool | None:
        """Står bryteren på? None når den ikke svarer."""
        eid = self._bryter()
        if not eid:
            return None
        st = self.hub.hass.states.get(eid)
        if st is None or st.state in ("unknown", "unavailable"):
            return None
        return st.state == "on"

    def soc(self) -> float | None:
        """Batterinivå i prosent, eller None."""
        eid = self.hub.cfg(CONF_LADER_SOC)
        if not eid:
            return None
        st = self.hub.hass.states.get(eid)
        if st is None or st.state in ("unknown", "unavailable"):
            return None
        try:
            return float(st.state)
        except (TypeError, ValueError):
            return None

    def hjemme(self) -> bool | None:
        """Står bilen på stedet den skal lades?

        Returnerer None når vi ikke kan vite det — enten fordi stedet ikke er satt opp,
        eller fordi sensoren ikke svarer. De to behandles ulikt av den som spør: er
        stedet ikke satt opp, er det ingen stedssperre; svarer ikke sensoren, rører vi
        ingenting.
        """
        eid = self.hub.cfg(CONF_LADER_STED)
        navn = (self.hub.cfg(CONF_LADER_STED_NAVN) or "").strip()
        if not eid or not navn:
            return None
        st = self.hub.hass.states.get(eid)
        if st is None or st.state in ("unknown", "unavailable", ""):
            return None
        return st.state.strip().casefold() == navn.casefold()

    def bor_lade(self) -> tuple[bool, str]:
        """Skal bilen lades i det hele tatt? Hysterese på batterinivået.

        Stopper ved øvre grense og starter igjen først under den nedre. Avstanden er
        poenget: uten den ville den vippet av og på rundt ett eneste tall, og hver vipp
        er et avbrudd for bilen.

        Det gir også oppførselen man vil ha når bilen har vært borte. Kommer den hjem
        med 75 % etter å ha blitt full, står den — den er full nok. Kommer den hjem med
        60 %, lader den. Vi trenger derfor ingen egen «har vært borte»-tilstand: nivået
        forteller alt vi må vite.
        """
        soc = self.soc()
        if soc is None:
            return True, ""          # uten batterinivå gjelder bare effektbudsjettet

        stopp = self.hub.num("ki_lading_stopp_ved", 80)
        start = self.hub.num("ki_lading_start_under", 70)
        if start >= stopp:
            start = max(0, stopp - 10)

        if soc >= stopp:
            self.m["soc_full"] = True
            return False, f"Batteriet er på {soc:.0f} % — fulladet ved {stopp:.0f} %"
        if soc < start:
            self.m["soc_full"] = False
            return True, ""
        # Mellom grensene: behold forrige avgjørelse.
        if self.m.get("soc_full"):
            return False, (f"Batteriet er på {soc:.0f} % — lader igjen først under "
                           f"{start:.0f} %")
        return True, ""

    def effekt_kw(self) -> float | None:
        """Bilens målte ladeeffekt i kW, eller None."""
        eid = self.hub.cfg(CONF_LADER_EFFEKT)
        if not eid:
            return None
        st = self.hub.hass.states.get(eid)
        if st is None or st.state in ("unknown", "unavailable"):
            return None
        try:
            v = float(st.state)
        except (TypeError, ValueError):
            return None
        enhet = (st.attributes.get("unit_of_measurement") or "").lower()
        if enhet.startswith("kw"):
            return round(v, 3)
        if enhet.startswith("w"):
            return round(v / 1000.0, 3)
        # Ingen enhet i det hele tatt — det skjer med tall fra broer som Homey Link.
        # Da gjetter vi på størrelsen: en bil lader aldri på 400 kW, men godt på
        # 400 W, så alt over 100 leses som watt.
        return round(v / 1000.0, 3) if abs(v) > 100 else round(v, 3)

    # -------------------------------------------------------------- vurderingen
    def vurder(self, ledig_kw: float) -> dict:
        """Hva ladingen bør gjøre med `ledig_kw` til rådighet.

        Rein funksjon bortsett fra at den leser tilstand. Setter ingenting — det gjør
        `bruk()`. Delingen gjør at vurderingen kan vises i kortet uten å utløse noe.
        """
        h = self.hub
        naa = dt_util.utcnow()

        if not self.konfigurert():
            return {"handling": "ingen", "trinn": None, "kw": 0.0,
                    "forklaring": "Lading er ikke satt opp"}

        if not h.on("ki_lading_automatikk", True):
            return {"handling": "manuell", "trinn": None, "kw": self.effekt_kw() or 0.0,
                    "forklaring": "Automatikken er av — ladingen styres manuelt"}

        pa = self.lader()
        if pa is None:
            return {"handling": "utilgjengelig", "trinn": None, "kw": 0.0,
                    "forklaring": "Laderen svarer ikke — rører den ikke"}

        # Stedssperren går foran alt. Står bilen et annet sted, er laderen der ikke vår,
        # og vi skal verken starte eller stoppe den.
        hjemme = self.hjemme()
        if hjemme is False:
            sted = h.hass.states.get(h.cfg(CONF_LADER_STED))
            hvor = sted.state if sted else "et annet sted"
            self.satt_trinn = None
            return {"handling": "borte", "trinn": None, "kw": 0.0,
                    "forklaring": f"Bilen står på {hvor} — rører ikke laderen"}
        if hjemme is None and h.cfg(CONF_LADER_STED):
            return {"handling": "borte", "trinn": None, "kw": 0.0,
                    "forklaring": "Vet ikke hvor bilen står — rører ikke laderen"}

        # Fulladet? Da stopper vi, uansett hvor mye ledig effekt det er.
        skal, grunn = self.bor_lade()
        if not skal:
            if not pa:
                return {"handling": "av", "trinn": None, "kw": 0.0, "forklaring": grunn}
            return {"handling": "stopp", "trinn": None, "kw": 0.0, "forklaring": grunn}

        målt = self.effekt_kw()

        # Bilen tar mindre enn trinnet tillater: da er resten ikke vår å reservere.
        if pa and målt is not None and self.satt_trinn:
            forventet = trinn_kw(self.satt_trinn)
            if målt < forventet - 0.5:
                ledig_kw += forventet - målt

        ønsket = velg_trinn(ledig_kw)

        # Minsteavstand: hver endring gir bilen et avbrudd, så vi haster ikke.
        min_min = h.num("ki_lading_min_mellom_min", 5)
        for_tidlig = (self.sist_endret is not None
                      and naa - self.sist_endret < timedelta(minutes=min_min))

        if ønsket is None:
            if not pa:
                return {"handling": "av", "trinn": None, "kw": 0.0,
                        "forklaring": f"Ingen ledig effekt ({ledig_kw:.1f} kW) — "
                                      f"{trinn_kw(TRINN[0]):.1f} kW trengs for laveste trinn"}
            return {"handling": "stopp", "trinn": None, "kw": 0.0,
                    "forklaring": f"Bare {ledig_kw:.1f} kW ledig — stopper ladingen"}

        if not pa:
            return {"handling": "start", "trinn": ønsket, "kw": trinn_kw(ønsket),
                    "forklaring": f"{ledig_kw:.1f} kW ledig — starter på {ønsket} A"}

        if self.satt_trinn == ønsket:
            return {"handling": "hold", "trinn": ønsket, "kw": målt if målt is not None else trinn_kw(ønsket),
                    "forklaring": f"Lader på {ønsket} A"}

        # Dødbånd: vi bytter bare når det nye trinnet gir noe å hente.
        dødbånd = h.num("ki_lading_dodband_kw", 0.6)
        if self.satt_trinn is not None:
            gevinst = abs(trinn_kw(ønsket) - trinn_kw(self.satt_trinn))
            if gevinst < dødbånd:
                return {"handling": "hold", "trinn": self.satt_trinn,
                        "kw": målt if målt is not None else trinn_kw(self.satt_trinn),
                        "forklaring": f"Holder {self.satt_trinn} A — "
                                      f"{ønsket} A endrer bare {gevinst:.1f} kW"}

        if for_tidlig:
            igjen = min_min - int((naa - self.sist_endret).total_seconds() // 60)
            return {"handling": "hold", "trinn": self.satt_trinn,
                    "kw": målt if målt is not None else trinn_kw(self.satt_trinn or ønsket),
                    "forklaring": f"Vil til {ønsket} A, men venter {max(igjen, 1)} min "
                                  f"siden forrige endring"}

        return {"handling": "endre", "trinn": ønsket, "kw": trinn_kw(ønsket),
                "forklaring": f"{ledig_kw:.1f} kW ledig — går fra "
                              f"{self.satt_trinn or '?'} A til {ønsket} A"}

    # ------------------------------------------------------------------ utføring
    async def bruk(self, ledig_kw: float) -> dict:
        """Vurderer og utfører. Returnerer vurderingen, som også publiseres."""
        v = self.vurder(ledig_kw)
        h = self.hub
        naa = dt_util.utcnow()
        knapper = self._knapper()

        if v["handling"] in ("start", "endre"):
            eid = knapper.get(v["trinn"])
            if eid:
                await h.hass.services.async_call(
                    "button", "press", {"entity_id": eid}, blocking=False)
                self.satt_trinn = v["trinn"]
                self.sist_endret = naa
            if v["handling"] == "start":
                await h.hass.services.async_call(
                    "switch", "turn_on", {"entity_id": self._bryter()}, blocking=False)
                self.var_pa = True
            _LOGGER.debug("ki_energi lading: %s", v["forklaring"])

        elif v["handling"] == "stopp":
            await h.hass.services.async_call(
                "switch", "turn_off", {"entity_id": self._bryter()}, blocking=False)
            self.var_pa = False
            self.satt_trinn = None
            self.sist_endret = naa
            _LOGGER.debug("ki_energi lading: %s", v["forklaring"])

        self.publiser(v, ledig_kw)
        return v

    def publiser(self, v: dict, ledig_kw: float) -> None:
        self.hub.sett_sensor("ki_lading_status", v["handling"], {
            "forklaring": v["forklaring"],
            "trinn_a": v["trinn"],
            "effekt_kw": round(v["kw"], 2),
            "ledig_kw": round(ledig_kw, 2),
            "malt_kw": self.effekt_kw(),
            "satt_trinn_a": self.satt_trinn,
            "trinn_tilgjengelig": sorted(self._knapper()),
            "sist_endret": self.sist_endret.isoformat() if self.sist_endret else None,
            "automatikk": self.hub.on("ki_lading_automatikk", True),
            "batteri_pst": self.soc(),
            "stopp_ved_pst": self.hub.num("ki_lading_stopp_ved", 80),
            "start_under_pst": self.hub.num("ki_lading_start_under", 70),
            "fulladet": bool(self.m.get("soc_full")),
            "hjemme": self.hjemme(),
            "sted_navn": self.hub.cfg(CONF_LADER_STED_NAVN) or "",
        })
