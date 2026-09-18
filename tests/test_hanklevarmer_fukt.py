"""Tester for fuktstyringen av håndklevarmeren.

`fukt_vindu()` er skilt ut som egen metode nettopp for å kunne testes uten Home
Assistant. Den testes mot en liten falsk hub, med tid styrt eksplisitt.
"""
from __future__ import annotations

import types
from datetime import datetime, timedelta, timezone

import pytest

from custom_components.ki_energi.modes import KiModuser

NAA = datetime(2026, 9, 18, 21, 0, tzinfo=timezone.utc)


class FalskSt:
    def __init__(self, state):
        self.state = str(state)
        self.attributes = {}


class FalskHub:
    def __init__(self, fukt=None, pa=True, grense=70, minutter=3, timer=2,
                 sensor="sensor.bad_fukt"):
        self._fukt = fukt
        self._pa = pa
        self._grense = grense
        self._minutter = minutter
        self._timer = timer
        self._sensor = sensor
        self.minne = {}

    def cfg(self, key, standard=None):
        return self._sensor if key == "bad_fukt" else standard

    def finnes(self, eid):
        return bool(eid) and self._fukt is not None

    def st(self, eid):
        return str(self._fukt) if self._fukt is not None else "unknown"

    def on(self, key, standard=True):
        return self._pa if key == "ki_hanklevarmer_fukt" else standard

    def num(self, key, standard=0):
        return {"ki_hanklevarmer_fukt_grense": self._grense,
                "ki_hanklevarmer_fukt_minutter": self._minutter,
                "ki_hanklevarmer_fukt_timer": self._timer}.get(key, standard)


def lag(**kw):
    """Bygger en KiModuser uten å kjøre konstruktøren, som krever hele HA."""
    modes = object.__new__(KiModuser)
    hub = FalskHub(**kw)
    modes.hub = hub
    modes.m = hub.minne
    return modes, hub


# ------------------------------------------------------------------ av og uten
def test_uten_fuktsensor_gjor_ingenting():
    modes, _ = lag(sensor="", fukt=None)
    assert modes.fukt_vindu(NAA) == (False, "")


def test_avslatt_gjor_ingenting():
    modes, _ = lag(fukt=90, pa=False)
    aktiv, _ = modes.fukt_vindu(NAA)
    assert aktiv is False


def test_sensor_uten_tall_gjor_ingenting():
    modes, hub = lag(fukt="unknown")
    hub._fukt = "tørr"
    assert modes.fukt_vindu(NAA) == (False, "")


# --------------------------------------------------------------- selve terskelen
def test_under_grensen_starter_ikke_klokka():
    modes, _ = lag(fukt=60)
    assert modes.fukt_vindu(NAA)[0] is False
    assert "fukt_over_siden" not in modes.m


def test_forste_maling_over_grensen_venter():
    """Et enkelt øyeblikksmål skal ikke slå på varmeren."""
    modes, _ = lag(fukt=85)
    assert modes.fukt_vindu(NAA)[0] is False
    assert "fukt_over_siden" in modes.m


def test_for_kort_tid_venter():
    modes, _ = lag(fukt=85, minutter=3)
    modes.fukt_vindu(NAA)
    assert modes.fukt_vindu(NAA + timedelta(minutes=2))[0] is False


def test_tre_minutter_over_grensen_apner_vinduet():
    modes, _ = lag(fukt=85, minutter=3, timer=2)
    modes.fukt_vindu(NAA)
    aktiv, tekst = modes.fukt_vindu(NAA + timedelta(minutes=3))
    assert aktiv is True
    assert "70 %" in tekst and "3 min" in tekst and "2 t" in tekst
    assert "fukt_til" in modes.m


def test_fall_under_grensen_nullstiller_klokka():
    """Halvveis oppfylt to ganger er ikke det samme som oppfylt én gang."""
    modes, hub = lag(fukt=85, minutter=3)
    modes.fukt_vindu(NAA)                                   # klokka starter
    hub._fukt = 60
    modes.fukt_vindu(NAA + timedelta(minutes=2))            # faller under
    assert "fukt_over_siden" not in modes.m
    hub._fukt = 85
    modes.fukt_vindu(NAA + timedelta(minutes=2, seconds=30))  # starter på nytt
    assert modes.fukt_vindu(NAA + timedelta(minutes=4))[0] is False


# -------------------------------------------------------------- vinduet står
def test_vinduet_star_selv_om_fukten_faller():
    """Håndklærne er like våte om fukten i rommet har lagt seg."""
    modes, hub = lag(fukt=85, minutter=3, timer=2)
    modes.fukt_vindu(NAA)
    assert modes.fukt_vindu(NAA + timedelta(minutes=3))[0] is True
    hub._fukt = 45
    aktiv, tekst = modes.fukt_vindu(NAA + timedelta(minutes=30))
    assert aktiv is True
    assert "min igjen" in tekst


def test_vinduet_lukkes_nar_tiden_er_ute():
    modes, hub = lag(fukt=85, minutter=3, timer=2)
    modes.fukt_vindu(NAA)
    modes.fukt_vindu(NAA + timedelta(minutes=3))
    hub._fukt = 45
    assert modes.fukt_vindu(NAA + timedelta(hours=2, minutes=4))[0] is False
    assert "fukt_til" not in modes.m


def test_ny_dusj_apner_nytt_vindu():
    modes, hub = lag(fukt=85, minutter=3, timer=2)
    modes.fukt_vindu(NAA)
    modes.fukt_vindu(NAA + timedelta(minutes=3))
    hub._fukt = 45
    senere = NAA + timedelta(hours=2, minutes=4)
    modes.fukt_vindu(senere)                       # vinduet lukkes
    hub._fukt = 85
    modes.fukt_vindu(senere + timedelta(minutes=1))
    assert modes.fukt_vindu(senere + timedelta(minutes=4))[0] is True


# --------------------------------------------------------------- innstillinger
@pytest.mark.parametrize("grense,fukt,ventet", [
    (70, 69, False),
    (70, 70, True),
    (85, 80, False),
    (85, 90, True),
])
def test_grensen_respekteres(grense, fukt, ventet):
    modes, _ = lag(fukt=fukt, grense=grense, minutter=1)
    modes.fukt_vindu(NAA)
    assert modes.fukt_vindu(NAA + timedelta(minutes=1))[0] is ventet


@pytest.mark.parametrize("timer,minutter_etter,ventet", [
    (2, 119, True),
    (2, 121, False),
    (0.5, 29, True),
    (0.5, 31, False),
    (8, 400, True),
])
def test_varigheten_respekteres(timer, minutter_etter, ventet):
    modes, hub = lag(fukt=85, minutter=1, timer=timer)
    modes.fukt_vindu(NAA)
    apnet = NAA + timedelta(minutes=1)
    assert modes.fukt_vindu(apnet)[0] is True
    hub._fukt = 40
    assert modes.fukt_vindu(apnet + timedelta(minutes=minutter_etter))[0] is ventet
