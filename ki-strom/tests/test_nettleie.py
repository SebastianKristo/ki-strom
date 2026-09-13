"""Tester for nettleiemodellen: tariff, topp tre, timemåler og økonomisk grense.

De rene funksjonene testes uten Home Assistant. `KiNettleie.vurder()` testes mot en liten
falsk hub, med tid frosset via dt_util.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi.nettleie import (
    TARIFF_STANDARD, KiNettleie, Timemaler, parse_tariff, simuler, snitt_av, tak_for_idag, topp_tre, trinn,
)

OSLO = ZoneInfo("Europe/Oslo")


# ----------------------------------------------------------------------
#  1–3, 6: tariffmatematikk
# ----------------------------------------------------------------------
def test_1_ny_dag_5_5_gir_snitt_4_8_og_250():
    dager = {"2026-09-01": 4.8, "2026-09-02": 4.1, "2026-09-03": 3.9}
    s = simuler(dager, "2026-09-08", 5.5, TARIFF_STANDARD)
    assert [v for _d, v in s["ny_topper"]] == [5.5, 4.8, 4.1]
    assert s["ny_snitt"] == pytest.approx(4.8)
    assert s["ny_trinn"]["kr"] == 250
    assert s["okning_kr"] == 0
    assert s["hoyere_dognmaks"] and s["hoyere_snitt"] and not s["hoyere_fastledd"]
    assert s["redusert_margin"]


def test_2_ny_dag_6_1_gir_snitt_5_0_og_420():
    dager = {"2026-09-01": 4.8, "2026-09-02": 4.1, "2026-09-03": 3.9}
    s = simuler(dager, "2026-09-08", 6.1, TARIFF_STANDARD)
    assert s["ny_snitt"] == pytest.approx(5.0)
    assert s["ny_trinn"]["kr"] == 420          # nøyaktig 5,0 → trinnet fra 5 kW
    assert s["okning_kr"] == 170
    assert s["hoyere_fastledd"]


def test_3_andre_dag_paa_5_5_gir_5_27():
    dager = {"2026-09-01": 4.8, "2026-09-02": 4.1, "2026-09-03": 3.9, "2026-09-08": 5.5}
    s = simuler(dager, "2026-09-09", 5.5, TARIFF_STANDARD)
    assert [v for _d, v in s["ny_topper"]] == [5.5, 5.5, 4.8]
    assert s["ny_snitt"] == pytest.approx(5.2667, abs=1e-3)
    assert s["ny_trinn"]["kr"] == 420


def test_4_flere_timer_samme_dag_teller_en_gang():
    dager = {"2026-09-01": 4.8, "2026-09-02": 4.1, "2026-09-03": 3.9, "2026-09-08": 5.5}
    s = simuler(dager, "2026-09-08", 5.5, TARIFF_STANDARD)
    assert [v for _d, v in s["ny_topper"]] == [5.5, 4.8, 4.1]
    assert not s["hoyere_dognmaks"] and not s["hoyere_snitt"] and not s["hoyere_fastledd"]
    s2 = simuler(dager, "2026-09-08", 5.2, TARIFF_STANDARD)   # lavere time → ingenting
    assert not s2["hoyere_dognmaks"] and s2["ny_snitt"] == pytest.approx(4.8)


def test_5_hoyere_time_samme_dag_erstatter():
    dager = {"2026-09-01": 4.8, "2026-09-02": 4.1, "2026-09-03": 3.9, "2026-09-08": 5.5}
    s = simuler(dager, "2026-09-08", 6.0, TARIFF_STANDARD)
    assert s["hoyere_dognmaks"]
    assert [v for _d, v in s["ny_topper"]] == [6.0, 4.8, 4.1]     # 5,5 er borte, ikke telt dobbelt


def test_6_dagens_dato_i_topp_tre_telles_ikke_dobbelt():
    dager = {"2026-09-01": 4.8, "2026-09-02": 4.1, "2026-09-08": 5.5}
    s = simuler(dager, "2026-09-08", 5.4, TARIFF_STANDARD)
    assert len(s["ny_topper"]) == 3
    assert [v for _d, v in s["ny_topper"]] == [5.5, 4.8, 4.1]


def test_tariff_grenser_og_ukjent():
    assert trinn(1.99, TARIFF_STANDARD)["kr"] == 150
    assert trinn(2.0, TARIFF_STANDARD)["kr"] == 250
    assert trinn(4.999, TARIFF_STANDARD)["kr"] == 250
    assert trinn(5.0, TARIFF_STANDARD)["kr"] == 420
    assert trinn(19.99, TARIFF_STANDARD)["kr"] == 755
    assert trinn(20.0, TARIFF_STANDARD)["ukjent"] and trinn(20.0, TARIFF_STANDARD)["kr"] is None
    assert trinn(None, TARIFF_STANDARD)["ukjent"]
    assert parse_tariff("2:150, 5:250") == [(2, 150), (5, 250)]
    assert parse_tariff("tull") == TARIFF_STANDARD


def test_topp_tre_med_faerre_dager():
    assert topp_tre({"a": 3.0}) == [("a", 3.0)]
    assert snitt_av([]) is None
    assert tak_for_idag([4.8, 4.1], 5.0, 0.3) == pytest.approx(3 * 4.7 - 4.8 - 4.1)


# ----------------------------------------------------------------------
#  7–8: timemåler — timeskifte, forsinkelse, brudd, reset, sommertid
# ----------------------------------------------------------------------
def _ts(y, m, d, hh, mm=0, ss=0, tz=OSLO):
    return datetime(y, m, d, hh, mm, ss, tzinfo=tz).timestamp()


def test_7a_hel_time_maalt_ved_grensene():
    tm = Timemaler({})
    t0 = _ts(2026, 9, 8, 14)
    for i in range(0, 3601, 10):                    # prøve hvert 10. sekund
        tm.prove(t0 + i, 1000.0 + 0.001 * i)        # 3,6 kWh/t
    lukket = tm.oppdater(t0 + 3600 + 30)
    assert len(lukket) == 1
    assert lukket[0]["kwh"] == pytest.approx(3.6, abs=1e-3)
    assert lukket[0]["kvalitet"] == "malt"


def test_7b_nullpunkt_ved_timegrensen_ikke_ved_forste_tick():
    tm = Timemaler({})
    t0 = _ts(2026, 9, 8, 14)
    tm.prove(t0 - 60, 999.9)
    tm.prove(t0 + 5, 1000.0)                        # 5 s etter hel time → målt
    tm.prove(t0 + 600, 1000.4)                      # motoren «starter» 10 min inn i timen
    kwh, kv = tm.forelopig(t0 + 600, 1000.4)
    assert kwh == pytest.approx(0.4, abs=1e-6)      # starten av timen er med
    assert kv == "forelopig"


def test_7c_forsinket_maaling_ventes_paa_og_interpoleres():
    tm = Timemaler({})
    t0 = _ts(2026, 9, 8, 14)
    tm.prove(t0 - 20, 999.9)
    tm.prove(t0 + 10, 1000.0)
    tm.prove(t0 + 3600 - 120, 1003.5)               # siste prøve 2 min før timeslutt
    assert tm.oppdater(t0 + 3600 + 60) == []        # 1 min etter: venter fortsatt
    tm.prove(t0 + 3600 + 90, 1003.7)                # prøven kommer 90 s for sent
    lukket = tm.oppdater(t0 + 3600 + 100)
    assert len(lukket) == 1 and lukket[0]["kvalitet"] == "estimert"
    # lineær interpolering mellom 1003,5 (−120 s) og 1003,7 (+90 s) → ~1003,614 ved grensen
    assert lukket[0]["kwh"] == pytest.approx(3.614, abs=0.01)


def test_7d_langt_brudd_gir_mangler_ikke_null_og_ikke_alt_i_en_time():
    tm = Timemaler({})
    t0 = _ts(2026, 9, 8, 14)
    tm.prove(t0 - 10, 1000.0)
    tm.prove(t0 + 5, 1000.0)
    # omstart: ingen prøver på 4 timer (over grensen på 3 t for interpolering), så 12 kWh mer
    tm.prove(t0 + 4 * 3600 + 5, 1012.0)
    lukket = tm.oppdater(t0 + 4 * 3600 + 30)
    assert [r["kvalitet"] for r in lukket] == ["mangler"] * 4
    assert all(r["kwh"] is None for r in lukket)
    # neste time måles normalt igjen
    tm.prove(t0 + 5 * 3600 + 5, 1015.0)
    lukket = tm.oppdater(t0 + 5 * 3600 + 30)
    assert lukket[0]["kwh"] == pytest.approx(3.0) and lukket[0]["kvalitet"] == "malt"


def test_7e_maalerreset():
    tm = Timemaler({})
    t0 = _ts(2026, 9, 8, 14)
    tm.prove(t0 + 5, 1000.0)
    tm.prove(t0 + 1800, 12.0)                       # registeret nullstilt midt i timen
    tm.prove(t0 + 3600 + 5, 14.0)
    lukket = tm.oppdater(t0 + 3600 + 30)
    assert lukket[0]["kvalitet"] == "mangler" and lukket[0]["kwh"] is None
    tm.prove(t0 + 7200 + 5, 16.5)
    lukket = tm.oppdater(t0 + 7200 + 30)
    assert lukket[0]["kwh"] == pytest.approx(2.5) and lukket[0]["kvalitet"] == "malt"


def test_8_sommertid_hoest_25_timer_og_vaar_23_timer():
    tm = Timemaler({})
    # høst 2026: 25. oktober kl. 03:00 CEST → 02:00 CET. Døgnet har 25 timer.
    start = datetime(2026, 10, 25, 0, 0, tzinfo=OSLO).timestamp()
    slutt = datetime(2026, 10, 26, 0, 0, tzinfo=OSLO).timestamp()
    assert (slutt - start) / 3600 == 25
    v = 5000.0
    t = start
    while t <= slutt:
        tm.prove(t, v)
        t += 600
        v += 0.1                                   # 0,6 kWh/t jevnt
    tm.prove(slutt + 5, v)
    lukket = tm.oppdater(slutt + 60)
    assert len(lukket) == 25
    assert len({r["start"] for r in lukket}) == 25          # ingen time slått sammen
    assert all(r["kwh"] == pytest.approx(0.6, abs=1e-6) for r in lukket)
    # vår 2026: 29. mars kl. 02:00 CET → 03:00 CEST. 23 timer.
    tm2 = Timemaler({})
    start = datetime(2026, 3, 29, 0, 0, tzinfo=OSLO).timestamp()
    slutt = datetime(2026, 3, 30, 0, 0, tzinfo=OSLO).timestamp()
    assert (slutt - start) / 3600 == 23
    t, v = start, 100.0
    while t <= slutt + 5:
        tm2.prove(t, v)
        t += 600
        v += 0.1
    assert len(tm2.oppdater(slutt + 60)) == 23


# ----------------------------------------------------------------------
#  Falsk hub for vurder()
# ----------------------------------------------------------------------
class FakeHub:
    def __init__(self, cfg=None, num=None, on=None, tekst=None):
        self.minne = {"nettleie": {}}
        self._cfg = cfg or {}
        self._num = num or {}
        self._on = on or {}
        self._tekst = tekst or {}
        self.hass = None
        self.lagret = 0

    def cfg(self, k, d=None):
        return self._cfg.get(k, d)

    def f(self, eid, d=None):
        v = self._cfg.get("__states__", {}).get(eid)
        return d if v is None else v

    def num(self, k, d=0.0):
        return self._num.get(k, d)

    def on(self, k, d=False):
        return self._on.get(k, d)

    def tekst(self, k, d=""):
        return self._tekst.get(k, d)

    def lagre(self, forsinket=True):
        self.lagret += 1


def _fyll_dag(n: KiNettleie, dato: str, timer: dict[int, float]):
    """Legg inn fullførte timer for en dato (alle 24 timer; oppgitte overstyrer 1,0 kWh)."""
    for hh in range(24):
        start = datetime.fromisoformat(dato + "T00:00").replace(tzinfo=OSLO) + timedelta(hours=hh)
        kwh = timer.get(hh, 1.0)
        n.maler.m["timer"][Timemaler.nokkel(start.timestamp())] = {
            "start": start.timestamp(), "slutt": start.timestamp() + 3600, "kwh": kwh, "kvalitet": "malt",
            "start_kv": "malt", "slutt_kv": "malt"}


@pytest.fixture
def frys_tid(monkeypatch):
    def _frys(dt: datetime):
        monkeypatch.setattr(dt_util, "now", lambda *a, **k: dt.astimezone(OSLO))
        monkeypatch.setattr(dt_util, "utcnow", lambda *a, **k: dt.astimezone(timezone.utc))
        dt_util.set_default_time_zone(OSLO)
    return _frys


def test_9_eksterne_topper_uten_dato_gir_usikker_og_konservativ(frys_tid):
    frys_tid(datetime(2026, 9, 8, 15, 0, tzinfo=OSLO))
    hub = FakeHub(cfg={"topp1": "s1", "topp2": "s2", "topp3": "s3",
                       "__states__": {"s1": 4.8, "s2": 4.1, "s3": 3.9}},
                  num={"ki_maks_time_kwh": 6.0, "ki_min_time_kwh": 3.0, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    v = n.vurder(3.0)
    assert v["datakvalitet"] == "usikker" and v["udaterte_topper"] == 3
    assert [t["dato"] for t in v["topp_tre"]] == [None, None, None]
    assert v["registrert_snitt"] == pytest.approx(4.2667, abs=1e-3)
    assert v["reserve_kwh"] == pytest.approx(0.5)                       # 0,3 + 0,2 usikker
    # tak for i dag: 3·(5,0−0,5) − 4,8 − 4,1 = 4,6
    assert v["tak_okonomi_kwh"] == pytest.approx(4.6)
    assert v["grense_kwh"] == pytest.approx(4.6)
    # egen dag som matcher ekstern verdi regnes som samme dag
    _fyll_dag(n, "2026-09-03", {17: 4.8})
    v = n.vurder(3.0)
    assert v["udaterte_topper"] == 2 and v["kjente_dager"] == 1


def test_4b_dagens_registrerte_topp_utnyttes(frys_tid):
    frys_tid(datetime(2026, 9, 8, 15, 0, tzinfo=OSLO))
    hub = FakeHub(num={"ki_maks_time_kwh": 6.0, "ki_min_time_kwh": 3.0, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    _fyll_dag(n, "2026-09-01", {17: 4.8})
    _fyll_dag(n, "2026-09-02", {17: 4.1})
    _fyll_dag(n, "2026-09-03", {17: 3.9})
    # i dag: timene 00–14 er ferdige, kl. 07 endte på 5,5
    for hh in range(15):
        start = datetime(2026, 9, 8, hh, tzinfo=OSLO).timestamp()
        n.maler.m["timer"][Timemaler.nokkel(start)] = {"start": start, "slutt": start + 3600,
                                                       "kwh": 5.5 if hh == 7 else 1.0, "kvalitet": "malt",
                                                       "start_kv": "malt", "slutt_kv": "malt"}
    v = n.vurder(5.2)
    assert v["dagens_maks_kwh"] == 5.5 and v["dagens_maks_time"] == "07"
    assert v["registrert_snitt"] == pytest.approx(4.8) and v["registrert_trinn_kr"] == 250
    assert v["fri_tak_kwh"] == 5.5
    assert v["grense_kwh"] == pytest.approx(5.5)          # ikke strammet inn til 4,1
    assert not v["hoyere_dognmaks"] and v["okning_fastledd_kr"] == 0
    assert "endrer ingenting" in v["hvorfor"]
    # men en time på 6,1 ville øke fastleddet
    v2 = n.vurder(6.1)
    assert v2["hoyere_dognmaks"] and v2["forventet_trinn_kr"] == 420 and v2["okning_fastledd_kr"] == 170
    # i morgen er 5,5-dagen bare en av «de andre»: rommet krymper igjen
    frys_tid(datetime(2026, 9, 9, 9, 0, tzinfo=OSLO))
    v3 = n.vurder(3.0)
    assert v3["dagens_maks_kwh"] is None
    assert v3["tak_okonomi_kwh"] == pytest.approx(3 * 4.7 - 5.5 - 4.8)   # 3,8
    assert v3["grense_kwh"] == pytest.approx(3.8)


def test_10_maal_tapt_og_absolutt_grense(frys_tid):
    frys_tid(datetime(2026, 9, 20, 12, 0, tzinfo=OSLO))
    hub = FakeHub(num={"ki_maks_time_kwh": 6.0, "ki_min_time_kwh": 3.0, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    _fyll_dag(n, "2026-09-01", {17: 5.5})
    _fyll_dag(n, "2026-09-02", {17: 5.5})
    _fyll_dag(n, "2026-09-03", {17: 4.8})
    v = n.vurder(4.0)
    assert v["registrert_trinn_kr"] == 420 and v["mal_tapt"] and v["effektivt_mal_kw"] == 10
    # nytt mål: under 10 kW → tak 3·9,7 − 11 = 18,1 → absolutt grense 6,0 gjelder
    assert v["grense_kwh"] == 6.0 and "absolutte" in v["hvorfor"]
    # bryter «tillat dyrere trinn» → bare absolutt grense
    hub._on["ki_tillat_dyrere_trinn"] = True
    hub._num["ki_mal_trinn_kw"] = 2.0
    assert n.vurder(4.0)["grense_kwh"] == 6.0


def test_8b_faerre_enn_tre_dager_reservemodus(frys_tid):
    frys_tid(datetime(2026, 9, 2, 12, 0, tzinfo=OSLO))
    hub = FakeHub(num={"ki_maks_time_kwh": 6.0, "ki_min_time_kwh": 3.0, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    _fyll_dag(n, "2026-09-01", {17: 3.0})
    v = n.vurder(2.0)
    assert v["datakvalitet"] == "usikker" and v["kjente_dager"] == 1
    assert v["placeholder_kwh"] == 6.0                      # ukjente dager = hard grense, ikke null
    assert any("reservemodus" in g for g in v["reserve_grunner"])
    # 3·(5−0,5) − 6,0 − 3,0 = 4,5
    assert v["tak_okonomi_kwh"] == pytest.approx(4.5) and v["grense_kwh"] == pytest.approx(4.5)
    # månedsskifte: forrige måneds dager teller ikke
    frys_tid(datetime(2026, 10, 1, 12, 0, tzinfo=OSLO))
    v = n.vurder(2.0)
    assert v["kjente_dager"] == 0 and v["registrert_snitt"] is None
