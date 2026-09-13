"""Adaptiv reserve fra prognosefeil — rene tester mot en falsk hub."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi.prognose import HORISONTER, KiPrognoselaering, segment_for, vektet_persentil

OSLO = ZoneInfo("Europe/Oslo")


class FakeHub:
    def __init__(self, **num):
        self.minne = {}
        self._num = {"ki_reserve_uregulert_kwh": 0.35, "ki_reserve_topp_kwh": 0.3, **num}
        self._on = {"ki_adaptiv_reserve": True}
        self.sensorer = {}
        self.lagret = 0
    def num(self, k, d=0.0): return self._num.get(k, d)
    def on(self, k, d=False): return self._on.get(k, d)
    def lagre(self, *a, **k): self.lagret += 1
    def sett_sensor(self, k, state, attrs=None): self.sensorer[k] = (state, attrs or {})


@pytest.fixture
def frys(monkeypatch):
    def _f(dt: datetime):
        monkeypatch.setattr(dt_util, "now", lambda *a, **k: dt.astimezone(OSLO))
        monkeypatch.setattr(dt_util, "utcnow", lambda *a, **k: dt.astimezone(timezone.utc))
    return _f


def _budsjett(min_igjen, forbrukt):
    return {"minutter_igjen": min_igjen, "timer_igjen": min_igjen / 60, "forbrukt": forbrukt, "usikker": False}


def _kjor_time(pl, frys, start: datetime, forventet_kw: float, faktisk: float, plan=None, senk_etter=None, kvalitet="malt"):
    """Simulerer én time: prognoser ved 60/45/30/15 min igjen, så lukking med `faktisk`."""
    plan = plan or []
    for min_igjen in (60, 45, 30, 15):
        t = start + timedelta(minutes=60 - min_igjen)
        frys(t)
        p = plan
        if senk_etter is not None and min_igjen <= senk_etter:
            p = plan + [{"key": "stue", "handling": "senket"}]
        forbrukt = forventet_kw * (60 - min_igjen) / 60
        pl.registrer(_budsjett(min_igjen, forbrukt), forventet_kw, p, "ok", 1.0, 0.0, pl.margin(min_igjen)["kwh"])
    frys(start + timedelta(minutes=61))
    return pl.evaluer([{"start": start.astimezone(timezone.utc).timestamp(), "kwh": faktisk, "kvalitet": kvalitet}])


def test_oppstart_uten_historikk_gir_fast_reserve(frys):
    frys(datetime(2026, 9, 10, 12, 0, tzinfo=OSLO))
    pl = KiPrognoselaering(FakeHub())
    m = pl.margin(45)
    assert m["status"] == "laerer" and m["kilde"] == "fast"
    assert m["kwh"] == pytest.approx(0.35 * 45 / 60, abs=1e-3)      # fast reserve (kW) × tid igjen


def test_presise_prognoser_gir_liten_margin_og_undervurdering_gir_stor(frys):
    hub = FakeHub()
    pl = KiPrognoselaering(hub)
    t0 = datetime(2026, 9, 1, 12, 0, tzinfo=OSLO)
    # 10 timer der prognosen treffer nesten: feil ±0,05
    for i in range(10):
        _kjor_time(pl, frys, t0 + timedelta(days=i), 3.0, 3.0 + (0.05 if i % 2 else -0.05))
    m = pl.margin(45)
    assert m["status"] == "aktiv" and m["kwh"] <= 0.1
    assert m["n_alle"] == 40                                        # 4 horisonter × 10 timer
    # så 10 timer med gjentatt undervurdering på 0,8 kWh
    for i in range(10, 20):
        _kjor_time(pl, frys, t0 + timedelta(days=i), 3.0, 3.8)
    m2 = pl.margin(45)
    assert m2["kwh"] > 0.4 and m2["kwh"] <= 1.5
    assert "høyere enn prognosen" in m2["grunn"]
    # ingen pendling: 12 gode timer rett etterpå gir nesten ingen nedgang (P80 er fortsatt dominert av feilene)
    for i in range(20, 32):
        _kjor_time(pl, frys, t0 + timedelta(days=i), 3.0, 3.0)
    m3 = pl.margin(45)
    assert m3["kwh"] >= 0.4 and m3["kwh"] <= m2["kwh"] + 0.01
    # men over lang tid med gode prognoser glir marginen ned igjen (nyere observasjoner veier mer)
    for i in range(32, 70):
        _kjor_time(pl, frys, t0 + timedelta(days=i), 3.0, 3.0)
    assert pl.margin(45)["kwh"] < 0.15


def test_horisonter_vurderes_separat(frys):
    pl = KiPrognoselaering(FakeHub())
    t0 = datetime(2026, 9, 1, 12, 0, tzinfo=OSLO)
    # feilen er stor tidlig i timen (60 min igjen) men liten sent (15 min igjen):
    # registrer() bruker samme forventet_kw for alle, så vi manipulerer forventet via faktisk per horisont
    for i in range(10):
        start = t0 + timedelta(days=i)
        for min_igjen in (60, 45, 30, 15):
            frys(start + timedelta(minutes=60 - min_igjen))
            # tidlig i timen tror motoren 2,5 kW, sent vet den 3,0
            fkw = 2.5 if min_igjen >= 45 else 3.0
            pl.registrer(_budsjett(min_igjen, 3.0 * (60 - min_igjen) / 60), fkw, [], "ok", 1, 0, 0.3)
        frys(start + timedelta(minutes=61))
        pl.evaluer([{"start": start.astimezone(timezone.utc).timestamp(), "kwh": 3.0, "kvalitet": "malt"}])
    assert pl.m["margin"]["60"] > pl.m["margin"]["15"]
    assert pl.margin(58)["kwh"] > pl.margin(14)["kwh"]


def test_tiltak_etter_prognose_holdes_utenfor(frys):
    pl = KiPrognoselaering(FakeHub())
    t0 = datetime(2026, 9, 1, 12, 0, tzinfo=OSLO)
    # motoren senker stua ved 30 min igjen → prognosene laget før det (60, 45) er påvirket
    n = _kjor_time(pl, frys, t0, 3.0, 2.4, senk_etter=30)
    assert n == 4
    obs = pl.m["feil"]
    assert [o["horisont"] for o in obs if o["pavirket"]] == [60, 45]
    assert [o["horisont"] for o in obs if not o["pavirket"]] == [30, 15]
    assert pl.m["n_pavirket"] == 2
    # de påvirkede teller ikke i marginen — sluttforbruket falt pga. tiltaket, ikke pga. feil prognose
    assert all(not o["pavirket"] for o in pl._gyldige())


def test_manglende_data_og_omstart(frys):
    hub = FakeHub()
    pl = KiPrognoselaering(hub)
    t0 = datetime(2026, 9, 1, 12, 0, tzinfo=OSLO)
    assert _kjor_time(pl, frys, t0, 3.0, 3.0, kvalitet="mangler") == 0
    assert pl.m["n_utelatt_kvalitet"] == 4 and pl.m["feil"] == []
    # «forelopig_delvis» (ukjent nullpunkt) utelates også
    frys(t0 + timedelta(days=1))
    pl.registrer(_budsjett(60, 0.0), 3.0, [], "forelopig_delvis", 1, 0, 0.3)
    frys(t0 + timedelta(days=1, minutes=61))
    assert pl.evaluer([{"start": (t0 + timedelta(days=1)).astimezone(timezone.utc).timestamp(), "kwh": 3.0, "kvalitet": "malt"}]) == 0
    # omstart: samme minne-dict lastes i ny instans — frosne prognoser overlever, ingen dobbeltregistrering
    frys(t0 + timedelta(days=2))
    pl.registrer(_budsjett(60, 0.0), 3.0, [], "ok", 1, 0, 0.3)
    pl2 = KiPrognoselaering(hub)
    frys(t0 + timedelta(days=2, minutes=1))
    pl2.registrer(_budsjett(59, 0.05), 3.0, [], "ok", 1, 0, 0.3)   # samme horisont igjen → ikke ny
    nk = pl2.time_nokkel(t0 + timedelta(days=2))
    assert list(pl2.m["prognoser"][nk].keys()) == ["60"]


def test_sommertid_gir_entydige_timenokler():
    hoest = datetime(2026, 10, 25, 2, 30, tzinfo=OSLO)           # første 02:30 (CEST)
    hoest2 = hoest.replace(fold=1)                                # andre 02:30 (CET)
    assert hoest.hour == hoest2.hour == 2
    assert KiPrognoselaering.time_nokkel(hoest) != KiPrognoselaering.time_nokkel(hoest2)


def test_deaktivering_gir_fast_reserve(frys):
    hub = FakeHub()
    pl = KiPrognoselaering(hub)
    t0 = datetime(2026, 9, 1, 12, 0, tzinfo=OSLO)
    for i in range(10):
        _kjor_time(pl, frys, t0 + timedelta(days=i), 3.0, 3.8)
    assert pl.margin(45)["status"] == "aktiv"
    hub._on["ki_adaptiv_reserve"] = False
    m = pl.margin(45)
    assert m["status"] == "av" and m["kwh"] == pytest.approx(0.35 * 45 / 60, abs=1e-3)
    pl.nullstill()
    assert pl.m["feil"] == [] and pl.m["margin"] == {}


def test_grenser_og_hjelpefunksjoner():
    assert vektet_persentil([(0.1, 1), (0.5, 1), (0.9, 1)], 0.8) == 0.9
    assert vektet_persentil([], 0.8) is None
    assert segment_for(datetime(2026, 9, 12, 7, 0)) == "morgen_helg"
    assert segment_for(datetime(2026, 9, 10, 13, 0)) == "dag_hverdag"
