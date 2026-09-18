"""Tester for billading: trinnvalg, sperrer og hva bilen faktisk tar imot.

De rene funksjonene testes uten Home Assistant. `KiLading.vurder()` testes mot en liten
falsk hub, med tid frosset via dt_util — samme mønster som nettleietestene.
"""
from __future__ import annotations

import types
from datetime import datetime, timedelta, timezone

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi.lading import (
    TRINN,
    KiLading,
    trinn_kw,
    velg_trinn,
)

NAA = datetime(2026, 9, 18, 20, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------- rene funksjoner
def test_trinn_kw():
    """230 V enfase. Tallene er anslag, men de må være stabile."""
    assert trinn_kw(5) == 1.15
    assert trinn_kw(10) == 2.3
    assert trinn_kw(16) == 3.68
    assert trinn_kw(18) == 4.14


def test_velg_trinn_tar_hoyeste_som_passer():
    assert velg_trinn(0.0) is None
    assert velg_trinn(1.0) is None          # under laveste trinn
    assert velg_trinn(1.15) == 5            # nøyaktig laveste går
    assert velg_trinn(2.29) == 5
    assert velg_trinn(2.3) == 10
    assert velg_trinn(3.67) == 10
    assert velg_trinn(3.68) == 16
    assert velg_trinn(4.13) == 16
    assert velg_trinn(4.14) == 18
    assert velg_trinn(50.0) == 18           # aldri over høyeste knapp


def test_velg_trinn_med_gulv():
    """Et gulv skal hindre laveste trinn, ikke bare foretrekke et høyere."""
    assert velg_trinn(1.2, minste=10) is None
    assert velg_trinn(2.3, minste=10) == 10


# ------------------------------------------------------------------- falsk hub
class FalskSt:
    def __init__(self, state, attrs=None):
        self.state = str(state)
        self.attributes = attrs or {}


class FalskStates:
    def __init__(self, d):
        self._d = d

    def get(self, eid):
        return self._d.get(eid)


class FalskHub:
    def __init__(self, bryter="off", effekt=None, effekt_enhet="kW",
                 auto=True, mellom=5, dodband=0.6, knapper=None):
        self.minne = {}
        states = {"switch.lader": FalskSt(bryter)}
        if effekt is not None:
            attrs = {}
            if effekt_enhet is not None:
                attrs["unit_of_measurement"] = effekt_enhet
            states["sensor.ladeeffekt"] = FalskSt(effekt, attrs)
        self.hass = types.SimpleNamespace(states=FalskStates(states))
        self._auto = auto
        self._mellom = mellom
        self._dodband = dodband
        self._knapper = knapper if knapper is not None else {
            "5": "button.a5", "10": "button.a10",
            "16": "button.a16", "18": "button.a18"}

    def cfg(self, key):
        return {
            "lader_bryter": "switch.lader",
            "lader_effekt": "sensor.ladeeffekt",
            "ladestrom_knapper": self._knapper,
        }.get(key)

    def on(self, key, standard=True):
        return self._auto if key == "ki_lading_automatikk" else standard

    def num(self, key, standard=0):
        return {"ki_lading_min_mellom_min": self._mellom,
                "ki_lading_dodband_kw": self._dodband}.get(key, standard)

    def sett_sensor(self, *a, **k):
        pass


@pytest.fixture
def frys(monkeypatch):
    monkeypatch.setattr(dt_util, "utcnow", lambda: NAA)
    return NAA


def lag(**kw):
    hub = FalskHub(**kw)
    return KiLading(hub), hub


# ------------------------------------------------------------------- oppsettet
def test_knapper_fra_liste_leser_ampere_fra_id():
    """Skjemaet gir en liste; trinnet må leses ut av entitets-ID-en."""
    lading, _ = lag(knapper=[
        "button.tesla_ladestrom_5a_button",
        "button.tesla_ladestrom_10a_button",
        "button.tesla_ladestrom_16a_button",
        "button.tesla_ladestrom_18a_button",
    ])
    assert lading._knapper() == {
        5: "button.tesla_ladestrom_5a_button",
        10: "button.tesla_ladestrom_10a_button",
        16: "button.tesla_ladestrom_16a_button",
        18: "button.tesla_ladestrom_18a_button",
    }


def test_knapper_hopper_over_ukjente():
    """En knapp på feil trinn er verre enn en manglende knapp."""
    lading, _ = lag(knapper=[
        "button.tesla_ladestrom_16a_button",
        "button.tesla_ladestrom_32a_button",   # ikke et kjent trinn
        "button.tesla_lade_maks",              # ingen ampere i navnet
    ])
    assert lading._knapper() == {16: "button.tesla_ladestrom_16a_button"}


def test_ikke_konfigurert_uten_knapper():
    lading, _ = lag(knapper={})
    assert not lading.konfigurert()
    assert lading.vurder(5.0)["handling"] == "ingen"


@pytest.mark.parametrize("verdi,enhet,ventet", [
    (2300, "W", 2.3),
    (2.3, "kW", 2.3),
    (2300, "w", 2.3),
    (2.3, "KW", 2.3),
    # Uten enhet — typisk for tall fra broer som Homey Link. Størrelsen avgjør:
    # en bil lader aldri på 2300 kW, men godt på 2300 W.
    (2300, None, 2.3),
    (1.0, None, 1.0),
    (0.0, None, 0.0),
])
def test_effekt_leses_med_og_uten_enhet(verdi, enhet, ventet):
    lading, _ = lag(effekt=verdi, effekt_enhet=enhet)
    assert lading.effekt_kw() == ventet


# -------------------------------------------------------------- fra stillstand
@pytest.mark.parametrize("ledig,ventet,trinn", [
    (0.5, "av", None),
    (1.0, "av", None),
    (1.2, "start", 5),
    (2.5, "start", 10),
    (4.0, "start", 16),
    (6.0, "start", 18),
])
def test_starter_pa_hoyeste_trinn_som_passer(frys, ledig, ventet, trinn):
    lading, _ = lag(bryter="off")
    v = lading.vurder(ledig)
    assert v["handling"] == ventet
    assert v["trinn"] == trinn


# ------------------------------------------------------------- mens den lader
def test_gar_opp_nar_det_blir_plass(frys):
    lading, _ = lag(bryter="on", effekt=2.3)
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(4.5)
    assert v["handling"] == "endre"
    assert v["trinn"] == 18


def test_stopper_nar_plassen_forsvinner(frys):
    lading, _ = lag(bryter="on", effekt=2.3)
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(0.8)
    assert v["handling"] == "stopp"
    assert v["trinn"] is None


def test_holder_samme_trinn(frys):
    lading, _ = lag(bryter="on", effekt=2.3)
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=20)
    assert lading.vurder(2.4)["handling"] == "hold"


