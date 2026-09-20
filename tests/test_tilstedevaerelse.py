"""Tilstedeværelse i klartekst: hjemme, kort tur, eller borte siden helgen."""
from datetime import timedelta
from types import SimpleNamespace

from homeassistant.util import dt as dt_util

from custom_components.ki_energi.modes import KiModuser as Modes


def _m(borte, *, minutter=None, helg=False, hjemkomst=False, venter=False, grense=6,
       planlagt=None):
    m = object.__new__(Modes)
    satt = {}
    verdier = {"ki_helgemodus": helg, "ki_hjemkomst_aktiv": hjemkomst,
               "ki_helg_venter_svar": venter}
    m.hub = SimpleNamespace(
        on=lambda n, std=False: bool(verdier.get(n, std)),
        num=lambda n, std=0: grense if n == "ki_helg_auto_timer" else std,
        tekst=lambda n, std="": "17:00",
        dt=lambda n: planlagt,
        sett_sensor=lambda n, v, a=None: satt.update({n: (v, a or {})}),
    )
    m.m = {}
    if minutter is not None:
        m.m["borte_siden"] = (dt_util.now() - timedelta(minutes=minutter)).isoformat()
    Modes._sett_tilstedevaerelse(m, borte)
    return satt["ki_tilstedevaerelse"]


def test_noen_hjemme():
    t, a = _m(False)
    assert t == "hjemme" and a["tekst"] == "Noen er hjemme"


def test_hjemkomst_pagar():
    t, a = _m(False, hjemkomst=True)
    assert t == "hjemkomst" and "varmer opp" in a["tekst"]


def test_kort_tur_pa_butikken():
    """40 minutter ute med seks timers grense er en tur, ikke bortreist."""
    t, a = _m(True, minutter=40)
    assert t == "kort_tur"
    assert "Ute en tur, 40 min" in a["tekst"]
    assert "5 t 20 min" in a["tekst"], a["tekst"]


def test_kort_tur_snart_over():
    t, a = _m(True, minutter=330, grense=6)
    assert t == "kort_tur" and "om 30 min" in a["tekst"], a["tekst"]


def test_borte_lenger_enn_grensen_men_ikke_bortemodus():
    """Over grensen uten at bortemodus er slått på ennå — neste tikk ordner det."""
    t, a = _m(True, minutter=400, grense=6)
    assert t == "borte" and a["tekst"] == "Alle er borte"


def test_borte_siden_helgen():
    """Dette er skillet han ba om: borte med bortemodus på, i døgn."""
    t, a = _m(True, minutter=60 * 24 * 3 + 10, helg=True)
    assert t == "borte_lenge"
    assert "3 døgn" in a["tekst"] and "bortemodus" in a["tekst"], a["tekst"]


def test_bortemodus_uten_kjent_starttid():
    t, a = _m(True, helg=True)
    assert t == "borte_lenge" and "bortemodus" in a["tekst"]
    assert a["minutter_borte"] is None


def test_ukjent_tilstedevaerelse():
    t, a = _m(None)
    assert t == "ukjent" and a["borte_siden"] is None


def test_attributtene_er_med():
    t, a = _m(True, minutter=40, venter=True, grense=8)
    for n in ("tekst", "borte_siden", "minutter_borte", "bortemodus",
              "hjemkomst_aktiv", "venter_svar", "auto_etter_timer", "hjemkomst_tid"):
        assert n in a, n
    assert a["auto_etter_timer"] == 8 and a["venter_svar"] is True


def test_hjemkomst_planlagt_folger_med():
    """Kortene teller ned mot tidspunktet, ikke mot klokkeslettet i innstillingen.

    Søndag 13.00, svar «ja» da innstilt tid alt var passert: planen er om 30 minutter.
    Uten datoen måtte kortet gjette, og la på et døgn — «om 23 t 45 min».
    """
    plan = dt_util.now() + timedelta(minutes=30)
    t, a = _m(True, minutter=120, helg=True, hjemkomst=True, planlagt=plan)
    assert a["hjemkomst_planlagt"] == plan.isoformat()
    assert a["hjemkomst_tid"] == "17:00"


def test_hjemkomst_planlagt_er_none_uten_hjemkomst():
    """Ingen planlagt hjemkomst: feltet skal være tomt, ikke et gammelt tidspunkt."""
    t, a = _m(True, minutter=120, helg=True)
    assert a["hjemkomst_planlagt"] is None
