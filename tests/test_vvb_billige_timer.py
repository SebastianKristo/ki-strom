"""Bereder: valg av billige timer når prisdataene er ufullstendige.

- Et kvarter uten pris (`value: None`) ble 0 kr og dermed valgt som billigst.
- Kom ikke morgendagens priser, var lista likevel ikke tom (kveldens timer var kjent), så
  vinduet gjaldt ikke: berederen fikk bare 22 og 23, og natta etter midnatt sto uten.
- Natta med to 02:00 ble én time, fordi lokale datetimer er like uansett `fold`.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi import vvb as vvb_mod
from custom_components.ki_energi.const import CONF_NORDPOOL
from custom_components.ki_energi.vvb import KiVvb
from test_vvb_midt_i_syklus import Hub

OSLO = ZoneInfo("Europe/Oslo")


class PrisHub(Hub):
    def __init__(self, klokke):
        super().__init__(klokke)
        self.lagret["ki_vvb_folg_spotpris"] = True
        self.raw = {"raw_today": [], "raw_tomorrow": []}

    def cfg(self, n, std=None):
        return "sensor.nordpool" if n == CONF_NORDPOOL else super().cfg(n, std)

    def attr(self, e, n, std=None):
        return self.raw.get(n, std) if e == "sensor.nordpool" else std


def kvarter(dag: datetime, timepriser: list) -> list[dict]:
    """24 timepriser → 96 kvartersoppføringer slik Nord Pool leverer dem."""
    start = datetime(dag.year, dag.month, dag.day, tzinfo=OSLO)
    ut = []
    t = start
    while t.date() == start.date():
        ut.append({"start": t.isoformat(), "value": timepriser[t.hour]})
        t = (t.astimezone(dt_util.UTC) + timedelta(minutes=15)).astimezone(OSLO)
    return ut


@pytest.fixture
def oppsett(monkeypatch):
    gammel = dt_util.get_default_time_zone()
    dt_util.set_default_time_zone(OSLO)
    klokke = [datetime(2026, 10, 20, 13, 0, tzinfo=OSLO)]
    monkeypatch.setattr(vvb_mod.dt_util, "now", lambda: klokke[0])
    h = PrisHub(klokke)
    yield KiVvb(h), h, klokke
    dt_util.set_default_time_zone(gammel)


def test_manglende_pris_regnes_ikke_som_gratis(oppsett):
    v, h, klokke = oppsett
    idag = [1.0] * 24
    idag[18] = None
    h.raw["raw_today"] = kvarter(klokke[0], idag)
    h.raw["raw_tomorrow"] = kvarter(klokke[0] + timedelta(days=1), [0.6, 0.5, 0.3, 0.2, 0.25] + [1.0] * 19)
    h.lagret["vvb_billigste_timer_dogn"] = 3
    v._beregn_billige_timer()
    assert v.billige_timer == [2, 3, 4]


def test_uten_morgendagens_priser_gjelder_vinduet_etter_midnatt(oppsett):
    v, h, klokke = oppsett
    idag = [1.0] * 24
    idag[22] = 0.5
    h.raw["raw_today"] = kvarter(klokke[0], idag)      # raw_tomorrow kommer aldri
    h.lagret["vvb_billigste_timer_dogn"] = 1
    klokke[0] = datetime(2026, 10, 20, 22, 0, tzinfo=OSLO)
    v._beregn_billige_timer()
    assert v.billige_timer == [22]
    klokke[0] = datetime(2026, 10, 20, 23, 0, tzinfo=OSLO)
    assert not v.billig_time_na(), "kjent pris som ikke er valgt skal ikke slå på"
    klokke[0] = datetime(2026, 10, 21, 1, 0, tzinfo=OSLO)
    assert v.billig_time_na(), "timer uten pris inne i vinduet skal følge vinduet"
    klokke[0] = datetime(2026, 10, 21, 7, 0, tzinfo=OSLO)
    assert not v.billig_time_na(), "utenfor vinduet uten pris: ikke på"


def test_natta_med_to_klokka_to_gir_to_timer(oppsett):
    v, h, klokke = oppsett
    klokke[0] = datetime(2026, 10, 24, 22, 0, tzinfo=OSLO)
    h.raw["raw_today"] = kvarter(klokke[0], [1.0] * 24)
    # 25. oktober har 25 timer; timepris per lokal time, 02 gjentas.
    h.raw["raw_tomorrow"] = kvarter(klokke[0] + timedelta(days=1), [0.9, 0.8, 0.1] + [1.0] * 21)
    h.lagret["vvb_billigste_timer_dogn"] = 2
    v._beregn_billige_timer()
    assert v.billige_timer == [2, 2]
    priser = KiVvb._timepriser(h.raw["raw_tomorrow"])
    assert len(priser) == 25


def test_doegnet_viser_lokale_timer_og_kjente_priser(oppsett):
    v, h, klokke = oppsett
    h.raw["raw_today"] = kvarter(klokke[0], [1.0] * 24)
    v._beregn_billige_timer()
    d = v._doegn(klokke[0])
    assert [x["t"] for x in d[:3]] == [13, 14, 15]
    assert d[0]["pris"] == pytest.approx(1.0)
    assert d[11]["t"] == 0 and d[11]["pris"] is None
    assert d[11]["valgt"], "ukjent pris inne i vinduet vises som valgt (vinduet gjelder)"