# ------------------------------------------------------------------- sperrene
def test_minsteavstand_hindrer_hyppige_endringer(frys):
    """Hver endring gir bilen et avbrudd, så vi haster ikke."""
    lading, _ = lag(bryter="on", effekt=2.3, mellom=5)
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=2)
    v = lading.vurder(4.5)
    assert v["handling"] == "hold"
    assert "venter" in v["forklaring"]


def test_minsteavstand_slipper_etterpa(frys):
    lading, _ = lag(bryter="on", effekt=2.3, mellom=5)
    lading.satt_trinn = 10
    lading.sist_endret = NAA - timedelta(minutes=6)
    assert lading.vurder(4.5)["handling"] == "endre"


def test_dodband_hindrer_vingling(frys):
    """16 → 18 A er bare 0,46 kW. Ikke verdt et avbrudd."""
    lading, _ = lag(bryter="on", effekt=3.68, dodband=0.6)
    lading.satt_trinn = 16
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(4.2)
    assert v["handling"] == "hold"
    assert v["trinn"] == 16


def test_dodband_slipper_store_sprang(frys):
    lading, _ = lag(bryter="on", effekt=1.15, dodband=0.6)
    lading.satt_trinn = 5
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(4.0)
    assert v["handling"] == "endre"
    assert v["trinn"] == 16


# ------------------------------------------ bilen tar mindre enn den får lov til
def test_ubrukt_effekt_frigjores(frys):
    """Satt til 16 A, men bilen tar 1,1 kW — nesten full. Resten er ikke vår.

    Uten dette ville 2,58 kW stått reservert til en bil som ikke bruker dem, mens
    ovnene ble senket.
    """
    lading, _ = lag(bryter="on", effekt=1.1)
    lading.satt_trinn = 16
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(0.2)
    # 0,2 ledig + (3,68 − 1,1) frigjort = 2,78 → 10 A passer
    assert v["handling"] == "endre"
    assert v["trinn"] == 10


def test_liten_differanse_frigjores_ikke(frys):
    """Under en halv kilowatt er innenfor måleusikkerhet — ikke rør det."""
    lading, _ = lag(bryter="on", effekt=3.4)
    lading.satt_trinn = 16
    lading.sist_endret = NAA - timedelta(minutes=20)
    v = lading.vurder(0.1)
    assert v["handling"] == "stopp"


# ----------------------------------------------------------------- av og borte
def test_automatikk_av_rorer_ingenting(frys):
    lading, _ = lag(bryter="on", effekt=2.3, auto=False)
    v = lading.vurder(5.0)
    assert v["handling"] == "manuell"
    assert v["trinn"] is None


def test_lader_som_ikke_svarer(frys):
    lading, _ = lag(bryter="unavailable")
    assert lading.vurder(5.0)["handling"] == "utilgjengelig"


def test_alle_trinn_er_stigende():
    """Rekkefølgen betyr noe for velg_trinn — en usortert TRINN ville gitt feil svar."""
    assert list(TRINN) == sorted(TRINN)
