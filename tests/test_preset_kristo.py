"""Presetet «Kristo», automatisk bortetemperatur, forvarming søndag og «Bruk ferdig oppsett»."""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi import engine as engine_mod
from custom_components.ki_energi.const import (
    CONF_PERSONER, CONF_PRESET, CONF_SONER, DOMAIN, NUMBERS, PERSON_TIDER, PRESETS, SWITCHES, TIMES,
)
from custom_components.ki_energi.engine import KiEngine

from test_smoke import _setup

OSLO = ZoneInfo("Europe/Oslo")
KRISTO = PRESETS["kristo"]

# Klimaentitetene fra Home Assistant (bilen er utelatt med vilje). Sebastians ovn er ikke lagt til ennå.
KLIMA = {"climate.bad_gulvvarme", "climate.cybele_panelovn", "climate.do_gulvvarme", "climate.kjokken_gulvvarme",
         "climate.kjokken_panelovn", "climate.stue_oljefyr", "climate.stue_panelovn", "climate.trappegang_panelovn"}


# ----------------------------------------------------------------------
#  Presetet
# ----------------------------------------------------------------------
def test_alle_ovnene_er_med_og_bilen_er_utenfor():
    brukt = {c for s in KRISTO["soner"].values() for c in s["climate"]}
    assert KLIMA <= brukt
    assert brukt - KLIMA == {"climate.sebastian_panelovn"}
    assert "climate.bil_klima" not in brukt
    assert KRISTO["soner"]["stue"]["climate"] == ["climate.stue_panelovn", "climate.stue_oljefyr"]
    assert set(KRISTO["soner"]["kjokken"]["climate"]) == {"climate.kjokken_panelovn", "climate.kjokken_gulvvarme"}
    for s in KRISTO["soner"].values():
        assert len(s["climate"]) == len(s["effekt"]), s["navn"]


def test_personene_folger_homey_posisjon():
    p = {x["key"]: x for x in KRISTO["personer"]}
    assert p["cybele"]["type"] == "barn" and p["sebastian"]["type"] == "ungdom" and p["rune"]["type"] == "voksen"
    for k in ("cybele", "sebastian", "rune"):
        assert p[k]["entity"] == f"switch.homey_logic_{k}_posisjon"
    assert KRISTO["soner"]["cybele_soverom"]["profil"] == "person:cybele"
    assert KRISTO["soner"]["sebastian_soverom"]["profil"] == "person:sebastian"


def test_hver_verdi_har_en_hjelper():
    """En verdi uten hjelper ville blitt hoppet over i stillhet når presetet legges inn."""
    statiske = {n[0] for n in NUMBERS} | {s[0] for s in SWITCHES} | {t[0] for t in TIMES}
    sone = {s[f] for s in KRISTO["soner"].values() for f in ("temp_dag", "temp_natt", "temp_borte") if s[f]}
    person = {f"ki_{p['key']}_{t[0]}" for p in KRISTO["personer"] for t in PERSON_TIDER.get(p["type"], [])}
    ukjente = set(KRISTO["verdier"]) - statiske - sone - person
    assert not ukjente, ukjente


def test_programmet():
    v = KRISTO["verdier"]
    for rom in ("stue", "kjokken", "trappegang"):
        assert (v[f"ki_temp_{rom}_dag"], v[f"ki_temp_{rom}_natt"]) == (22.0, 19.0)
    assert (v["ki_tid_dag_start"], v["ki_tid_natt_start"]) == ("06:00", "23:00")
    assert (v["ki_temp_cybele_soverom_dag"], v["ki_temp_cybele_soverom_natt"]) == (22.0, 20.0)
    assert v["ki_helg_spor_torsdag"] is False and v["ki_helg_spor_fredag"] is True
    assert v["ki_hjemkomst_tid"] == "13:00" and v["ki_helg_forvarm_sondag"] is True
    assert v["ki_borte_auto_temp"] is True and v["ki_borte_min_temp"] == 12.0


