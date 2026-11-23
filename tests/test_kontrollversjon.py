"""Kontrollversjonen: Home Assistant viser og styrer KI Energi-appen på Homey.

Svarene i tests/fixtures/homey_svar.json er skrevet av Homey-appens egen test
(`KI_SKRIV_FIXTUR=1 node --test test/app.test.js` i homey/), så entitetene her prøves mot
det appen faktisk sender.
"""
from __future__ import annotations

import copy
import json
from datetime import time as dtime
from pathlib import Path

import pytest
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ki_energi.const import (
    CONF_HOMEY_HOST, CONF_HOMEY_INTERVALL, CONF_HOMEY_TOKEN, CONF_MODUS, DOMAIN, MODUS_HOMEY, TJENESTER,
)
from custom_components.ki_energi.fjern.klient import grunnadresse
from custom_components.ki_energi.fjern.koordinator import KILDER

pytestmark = pytest.mark.asyncio

ROT = "http://192.168.1.20/api/app/no.kristo.kienergi"
SVAR = json.loads((Path(__file__).parent / "fixtures" / "homey_svar.json").read_text())


def _homey(aioclient_mock, svar=None, status=200):
    """Et Homey som svarer med fiksturen og tar imot alle endringer."""
    svar = svar or copy.deepcopy(SVAR)
    aioclient_mock.clear_requests()
    for nokkel, sti in KILDER.items():
        aioclient_mock.get(ROT + sti, json=svar[nokkel], status=status)
    for sti in ("/innstillinger", "/motorinnstillinger", "/husinnstillinger"):
        aioclient_mock.put(ROT + sti, json={})
    for sti in ("/overstyr", "/fjernoverstyring", "/bortemodus", "/hjemkomst", "/forleng", "/bereder"):
        aioclient_mock.post(ROT + sti, json={"ok": True})
    return svar


def _endringer(aioclient_mock):
    """(metode, sti, kropp) for alt som ikke er lesing."""
    return [(m, str(url).replace(ROT, ""), kropp) for m, url, kropp, _h in aioclient_mock.mock_calls if m != "GET"]


async def _sett_opp(hass, aioclient_mock, svar=None):
    _homey(aioclient_mock, svar)
    entry = MockConfigEntry(domain=DOMAIN, title="KI Energi (Homey)",
                            data={CONF_MODUS: MODUS_HOMEY, CONF_HOMEY_HOST: "192.168.1.20", CONF_HOMEY_TOKEN: "hemmelig"})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def _id(hass, plattform, nokkel):
    eid = er.async_get(hass).async_get_entity_id(plattform, DOMAIN, f"ki_homey_{nokkel}")
    assert eid, f"fant ikke {plattform} ki_homey_{nokkel}"
    return eid


def _tilstand(hass, plattform, nokkel):
    return hass.states.get(_id(hass, plattform, nokkel))


# ----------------------------------------------------------------------
#  Oppsett
# ----------------------------------------------------------------------
async def test_adresser_ryddes():
    assert grunnadresse("192.168.1.20") == "http://192.168.1.20"
    assert grunnadresse(" homey.local/ ") == "http://homey.local"
    assert grunnadresse("https://abc.connect.athom.com/") == "https://abc.connect.athom.com"


async def test_oppsett_velger_homey_og_proever_tilkoblingen(hass, aioclient_mock):
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert r["type"] == "menu" and r["menu_options"] == ["lokal", "homey"]
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"next_step_id": "homey"})
    assert r["type"] == "form" and r["step_id"] == "homey"

    aioclient_mock.get(ROT + "/status", status=401)
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOMEY_HOST: "192.168.1.20", CONF_HOMEY_TOKEN: "feil"})
    assert r["errors"] == {"base": "homey_avvist"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(ROT + "/status", status=404)
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOMEY_HOST: "192.168.1.20", CONF_HOMEY_TOKEN: "x"})
    assert r["errors"] == {"base": "homey_mangler_app"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(ROT + "/status", exc=TimeoutError())
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOMEY_HOST: "192.168.1.20", CONF_HOMEY_TOKEN: "x"})
    assert r["errors"] == {"base": "homey_ingen_kontakt"}

    _homey(aioclient_mock)
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_HOMEY_HOST: " 192.168.1.20/ ", CONF_HOMEY_TOKEN: " hemmelig "})
    assert r["type"] == "create_entry" and r["title"] == "KI Energi (Homey)"
    assert r["data"] == {CONF_MODUS: MODUS_HOMEY, CONF_HOMEY_HOST: "192.168.1.20/", CONF_HOMEY_TOKEN: "hemmelig"}
    await hass.async_block_till_done()
    # API-nøkkelen sendes som Bearer
    assert aioclient_mock.mock_calls[-1][3]["Authorization"] == "Bearer hemmelig"


