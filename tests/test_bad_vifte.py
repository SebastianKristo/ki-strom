"""Tester for baderomsvifta og den delte fuktutløsningen.

Vifta og håndklevarmeren startes av samme måling, men har hver sin varighet. Det er
nettopp samspillet mellom dem som er verdt å teste: at den ene ikke stjeler utløsningen
fra den andre.
"""
from __future__ import annotations

import types
from datetime import datetime, timedelta, timezone

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi.modes import KiModuser

NAA = datetime(2026, 9, 19, 7, 0, tzinfo=timezone.utc)


class FalskSt:
    def __init__(self, state):
        self.state = str(state)
        self.attributes = {}


class FalskHub:
    def __init__(self, fukt=None, vifte="off", vifte_pa=True, minutter=20,
                 grense=70, kreves=3, timer=2, har_vifte=True):
        self._fukt = fukt
        self._vifte = vifte
        self._vifte_pa = vifte_pa
        self._minutter = minutter
        self._grense = grense
        self._kreves = kreves
        self._timer = timer
        self._har_vifte = har_vifte
        self.minne = {}
        self.logg = []
        # IKKE `self.kall = []` her: attributtet ville skygget for metoden `kall()`
        # under, og hvert tjenestekall ville feilet med «list object is not callable».
        self.tjenester = []

    def cfg(self, key, standard=None):
        return {"bad_fukt": "sensor.bad_fukt" if self._fukt is not None else "",
                "bad_vifte": "switch.badvifte" if self._har_vifte else ""}.get(key, standard)

    def finnes(self, eid):
        if eid == "switch.badvifte":
            return self._har_vifte
        return bool(eid) and self._fukt is not None

    def st(self, eid):
        if eid == "switch.badvifte":
            return self._vifte
        return str(self._fukt) if self._fukt is not None else "unknown"

    def on(self, key, standard=True):
        return {"ki_bad_vifte_fukt": self._vifte_pa,
                "ki_hanklevarmer_fukt": True}.get(key, standard)

    def num(self, key, standard=0):
        return {"ki_bad_vifte_minutter": self._minutter,
                "ki_hanklevarmer_fukt_grense": self._grense,
                "ki_hanklevarmer_fukt_minutter": self._kreves,
                "ki_hanklevarmer_fukt_timer": self._timer}.get(key, standard)

    async def kall(self, domene, tjeneste, data):
        self.tjenester.append((domene, tjeneste, data.get("entity_id")))
        if data.get("entity_id") == "switch.badvifte":
            self._vifte = "on" if tjeneste == "turn_on" else "off"

    async def logbook(self, navn, tekst):
        self.logg.append((navn, tekst))


Hub = FalskHub


def lag(**kw):
    modes = object.__new__(KiModuser)
    hub = Hub(**kw)
    modes.hub = hub
    modes.m = hub.minne
    return modes, hub


@pytest.fixture
def frys(monkeypatch):
    monkeypatch.setattr(dt_util, "utcnow", lambda: NAA)
    return NAA


async def kjor(modes, naa):
    await modes.bad_vifte(naa)


# ------------------------------------------------------------------ utløsningen
def test_utlost_forst_etter_sammenhengende_tid():
    modes, _ = lag(fukt=85, kreves=3)
    assert modes._fukt_utlost(NAA) is False                       # klokka starter
    assert modes._fukt_utlost(NAA + timedelta(minutes=2)) is False
    assert modes._fukt_utlost(NAA + timedelta(minutes=3)) is True


def test_fall_under_grensen_nullstiller():
    modes, hub = lag(fukt=85, kreves=3)
    modes._fukt_utlost(NAA)
    hub._fukt = 50
    modes._fukt_utlost(NAA + timedelta(minutes=2))
    assert "fukt_over_siden" not in modes.m


def test_utlosningen_stjeles_ikke_av_handklevarmeren():
    """Begge skal se samme utløsning i samme tikk.

    Håndklevarmeren nullstilte før klokka etter at den hadde åpnet sitt vindu, og da
    fikk vifta aldri vite at fukten hadde vært høy.
    """
    modes, _ = lag(fukt=85, kreves=3)
    modes._fukt_utlost(NAA)
    senere = NAA + timedelta(minutes=3)
    aktiv, _ = modes.fukt_vindu(senere)          # håndklevarmeren åpner sitt vindu
    assert aktiv is True
    assert modes._fukt_utlost(senere) is True    # vifta ser den fortsatt