# ----------------------------------------------------------------------
#  Automatisk bortetemperatur
# ----------------------------------------------------------------------
def _motor(ute, *, laert=True, bunn=12.0, maks=12, dag=22.0):
    verdier = {"ki_borte_min_temp": bunn, "ki_forvarming_maks_timer": maks, "number.dag": dag}
    e = object.__new__(KiEngine)
    e.hub = SimpleNamespace(ute=lambda: ute, num=lambda k, d=0.0: verdier.get(k, d))
    e._tau = lambda key: (0.05, 1.2, 20)                 # τ = 20 t
    e._rate_max = lambda key: 2.0 if laert else None     # ovnen gir 2 °C/t
    return e, {"temp_dag": "number.dag"}


def test_bortetemperaturen_er_den_laveste_rommet_rekker():
    # −5 ute: fra T til 22 tar ln((2 − 0,05(T+5)) / 0,65) / 0,05 t; grensen er 12 t / 1,3 = 9,2 t → T ≥ 14,4
    e, konf = _motor(-5)
    t, grunn = e.bortetemp("stue", konf)
    assert t == 14.5 and "automatisk" in grunn
    behov, _ = e.forvarming_minutter("stue", t, 22.0, -5)
    assert behov <= 12 * 60 / KiEngine.BORTE_MARGIN
    behov_lavere, _ = e.forvarming_minutter("stue", t - 0.5, 22.0, -5)
    assert behov_lavere > 12 * 60 / KiEngine.BORTE_MARGIN


def test_mildt_vaer_gir_bunnen_og_kaldt_vaer_hoyere():
    mild, _ = _motor(5)[0].bortetemp("stue", _motor(5)[1])
    kald, _ = _motor(-15)[0].bortetemp("stue", _motor(-15)[1])
    assert mild == 12.0
    assert kald > 14.5


def test_ulaert_rom_bruker_fast_bortetemperatur():
    e, konf = _motor(-5, laert=False)
    t, grunn = e.bortetemp("stue", konf)
    assert t is None and "ikke lært" in grunn


# ----------------------------------------------------------------------
#  Forvarming søndag
# ----------------------------------------------------------------------
def _sondag(monkeypatch, tid: datetime, **brytere):
    verdier = {"ki_helg_forvarm_sondag": True, "ki_helgemodus": True, "ki_hjemkomst_aktiv": False, **brytere}
    monkeypatch.setattr(engine_mod.dt_util, "now", lambda *a, **k: tid)
    e = object.__new__(KiEngine)
    e.hub = SimpleNamespace(
        on=lambda k, d=False: verdier.get(k, d), fritidsbolig=lambda: False,
        moduser=SimpleNamespace(m={}), tid_min=lambda k, d: int(d[:2]) * 60 + int(d[3:]),
        naa_min=lambda: tid.hour * 60 + tid.minute,
    )
    return e


def test_sondag_morgen_gir_frist_kl_13(monkeypatch):
    e = _sondag(monkeypatch, datetime(2026, 11, 22, 6, 0, tzinfo=OSLO))
    assert e.sondag_hjemkomst() == (13 * 60, False)


def test_sondag_etter_kl_13_holder_dagtemperatur(monkeypatch):
    e = _sondag(monkeypatch, datetime(2026, 11, 22, 14, 0, tzinfo=OSLO))
    assert e.sondag_hjemkomst() == (13 * 60, True)


def test_ikke_lordag_ikke_av_ikke_forlenget(monkeypatch):
    assert _sondag(monkeypatch, datetime(2026, 11, 21, 6, 0, tzinfo=OSLO)).sondag_hjemkomst() is None
    assert _sondag(monkeypatch, datetime(2026, 11, 22, 6, 0, tzinfo=OSLO),
                   ki_helg_forvarm_sondag=False).sondag_hjemkomst() is None
    e = _sondag(monkeypatch, datetime(2026, 11, 22, 6, 0, tzinfo=OSLO))
    e.hub.moduser.m["forlenget_dag"] = "2026-11-22"
    assert e.sondag_hjemkomst() is None