# ----------------------------------------------------------------------
#  Entitetene
# ----------------------------------------------------------------------
async def test_entitetene_viser_det_homey_sender(hass, aioclient_mock):
    await _sett_opp(hass, aioclient_mock)
    assert _tilstand(hass, "sensor", "tariff").state == SVAR["status"]["nettleie"]["tariff"]
    assert float(_tilstand(hass, "sensor", "kapasitetsledd").state) == SVAR["status"]["nettleie"]["kapasitetsledd"]
    assert float(_tilstand(hass, "sensor", "totalpris").state) == SVAR["status"]["pris"]["total"]
    assert float(_tilstand(hass, "sensor", "effekt").state) == 2400
    assert float(_tilstand(hass, "sensor", "time_grense").state) == SVAR["motor"]["budsjett"]["grense"]
    assert float(_tilstand(hass, "sensor", "ute_temp").state) == -3.3
    assert _tilstand(hass, "sensor", "modus").state == "Hjemme"
    assert _tilstand(hass, "sensor", "bereder_status").state == "Boost"

    status = _tilstand(hass, "sensor", "motor_status")
    assert status.state in ("God margin", "Følger med", "Nær grensen", "På grensen", "Over grensen")
    assert {r["key"] for r in status.attributes["rom"]} == {"stue", "bad"}

    assert _tilstand(hass, "binary_sensor", "hjemme_rune").state == "on"
    assert _tilstand(hass, "binary_sensor", "hjemme_sebastian").state == "off"
    assert _tilstand(hass, "binary_sensor", "maleproblem").state == "off"
    assert _tilstand(hass, "switch", "bortemodus").state == "off"
    assert _tilstand(hass, "switch", "norgespris").state == "on"
    assert _tilstand(hass, "switch", "lading_automatikk").state == "on"
    assert _tilstand(hass, "sensor", "lading").state == "unknown"          # ingen lader er satt opp i fiksturen
    assert _tilstand(hass, "switch", "skyggemodus").state == ("on" if SVAR["motorinnstillinger"]["skygge"] else "off")
    assert _tilstand(hass, "time", "dag_start").state == "06:00:00"
    assert float(_tilstand(hass, "number", "temp_stue_dag").state) == 22

    stue = _tilstand(hass, "climate", "rom_stue")
    assert stue.state == "heat"
    rom = next(r for r in SVAR["motor"]["soner"] if r["key"] == "stue")
    assert stue.attributes["current_temperature"] == rom["temp"] == 20.5
    assert stue.attributes["temperature"] == rom["settpunkt"]
    assert stue.attributes["krav"] == 22
    assert stue.attributes["hvac_action"] == "heating"          # ovnene trekker 1500 W
    assert stue.attributes["forklaring"]
    # Den lokale versjonens tjenester hører ikke hjemme her
    assert not any(hass.services.has_service(DOMAIN, t) for t in TJENESTER)


async def test_endringer_sendes_til_homey(hass, aioclient_mock):
    await _sett_opp(hass, aioclient_mock)

    async def kall(domene, tjeneste, plattform, nokkel, **data):
        await hass.services.async_call(domene, tjeneste, {"entity_id": _id(hass, plattform, nokkel), **data}, blocking=True)

    await kall("switch", "turn_on", "switch", "bortemodus")
    await kall("switch", "turn_off", "switch", "skyggemodus")
    await kall("switch", "turn_off", "switch", "bereder_styring")
    await kall("switch", "turn_off", "switch", "lading_automatikk")
    await kall("climate", "set_temperature", "climate", "rom_stue", temperature=23.5)
    await kall("number", "set_value", "number", "temp_stue_natt", value=18.5)
    await kall("number", "set_value", "number", "maks_time", value=5.5)
    await kall("time", "set_value", "time", "hjemkomst_tid", time=dtime(17, 30))
    await kall("time", "set_value", "time", "natt_start", time=dtime(22, 30))
    await kall("button", "press", "button", "bereder_boost")
    await kall("button", "press", "button", "forleng_borte")

    e = _endringer(aioclient_mock)
    assert ("POST", "/bortemodus", {"paa": True}) in e
    assert ("PUT", "/motorinnstillinger", {"skygge": False}) in e
    assert ("PUT", "/husinnstillinger", {"vvb": {"prisstyring": False}}) in e
    assert ("PUT", "/husinnstillinger", {"lading": {"automatikk": False}}) in e
    assert ("POST", "/overstyr", {"rom": "stue", "temp": 23.5, "minutter": 120}) in e
    assert ("PUT", "/motorinnstillinger", {"maksTimeKwh": 5.5}) in e
    assert ("POST", "/hjemkomst", {"tid": "17:30"}) in e
    assert ("PUT", "/motorinnstillinger", {"nattStart": "22:30"}) in e
    assert ("POST", "/bereder", {"handling": "boost", "minutter": 60}) in e
    assert ("POST", "/forleng", {}) in e
    # Romtemperaturen: hele romlista sendes tilbake, bare stuas natt er endret
    soner = next(k["soner"] for m, sti, k in e if sti == "/motorinnstillinger" and "soner" in k)
    foer = {s["key"]: s["natt"] for s in SVAR["motorinnstillinger"]["soner"]}
    assert {s["key"]: s["natt"] for s in soner} == {**foer, "stue": 18.5}
    assert all(s.get("termostater") for s in soner), "resten av rommets oppsett skal følge med urørt"


