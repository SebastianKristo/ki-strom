import pytest
from datetime import timedelta
from unittest.mock import patch
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed
from custom_components.ki_energi.const import DOMAIN, DEFAULT_CONFIG, DEFAULT_SONER, CONF_SONER, SWITCHES, NUMBERS, TIMES, DATETIMES, TEXTS, SENSORS, BINARY_SENSORS

pytestmark = pytest.mark.asyncio

async def _setup(hass):
    data = dict(DEFAULT_CONFIG); data[CONF_SONER] = {k: dict(v) for k, v in DEFAULT_SONER.items()}
    # fake source entities
    hass.states.async_set("sensor.strommaler_effekt", "3200", {"unit_of_measurement": "W"})
    hass.states.async_set("sensor.strommaler_imported_energy", "12345.6")
    hass.states.async_set("sensor.outdoor_meter_temperature", "-3")
    hass.states.async_set("sensor.nettleie_elvia_toppforbruk", "4.1")
    hass.states.async_set("sensor.nettleie_elvia_toppforbruk_2", "3.9")
    hass.states.async_set("sensor.nettleie_elvia_toppforbruk_3", "3.5")
    hass.states.async_set("sensor.norgespris_total_strompris_norgespris", "1.2")
    hass.states.async_set("switch.varmtvannsbereder", "on")
    hass.states.async_set("sensor.varmtvannsbereder_power", "2000")
    hass.states.async_set("switch.sebastian_posisjon_hjemme_borte", "on")
    hass.states.async_set("switch.cybele_posisjon_hjemme_borte", "on")
    hass.states.async_set("switch.rune_posisjon_hjemme_borte", "off")
    for k, s in DEFAULT_SONER.items():
        for c in (s["climate"] if isinstance(s.get("climate"), list) else [s.get("climate")]):
            if c:
                hass.states.async_set(c, "heat", {"temperature": 21, "current_temperature": 20.5, "hvac_modes": ["off","heat"], "min_temp": 5, "max_temp": 30})
        for e in (s["effekt"] if isinstance(s.get("effekt"), list) else [s.get("effekt")]):
            if e:
                hass.states.async_set(e, "800")
        if s.get("temp"):
            hass.states.async_set(s["temp"], "20.3")
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry

async def test_setup_and_tick(hass):
    entry = await _setup(hass)
    missing = []
    for dom, defs in (("switch", SWITCHES), ("number", NUMBERS), ("time", TIMES), ("datetime", DATETIMES), ("text", TEXTS), ("sensor", SENSORS), ("binary_sensor", BINARY_SENSORS)):
        for d in defs:
            eid = f"{dom}.{d[0]}"
            if hass.states.get(eid) is None:
                missing.append(eid)
    assert not missing, missing
    # zone entities
    for k in DEFAULT_SONER:
        assert hass.states.get(f"switch.ki_styr_{k}") is not None, k
    hub = hass.data[DOMAIN][entry.entry_id]
    # tick
    await hub.engine.tick()
    await hass.async_block_till_done()
    st = hass.states.get("sensor.ki_energi_status")
    print("STATUS", st.state, dict(st.attributes))
    print("LASTER", hass.states.get("sensor.ki_laster").attributes.get("laster"))
    print("LOGG", hass.states.get("sensor.ki_beslutningslogg").state)
    print("PROGNOSE", hass.states.get("sensor.ki_prognose").state, dict(hass.states.get("sensor.ki_prognose").attributes))
    print("VVB", hass.states.get("sensor.ki_bereder").state, hass.states.get("sensor.ki_vvb_status").state if hass.states.get("sensor.ki_vvb_status") else None)
    assert st.state not in ("unknown", "unavailable")
    # simulate time passing: timers
    now = dt_util.utcnow()
    for m in (1, 5, 30):
        async_fire_time_changed(hass, now + timedelta(minutes=m))
        await hass.async_block_till_done()
    await hub.engine.timeslutt()
    await hub.engine.laering()
    await hub.vvb.tick()
    await hub.moduser.tick()
    await hass.async_block_till_done()
    print("VVB2", hass.states.get("sensor.ki_bereder").state, dict(hass.states.get("sensor.ki_bereder").attributes))
    print("MODUS", hass.states.get("binary_sensor.ki_alle_borte").state, hass.states.get("sensor.ki_klima_status").state)
    # services
    await hass.services.async_call(DOMAIN, "overstyr", {"sone": list(DEFAULT_SONER)[0], "temp": 19, "minutter": 60}, blocking=True)
    await hass.services.async_call(DOMAIN, "fjern_overstyring", {"sone": list(DEFAULT_SONER)[0]}, blocking=True)
    await hass.services.async_call(DOMAIN, "vvb_boost", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "vvb_avbryt_boost", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "vvb_tving_syklus", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "hjemkomst", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "hjemkomst_ferdig", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "helg_sporsmal", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "sett_standardverdier", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "nullstill_laering", {}, blocking=True)
    await hass.services.async_call(DOMAIN, "tick", {}, blocking=True)
    await hass.async_block_till_done()
    # helper entities operate
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.ki_skyggemodus"}, blocking=True)
    await hass.services.async_call("number", "set_value", {"entity_id": "number.ki_temp_stue_dag", "value": 21.5}, blocking=True)
    await hass.services.async_call("time", "set_value", {"entity_id": f"time.{TIMES[0][0]}", "time": "06:30:00"}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get("switch.ki_skyggemodus").state == "off"
    await hub.engine.tick()
    await hass.async_block_till_done()
    print("STATUS2", hass.states.get("sensor.ki_energi_status").state, hass.states.get("sensor.ki_klima_status").state)
    # month change + unload
    await hub.engine.manedsskifte()
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

async def test_options_flow(hass):
    entry = await _setup(hass)
    r = await hass.config_entries.options.async_init(entry.entry_id)
    assert r["type"] == "menu"
    for step in ("maling", "utstyr", "personer", "nettleie", "hus", "soner"):
        r = await hass.config_entries.options.async_init(entry.entry_id)
        r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": step})
        assert r["type"] == "form", (step, r)
    # edit a zone
    r = await hass.config_entries.options.async_init(entry.entry_id)
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": "soner"})
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"sone": "stue"})
    assert r["step_id"] == "sone"
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"navn": "Stua", "type": "panel", "profil": "stue", "prio": 1, "nominell": 2.0, "sol": True, "aktiv": True})
    assert r["type"] == "create_entry", r
    await hass.async_block_till_done()
    assert entry.options[CONF_SONER]["stue"]["navn"] == "Stua"
    # new zone
    r = await hass.config_entries.options.async_init(entry.entry_id)
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": "soner"})
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"sone": "__ny__"})
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"key": "Loft", "navn": "Loft"})
    assert r["step_id"] == "sone", r
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"navn": "Loft", "type": "gulv", "profil": "konstant", "prio": 4, "nominell": 0.8, "sol": False, "aktiv": True})
    assert r["type"] == "create_entry", r
    await hass.async_block_till_done()
    assert "loft" in entry.options[CONF_SONER]
    assert hass.states.get("switch.ki_styr_loft") is not None
    assert hass.states.get("number.ki_temp_loft_dag") is not None
    # hus form submit
    r = await hass.config_entries.options.async_init(entry.entry_id)
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": "hus"})
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"areal_m2": 130, "byggear": 1980, "glass_m2": 25, "stue_areal_m2": 40, "varsel_mottakere": []})
    assert r["type"] == "create_entry", r