# ----------------------------------------------------------------------
#  «Bruk ferdig oppsett» på en installasjon som alt kjører
# ----------------------------------------------------------------------
async def test_bruk_ferdig_oppsett_fra_alternativene(hass):
    entry = await _setup(hass)
    for s in KRISTO["soner"].values():
        for c in s["climate"]:
            if c != "climate.sebastian_panelovn":
                hass.states.async_set(c, "heat", {"temperature": 21, "current_temperature": 20.5,
                                                  "hvac_modes": ["off", "heat"], "min_temp": 5, "max_temp": 30})
    hub = hass.data[DOMAIN][entry.entry_id]
    hub.minne.setdefault("tau", {})["stue"] = {"k": 0.07, "varme_rate": 1.4, "n": 33}   # lært før byttet

    r = await hass.config_entries.options.async_init(entry.entry_id)
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": "oppsett"})
    assert r["type"] == "form" and r["step_id"] == "oppsett"
    r = await hass.config_entries.options.async_configure(r["flow_id"], {CONF_PRESET: "kristo", "verdier": True})
    assert r["type"] == "create_entry", r
    await hass.async_block_till_done()

    assert entry.options[CONF_PRESET] == "kristo"
    assert set(entry.options[CONF_SONER]) == set(KRISTO["soner"])
    assert [p["key"] for p in entry.options[CONF_PERSONER]] == ["cybele", "sebastian", "rune"]
    assert hass.states.get("switch.ki_styr_sebastian_soverom") is not None
    assert hass.states.get("number.ki_temp_cybele_soverom_natt") is not None

    hub = hass.data[DOMAIN][entry.entry_id]           # integrasjonen er lastet på nytt
    assert hub.minne["tau"]["stue"]["n"] == 33, "læringen skal ikke kastes"
    await hub.engine.tick()
    await hass.async_block_till_done()
    assert hub.num("ki_temp_trappegang_dag") == 22.0
    assert hub.num("ki_temp_cybele_soverom_natt") == 20.0
    assert hub.on("ki_borte_auto_temp") and hub.on("ki_helg_forvarm_sondag")
    assert hub.tid_str("ki_tid_dag_start") == "06:00"
    # verdiene legges ikke inn på nytt ved neste tick — brukerens endringer får stå
    hub.sett("ki_temp_trappegang_dag", 20.5)
    await hub.engine.tick()
    assert hub.num("ki_temp_trappegang_dag") == 20.5


async def test_helg_med_kristo_gir_automatisk_bortetemperatur_og_sondagsforvarming(hass):
    from unittest.mock import patch
    entry = await _setup(hass)
    r = await hass.config_entries.options.async_init(entry.entry_id)
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": "oppsett"})
    await hass.config_entries.options.async_configure(r["flow_id"], {CONF_PRESET: "kristo", "verdier": True})
    await hass.async_block_till_done()
    hub = hass.data[DOMAIN][entry.entry_id]
    await hub.engine.tick()
    hass.states.async_set("sensor.outdoor_meter_temperatur", "-5")
    hub.minne.setdefault("tau", {})["stue"] = {"k": 0.05, "varme_rate": 1.4, "n": 33, "rate_max": 2.0}
    hub.sett("ki_helgemodus", True)
    stue = hub.soner()["stue"]

    lordag = datetime(2026, 11, 21, 15, 0, tzinfo=OSLO)
    with patch("homeassistant.util.dt.now", return_value=lordag):
        mal, grunn, frist = hub.engine.mal_temperatur("stue", stue)
    assert mal == 14.5 and "automatisk" in grunn and frist is None

    # Søndag kl. 06: fortsatt bortetemperatur, men med frist kl. 13 så forvarmingen kan starte
    with patch("homeassistant.util.dt.now", return_value=datetime(2026, 11, 22, 6, 0, tzinfo=OSLO)):
        mal, grunn, frist = hub.engine.mal_temperatur("stue", stue)
    assert mal == 14.5 and frist == 13 * 60, grunn

    # Søndag kl. 14, ingen hjemme ennå: dagtemperatur, ikke bortetemperatur
    with patch("homeassistant.util.dt.now", return_value=datetime(2026, 11, 22, 14, 0, tzinfo=OSLO)):
        mal, grunn, frist = hub.engine.mal_temperatur("stue", stue)
    assert mal == 22.0 and "holder dagtemperatur" in grunn