async def test_ny_tilstand_hentes_etter_en_endring(hass, aioclient_mock):
    await _sett_opp(hass, aioclient_mock)
    assert _tilstand(hass, "switch", "bortemodus").state == "off"
    # Homey svarer med ny tilstand etter endringen (appen regner på nytt før den svarer)
    ny = copy.deepcopy(SVAR)
    ny["hus"]["borte"] = True
    ny["hus"]["modus"] = "Borte"
    ny["hus"]["lading"] = {"handling": "hold", "trinn": 16, "kw": 3.6, "forklaring": "Lader på 16 A"}
    _homey(aioclient_mock, ny)
    await hass.services.async_call("switch", "turn_on", {"entity_id": _id(hass, "switch", "bortemodus")}, blocking=True)
    await hass.async_block_till_done()
    assert _tilstand(hass, "switch", "bortemodus").state == "on"
    assert _tilstand(hass, "sensor", "modus").state == "Borte"
    assert _tilstand(hass, "sensor", "lading").state == "Lader på 16 A"


async def test_homey_nede_gir_utilgjengelige_entiteter_og_de_kommer_tilbake(hass, aioclient_mock):
    entry = await _sett_opp(hass, aioclient_mock)
    koordinator = hass.data[DOMAIN][entry.entry_id]
    aioclient_mock.clear_requests()
    for sti in KILDER.values():
        aioclient_mock.get(ROT + sti, exc=TimeoutError())
    await koordinator.async_refresh()
    await hass.async_block_till_done()
    assert koordinator.last_update_success is False
    assert _tilstand(hass, "sensor", "totalpris").state == "unavailable"
    assert _tilstand(hass, "climate", "rom_stue").state == "unavailable"
    _homey(aioclient_mock)
    await koordinator.async_refresh()
    await hass.async_block_till_done()
    assert _tilstand(hass, "sensor", "totalpris").state != "unavailable"


async def test_homey_som_ikke_svarer_ved_oppstart_proeves_igjen(hass, aioclient_mock):
    for sti in KILDER.values():
        aioclient_mock.get(ROT + sti, exc=TimeoutError())
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_MODUS: MODUS_HOMEY, CONF_HOMEY_HOST: "192.168.1.20", CONF_HOMEY_TOKEN: "x"})
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    assert entry.state.value == "setup_retry"


async def test_tomt_oppsett_paa_homey_gir_ingen_rom_men_virker(hass, aioclient_mock):
    tomt = copy.deepcopy(SVAR)
    tomt["motor"] = {"status": "starter", "soner": []}
    tomt["hus"] = {"modus": "starter", "personer": []}
    tomt["motorinnstillinger"]["soner"] = []
    await _sett_opp(hass, aioclient_mock, tomt)
    assert _tilstand(hass, "sensor", "motor_status").state == "Starter"
    assert _tilstand(hass, "sensor", "time_grense").state == "unknown"
    assert not [s for s in hass.states.async_all("climate")]


async def test_alternativer_og_avlasting(hass, aioclient_mock):
    entry = await _sett_opp(hass, aioclient_mock)
    r = await hass.config_entries.options.async_init(entry.entry_id)
    assert r["type"] == "form" and r["step_id"] == "init"
    r = await hass.config_entries.options.async_configure(r["flow_id"], {CONF_HOMEY_HOST: "192.168.1.20", CONF_HOMEY_TOKEN: "ny", CONF_HOMEY_INTERVALL: 60})
    assert r["type"] == "create_entry"
    await hass.async_block_till_done()
    assert entry.options[CONF_HOMEY_INTERVALL] == 60
    assert aioclient_mock.mock_calls[-1][3]["Authorization"] == "Bearer ny"
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.entry_id not in hass.data[DOMAIN]