# ------------------------------------------------------------------- selve vifta
@pytest.mark.asyncio
async def test_vifta_starter_og_stopper(frys):
    modes, hub = lag(fukt=85, kreves=3, minutter=20)
    modes._fukt_utlost(NAA)
    await kjor(modes, NAA + timedelta(minutes=3))
    assert ("switch", "turn_on", "switch.badvifte") in hub.tjenester
    assert hub._vifte == "on"

    hub.tjenester.clear()
    await kjor(modes, NAA + timedelta(minutes=10))     # midt i vinduet
    assert hub.tjenester == []
    assert hub._vifte == "on"

    await kjor(modes, NAA + timedelta(minutes=24))     # etter 20 min
    assert ("switch", "turn_off", "switch.badvifte") in hub.tjenester
    assert hub._vifte == "off"


@pytest.mark.asyncio
async def test_egen_varighet_fra_handklevarmeren(frys):
    """Vifta lufter i minutter, håndklevarmeren tørker i timer."""
    modes, hub = lag(fukt=85, kreves=1, minutter=20, timer=2)
    modes._fukt_utlost(NAA)
    t = NAA + timedelta(minutes=1)
    await kjor(modes, t)
    assert modes.fukt_vindu(t)[0] is True

    hub._fukt = 45
    senere = t + timedelta(minutes=25)
    await kjor(modes, senere)
    assert hub._vifte == "off"                      # vifta er ferdig
    assert modes.fukt_vindu(senere)[0] is True      # varmeren går fortsatt


@pytest.mark.asyncio
async def test_rorer_ikke_vifte_som_sto_pa_fra_for(frys):
    """Har noen startet vifta selv, slår vi den ikke av. Den som trykket vet best."""
    modes, hub = lag(fukt=85, kreves=1, minutter=20, vifte="on")
    modes._fukt_utlost(NAA)
    await kjor(modes, NAA + timedelta(minutes=1))
    assert hub.tjenester == []                      # sto alt på
    await kjor(modes, NAA + timedelta(minutes=30))  # etter vinduet
    assert ("switch", "turn_off", "switch.badvifte") not in hub.tjenester
    assert hub._vifte == "on"


@pytest.mark.asyncio
async def test_avslatt_gjor_ingenting(frys):
    modes, hub = lag(fukt=95, kreves=1, vifte_pa=False)
    modes._fukt_utlost(NAA)
    await kjor(modes, NAA + timedelta(minutes=2))
    assert hub.tjenester == []


@pytest.mark.asyncio
async def test_uten_vifte_gjor_ingenting(frys):
    modes, hub = lag(fukt=95, kreves=1, har_vifte=False)
    modes._fukt_utlost(NAA)
    await kjor(modes, NAA + timedelta(minutes=2))
    assert hub.tjenester == []


@pytest.mark.asyncio
async def test_ny_dusj_starter_vifta_igjen(frys):
    modes, hub = lag(fukt=85, kreves=1, minutter=20)
    modes._fukt_utlost(NAA)
    await kjor(modes, NAA + timedelta(minutes=1))
    hub._fukt = 40
    await kjor(modes, NAA + timedelta(minutes=25))
    assert hub._vifte == "off"

    hub.tjenester.clear()
    hub._fukt = 88
    t = NAA + timedelta(minutes=30)
    modes._fukt_utlost(t)
    await kjor(modes, t + timedelta(minutes=1))
    assert ("switch", "turn_on", "switch.badvifte") in hub.tjenester


@pytest.mark.parametrize("minutter", [5, 20, 45, 120])
@pytest.mark.asyncio
async def test_varigheten_respekteres(frys, minutter):
    modes, hub = lag(fukt=85, kreves=1, minutter=minutter)
    modes._fukt_utlost(NAA)
    start = NAA + timedelta(minutes=1)
    await kjor(modes, start)
    assert hub._vifte == "on"
    hub._fukt = 40
    await kjor(modes, start + timedelta(minutes=minutter - 1))
    assert hub._vifte == "on"
    await kjor(modes, start + timedelta(minutes=minutter + 1))
    assert hub._vifte == "off"
