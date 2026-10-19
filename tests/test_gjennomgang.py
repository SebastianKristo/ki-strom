"""Gjennomgang høsten 2026, punkt 5–11 (1–4 ligger i test_vvb_midt_i_syklus.py).

Hver test beskriver en feil som ble funnet: hva brukeren ville merket, og at det ikke
skjer lenger.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi.engine import KiEngine
from custom_components.ki_energi.lading import KiLading
from custom_components.ki_energi.modes import KiModuser
from custom_components.ki_energi.nettleie import KiNettleie
from custom_components.ki_energi.prognose import KiPrognoselaering

from test_lading import FalskHub as LadeHub
from test_nettleie import FakeHub as NettHub, _fyll_dag
from test_prognose import FakeHub as ProgHub, _kjor_time

OSLO = ZoneInfo("Europe/Oslo")


@pytest.fixture
def frys(monkeypatch):
    def _f(dt: datetime):
        monkeypatch.setattr(dt_util, "now", lambda *a, **k: dt.astimezone(OSLO))
        monkeypatch.setattr(dt_util, "utcnow", lambda *a, **k: dt.astimezone(timezone.utc))
        dt_util.set_default_time_zone(OSLO)
    return _f


# ----------------------------------------------------------------------
#  5: bilen er styrt last, ikke uregulert
# ----------------------------------------------------------------------
def test_5_ladeeffekten_regnes_som_styrt():
    lading = KiLading(LadeHub(bryter="on", effekt=7.2))
    assert lading.styrt_w() == pytest.approx(7200)

    # uten effektsensor: trinnet vi satte
    lading2 = KiLading(LadeHub(bryter="on"))
    lading2.hub.cfg = lambda k, _c=lading2.hub.cfg: None if k == "lader_effekt" else _c(k)
    lading2.satt_trinn = 16
    assert lading2.styrt_w() == pytest.approx(lading2.kw_for(16) * 1000)

    # automatikken av: motoren styrer ikke bilen, da er den uregulert
    assert KiLading(LadeHub(bryter="on", effekt=7.2, auto=False)).styrt_w() == 0.0


def test_5_uregulert_effekt_inneholder_ikke_bilen():
    lading = KiLading(LadeHub(bryter="on", effekt=7.0))
    tilstander = {"sensor.total": 9000.0}
    hub = SimpleNamespace(
        cfg=lambda k, d=None: {"total_effekt": "sensor.total"}.get(k, d),
        f=lambda e, d=None: tilstander.get(e, d),
        aktive_soner=lambda: {}, vvb=None, lading=lading,
    )
    e = object.__new__(KiEngine)
    e.hub = hub
    assert e.styrt_effekt_w() == pytest.approx(7000)    # 9 kW totalt − 7 kW bil = 2 kW uregulert


# ----------------------------------------------------------------------
#  6: målet gis ikke opp på snittet av én dag
# ----------------------------------------------------------------------
def test_6_en_hoy_dag_tidlig_i_maaneden_gir_ikke_opp_maalet(frys):
    frys(datetime(2026, 9, 2, 12, 0, tzinfo=OSLO))
    hub = NettHub(num={"ki_maks_time_kwh": 6.0, "ki_min_time_kwh": 3.0, "ki_mal_trinn_kw": 5.0,
                       "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    _fyll_dag(n, "2026-09-01", {17: 5.5})
    v = n.vurder(2.0)
    # 5,5 / 3 = 1,83 < 5: målet er fortsatt innen rekkevidde
    assert not v["mal_tapt"] and v["effektivt_mal_kw"] == 5.0
    # to dager som alene gir et sluttsnitt over målet: da er det tapt
    n2 = KiNettleie(NettHub(num=dict(hub._num)))
    for d in ("2026-09-01", "2026-09-02"):
        _fyll_dag(n2, d, {17: 8.0})
    assert n2.vurder(2.0)["mal_tapt"]           # (8 + 8) / 3 = 5,33 ≥ 5


# ----------------------------------------------------------------------
#  7: marginen eksploderer ikke de siste minuttene av timen
# ----------------------------------------------------------------------
def test_7_laert_margin_skaleres_ned_mot_timeslutt(frys):
    pl = KiPrognoselaering(ProgHub())
    start = datetime(2026, 9, 1, 0, 0, tzinfo=OSLO)
    for d in range(40):
        _kjor_time(pl, frys, start + timedelta(days=d % 20, hours=12 + d // 20), 3.0, 3.3)
    frys(datetime(2026, 9, 25, 12, 45, tzinfo=OSLO))
    m15, m5, m1 = pl.margin(15), pl.margin(5), pl.margin(1)
    assert m15["kilde"] != "fast", m15
    # som kW over tiden igjen (slik motoren bruker den) skal reserven være jevn, ikke eksplodere
    kw15, kw5, kw1 = m15["kwh"] / (15 / 60), m5["kwh"] / (5 / 60), m1["kwh"] / (1 / 60)
    assert kw5 == pytest.approx(kw15, rel=0.05)
    assert kw1 == pytest.approx(kw15, rel=0.05)


# ----------------------------------------------------------------------
#  8–10: moduser
# ----------------------------------------------------------------------
def _modus(**verdier):
    m = object.__new__(KiModuser)
    satt = dict(verdier)
    m.hub = SimpleNamespace(
        on=lambda n, std=False: bool(satt.get(n, std)),
        sett=lambda n, v: satt.__setitem__(n, v),
        dt=lambda n: satt.get(n),
        lagre=lambda *a, **k: None,
        tid_min=lambda n, std="00:00": int(std[:2]) * 60 + int(std[3:]),
        fritidsbolig=lambda: False,
        engine=None,
        cfg=lambda n, d=None: satt.get("__cfg__", {}).get(n, d),
        finnes=lambda e: True,
        st=lambda e: satt.get("__fukt__"),
        num=lambda n, std=0: std,
    )
    m.m = {}
    return m, satt


async def test_8_sparemodus_fra_varselet_oppheves_ikke_naar_noen_er_hjemme():
    m, satt = _modus(ki_helgemodus=True)
    await m._noen_hjemme()                         # noen har vært hjemme hele tiden
    assert satt["ki_helgemodus"] is True


async def test_8_noen_som_kommer_hjem_avslutter_sparemodus():
    m, satt = _modus(ki_helgemodus=True)
    m.m["borte_siden"] = (dt_util.now() - timedelta(hours=30)).isoformat()
    await m._noen_hjemme()
    assert satt["ki_helgemodus"] is False and "borte_siden" not in m.m


async def test_9_hjemkomst_bryteren_virker_ogsaa_andre_gang(frys):
    frys(datetime(2026, 10, 20, 10, 0, tzinfo=OSLO))
    gammel = datetime(2026, 10, 12, 17, 0, tzinfo=OSLO)
    m, satt = _modus(ki_hjemkomst_planlagt=gammel)
    await m.bryter_endret("ki_hjemkomst_aktiv", True)
    assert satt["ki_hjemkomst_planlagt"] > dt_util.now(), "gammel plan ble stående — hjemkomsten avsluttes straks"


def test_10_bad_vifta_beholder_fuktklokka_naar_haanklevarmerens_fukt_er_av(frys):
    naa = datetime(2026, 10, 20, 7, 0, tzinfo=OSLO)
    frys(naa)
    m, satt = _modus(ki_hanklevarmer_fukt=False, __cfg__={"bad_fukt": "sensor.fukt"}, __fukt__="85")
    assert m._fukt_utlost(naa) is False            # vifta starter klokka
    m.fukt_vindu(naa + timedelta(minutes=1))       # håndklevarmeren (fukt av) i samme tick
    assert "fukt_over_siden" in m.m
    assert m._fukt_utlost(naa + timedelta(minutes=5)) is True


# ----------------------------------------------------------------------
#  11: passert hjemkomsttid holder dagtemperatur
# ----------------------------------------------------------------------
def test_11_forsinket_hjemkomst_faller_ikke_til_hvilenivaa(frys):
    frys(datetime(2026, 10, 23, 17, 20, tzinfo=OSLO))
    plan = datetime(2026, 10, 23, 17, 0, tzinfo=OSLO)
    verdier = {"ki_hjemkomst_aktiv": True, "ki_hjemkomst_planlagt": plan, "number.stue_dag": 21.5}
    hub = SimpleNamespace(
        on=lambda n, std=False: bool(verdier.get(n, std)),
        dt=lambda n: verdier.get(n),
        num=lambda n, std=0: verdier.get(n, std),
        tid_min=lambda n, std="00:00": int(std[:2]) * 60 + int(std[3:]),
        mellom=lambda a, b, n=None: True,
        fritidsbolig=lambda: False,
        frost_paslag=lambda: (0.0, ""),
    )
    e = object.__new__(KiEngine)
    e.hub = hub
    e.overstyring = lambda key: None
    e.leggetid_aktiv = lambda key: None
    mal, grunn, frist = e.mal_temperatur("stue", {"temp_dag": "number.stue_dag", "profil": "fellesrom"})
    assert mal == 21.5 and frist is None, grunn