async def test_config_flow(hass):
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert r["type"] == "form" and r["step_id"] == "user"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"total_effekt": "sensor.a", "importert_energi": "sensor.b"})
    assert r["step_id"] == "utstyr"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["step_id"] == "personer"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["step_id"] == "nettleie"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["step_id"] == "hus"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"areal_m2": 120, "byggear": 1980, "glass_m2": 20, "stue_areal_m2": 40})
    assert r["type"] == "create_entry", r
    await hass.async_block_till_done()
    assert r["data"]["vvb_bryter"] == ""


async def test_skyggemodus_styrer_ingenting_og_nettleie_publiseres(hass):
    """10: skyggemodus regner og logger, men rører ikke termostater. Nettleiesensoren fylles."""
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]
    kall = []
    async def fake_set_temp(call):
        kall.append(dict(call.data))
    hass.services.async_register("climate", "set_temperature", fake_set_temp)

    # skygge på (standard) — mål tilsier senking når budsjettet er trangt
    await hass.services.async_call("number", "set_value", {"entity_id": "number.ki_maks_time_kwh", "value": 2.0}, blocking=True)
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.ki_skyggemodus"}, blocking=True)
    await hub.engine.tick(); await hass.async_block_till_done()
    assert kall == []
    n = hass.states.get("sensor.ki_nettleie")
    assert n is not None and n.state not in ("unknown", "unavailable")
    a = n.attributes
    for k in ("grense_kwh", "hvorfor", "reserve_kwh", "datakvalitet", "topp_tre", "tabell", "dager_igjen"):
        assert k in a, k
    # eksterne topper uten dato i testoppsettet → usikker
    assert a["datakvalitet"] == "usikker" and a["udaterte_topper"] == 3
    assert hass.states.get("sensor.ki_energi_status").attributes.get("skyggemodus") is True
    await hub.vvb.tick(); await hass.async_block_till_done()
    assert len(hass.states.get("sensor.ki_vvb_billige_timer").attributes.get("doegn") or []) == 24

    # skygge av → motoren skriver settpunkter
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.ki_skyggemodus"}, blocking=True)
    await hub.engine.tick(); await hass.async_block_till_done()
    assert kall, "forventet settpunkt-skriving uten skyggemodus"


async def test_migrering_soner_til_rom(hass):
    """To ovner i samme rom slås sammen til én sone med lister av climate/effekt."""
    from custom_components.ki_energi.const import DEFAULT_CONFIG
    data = dict(DEFAULT_CONFIG)
    data[CONF_SONER] = {
        "stue_panelovn": dict(navn="Stue panelovn", rom="Stue", climate="climate.a", effekt="sensor.a_w",
                              type="panel", prio=3, nominell=2.0, sol=True, profil="stue", aktiv=True),
        "stue_oljefyr": dict(navn="Stue oljefyr", rom="Stue", climate="climate.b", effekt="sensor.b_w",
                             type="panel", prio=4, nominell=1.0, sol=False, profil="stue", aktiv=True),
        "bad": dict(navn="Bad", rom="Bad", climate="climate.c", type="gulv", prio=2, nominell=1.0, profil="konstant", aktiv=True),
    }
    for c in ("climate.a", "climate.b", "climate.c"):
        hass.states.async_set(c, "heat", {"temperature": 21, "current_temperature": 20})
    hass.states.async_set("sensor.strommaler_effekt", "3200"); hass.states.async_set("sensor.strommaler_imported_energy", "1")
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    soner = entry.options[CONF_SONER]
    assert set(soner) == {"stue", "bad"}
    assert soner["stue"]["climate"] == ["climate.a", "climate.b"]
    assert soner["stue"]["effekt"] == ["sensor.a_w", "sensor.b_w"]
    assert soner["stue"]["nominell"] == 3.0 and soner["stue"]["prio"] == 3 and soner["stue"]["sol"] is True
    hub = hass.data[DOMAIN][entry.entry_id]
    assert hub.soner()["stue"]["climater"] == ["climate.a", "climate.b"]
    assert hass.states.get("switch.ki_styr_stue") is not None
