"""Gjennomgang høsten 2026 — de mindre funnene.

Lading som ikke trapper ned, stedssperre uten stedsnavn, kvarterspriser, nærværssensor som
har falt ut, timeavslutning, varmetapslæring, tick-lås for tjenestene, tynning av
registerprøver og attributter som ikke skal i recorder.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

import custom_components.ki_energi as ki_init
from custom_components.ki_energi.engine import KiEngine
from custom_components.ki_energi.lys import KiLys
from custom_components.ki_energi.nettleie import Timemaler
from custom_components.ki_energi.sensor import KiSensor
from custom_components.ki_energi.vvb import KiVvb

from test_lading import NAA, lag

OSLO = ZoneInfo("Europe/Oslo")


@pytest.fixture
def frys(monkeypatch):
    monkeypatch.setattr(dt_util, "utcnow", lambda *a, **k: NAA)
    return NAA


# ----------------------------------------------------------------------
#  Lading
# ----------------------------------------------------------------------
def test_lading_trapper_ned_selv_innenfor_dodbaandet(frys):
    """18 A (4,14 kW), men bare 3,9 kW ledig: 16 A, selv om forskjellen er under dødbåndet."""
    lading, _ = lag(bryter="on", effekt=4.14, dodband=0.6)
    lading.satt_trinn = 18
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(3.9)
    assert v["handling"] == "endre" and v["trinn"] == 16


def test_lading_trapper_ned_selv_rett_etter_forrige_endring(frys):
    lading, _ = lag(bryter="on", effekt=4.14, mellom=5)
    lading.satt_trinn = 18
    lading.sist_endret = NAA - timedelta(minutes=1)
    v = lading.vurder(2.4)
    assert v["handling"] == "endre" and v["trinn"] == 10


def test_lading_venter_fortsatt_oppover(frys):
    lading, _ = lag(bryter="on", effekt=2.3, mellom=5)
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=1)
    assert lading.vurder(4.5)["handling"] == "hold"


def test_stedssensor_uten_stedsnavn_er_ingen_sperre(frys):
    lading, _ = lag(bryter="on", effekt=2.3, sted="Storgata 1, Oslo", sted_navn="")
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=20)
    assert lading.vurder(2.4)["handling"] != "borte"


# ----------------------------------------------------------------------
#  Bereder: kvarterspriser
# ----------------------------------------------------------------------
@pytest.fixture
def oslo():
    gammel = dt_util.get_default_time_zone()
    dt_util.set_default_time_zone(OSLO)
    yield
    dt_util.set_default_time_zone(gammel)


def test_billige_timer_bruker_snittet_av_kvarterene(oslo):
    """Timen 02 har et billig første kvarter, men er dyr i snitt. Timen 03 er billigst i snitt."""
    start = datetime(2026, 10, 20, 2, 0, tzinfo=OSLO)
    raa = []
    for kvarter, pris in enumerate([0.10, 1.00, 1.00, 1.00, 0.40, 0.40, 0.40, 0.40]):
        raa.append({"start": (start + timedelta(minutes=15 * kvarter)).isoformat(), "value": pris})
    priser = KiVvb._timepriser(raa)
    assert priser[start] == pytest.approx(0.775)
    assert priser[start + timedelta(hours=1)] == pytest.approx(0.40)
    assert min(priser, key=priser.get).hour == 3


# ----------------------------------------------------------------------
#  Lys
# ----------------------------------------------------------------------
async def test_glemt_lys_slaas_ikke_av_naar_naervaerssensoren_har_falt_ut():
    naa = datetime(2026, 10, 20, 12, 0, tzinfo=OSLO)
    kall = []
    sensor = SimpleNamespace(state="unavailable", last_changed=naa - timedelta(minutes=30))

    async def _kall(*a):
        kall.append(a)

    hub = SimpleNamespace(minne={}, hass=SimpleNamespace(states=SimpleNamespace(get=lambda e: sensor)),
                          kall=_kall, mellom=lambda a, b, n: True, tid_min=lambda n, s: 0, engine=None)
    lys = KiLys(hub)
    st = {"navn": "Stue"}
    await lys._glemt({"key": "stue", "light": "light.stue", "presence": "binary_sensor.stue"},
                     st, True, 30, naa, 10.0)
    assert kall == [] and st["status"] == "mangler"


# ----------------------------------------------------------------------
#  Timeavslutning: én vei, uansett hvem som lukker timen
# ----------------------------------------------------------------------
async def test_ticket_som_lukker_timen_gir_ogsaa_varsel_og_prognoselaering():
    varsler, evaluert = [], []

    async def _varsle(*a, **k):
        varsler.append(a)

    hub = SimpleNamespace(
        prognose=SimpleNamespace(evaluer=lambda rader: evaluert.extend(rader) or len(rader)),
        on=lambda n, std=False: std, num=lambda n, std=0: std, varsle=_varsle, tell=lambda *a: None,
    )
    e = object.__new__(KiEngine)
    e.hub = hub
    e.nettleie_vurdering = {"grense_kwh": 5.0}
    e.logg_hendelse = lambda *a: None
    start = datetime(2026, 10, 20, 17, 0, tzinfo=timezone.utc).timestamp()
    await e._timer_lukket([{"start": start, "kwh": 6.1, "kvalitet": "malt"}])
    assert len(evaluert) == 1, "prognosen ble ikke evaluert"
    assert varsler and "Effektgrense passert" in varsler[0][0]


# ----------------------------------------------------------------------
#  Varmetapslæring: avrundede termostater gir ikke skjev k
# ----------------------------------------------------------------------
def test_varmetap_laeres_riktig_fra_termostat_i_halve_grader(monkeypatch):
    """Rommet kjøles 0,5 °C/t mot 0 °C ute fra 20 °C: sann k = 0,025. Termostaten melder i 0,5-steg.
    Før ble hvert steg lest som 6 °C/t over fem minutter, og k havnet nær taket."""
    klokke = [datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)]
    monkeypatch.setattr(dt_util, "utcnow", lambda *a, **k: klokke[0])
    minne = {"profil": {}, "tau": {}}
    hub = SimpleNamespace(
        minne=minne, on=lambda n, std=False: std, sensor_state=lambda n: None,
        f=lambda e, d=None: 0.0, cfg=lambda k, d=None: "sensor.ute" if k == "ute_temp" else d,
        aktive_soner=lambda: {"stue": {"climate": "climate.stue", "navn": "Stue"}},
        attr=lambda *a: None, pa=lambda e: False, sett_sensor=lambda *a, **k: None, lagre=lambda *a, **k: None,
    )
    e = object.__new__(KiEngine)
    e.hub = hub
    e.temp_forrige = {}
    t0 = klokke[0]
    e.romtemperatur = lambda konf: round((20.0 - 0.5 * (klokke[0] - t0).total_seconds() / 3600) * 2) / 2
    e.sone_effekt_w = lambda konf: 0.0
    for _ in range(12 * 8):                      # åtte timer, læring hvert 5. minutt
        e._laering_indre()
        klokke[0] += timedelta(minutes=5)
    k = minne["tau"]["stue"]["k"]
    assert 0.012 < k < 0.045, k


# ----------------------------------------------------------------------
#  Tjenestene deler tick-låsen
# ----------------------------------------------------------------------
async def test_tjeneste_venter_paa_tick_laasen():
    kjort = []

    class Del:
        def __init__(self, navn):
            self.navn = navn

        async def tick(self):
            kjort.append(self.navn)

    hub = SimpleNamespace(tick_laas=asyncio.Lock(), moduser=Del("moduser"), vvb=Del("vvb"),
                          lys=Del("lys"), engine=Del("motor"))
    registrert = {}
    hass = SimpleNamespace(
        data={ki_init.DOMAIN: {"x": hub}},
        services=SimpleNamespace(has_service=lambda d, n: False,
                                 async_register=lambda d, n, fn, schema=None: registrert.__setitem__(n, fn)),
    )
    ki_init._registrer_tjenester(hass)
    async with hub.tick_laas:
        oppgave = asyncio.ensure_future(registrert["tick"](SimpleNamespace(data={})))
        await asyncio.sleep(0.01)
        assert kjort == [], "tjenesten kjørte tick mens et annet tick holdt låsen"
    await oppgave
    assert kjort == ["moduser", "vvb", "lys", "motor"]


# ----------------------------------------------------------------------
#  Tynning av registerprøver
# ----------------------------------------------------------------------
def test_proever_tynnes_midt_i_timen_men_timegrensene_er_maalt():
    m = Timemaler({})
    start = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc).timestamp()
    for i in range(-30, 3600 + 30, 2):          # HAN hvert 2. sekund, 2,0 kW jevnt
        ts = start + i
        m.prove(ts, 1000.0 + 2.0 * i / 3600)
    assert len(m.m["prover"]) < 120, len(m.m["prover"])
    rad = m.lukk_time(start)
    assert rad["kvalitet"] == "malt" and rad["kwh"] == pytest.approx(2.0, abs=0.01)


# ----------------------------------------------------------------------
#  Recorder
# ----------------------------------------------------------------------
def test_store_attributter_holdes_utenfor_recorder():
    for navn in ("laster", "tankegang", "linjer", "doegn"):
        assert navn in KiSensor._unrecorded_attributes
