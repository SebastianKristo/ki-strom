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
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"preset": "bolig"})
    assert r["step_id"] == "maling"
    # feil sensor-type gir feilmelding, riktige går videre
    hass.states.async_set("sensor.a", "1200", {"unit_of_measurement": "W", "device_class": "power"})
    hass.states.async_set("sensor.b", "5000", {"unit_of_measurement": "kWh", "device_class": "energy", "state_class": "total_increasing"})
    hass.states.async_set("sensor.dag", "12", {"unit_of_measurement": "kWh", "device_class": "energy", "state_class": "measurement"})
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"total_effekt": "sensor.a", "importert_energi": "sensor.dag"})
    assert r["type"] == "form" and r["errors"] == {"importert_energi": "ikke_register"}
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"total_effekt": "sensor.a", "importert_energi": "sensor.b"})
    assert r["step_id"] == "utstyr"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["step_id"] == "personer"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["step_id"] == "nettleie"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {})
    assert r["step_id"] == "hus"
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"hustype": "bolig", "areal_m2": 120, "byggear": 1980, "glass_m2": 20, "stue_areal_m2": 40})
    assert r["step_id"] == "soner_auto", r
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {"kilde": "preset", "soner": []})
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
    sp = hass.states.get("sensor.ki_sparing")
    assert sp is not None and "poster" in sp.attributes and set(sp.attributes["poster"]) == {"motor", "gardiner", "hanklevarmer", "bereder", "lys"}
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


async def test_preset_toten_fritidsbolig(hass):
    """Hytte-preset: frostverdier legges inn, helg = tom hytte uansett ukedag, torsdagssvar planlegger fredag."""
    from custom_components.ki_energi.const import PRESETS, DEFAULT_SONER_HYTTE, CONF_PRESET, CONF_HUSTYPE, AKSJON_HELG_JA
    from datetime import datetime
    p = PRESETS["hytte"]
    data = dict(DEFAULT_CONFIG); data.update(p["config"])
    data[CONF_PRESET] = "hytte"; data[CONF_HUSTYPE] = "fritidsbolig"
    data[CONF_SONER] = {k: dict(v) for k, v in DEFAULT_SONER_HYTTE.items()}
    from custom_components.ki_energi.const import CONF_PERSONER
    data[CONF_PERSONER] = [{"key": "barn", "navn": "Barn", "type": "barn", "entity": "person.barn"},
                           {"key": "ungdom", "navn": "Ungdom", "type": "ungdom", "entity": "person.ungdom"},
                           {"key": "voksen", "navn": "Voksen", "type": "voksen", "entity": "person.voksen"}]
    hass.states.async_set("sensor.hytte_strommaler_effekt", "1200"); hass.states.async_set("sensor.hytte_strommaler_imported_energy", "500")
    hass.states.async_set("sensor.hytte_utetemperatur", "-8"); hass.states.async_set("sensor.hytte_bereder_effekt", "0")
    for pid in ("person.barn", "person.ungdom", "person.voksen"):
        hass.states.async_set(pid, "not_home")
    for s in DEFAULT_SONER_HYTTE.values():
        for c in s["climate"]:
            hass.states.async_set(c, "heat", {"temperature": 20, "current_temperature": 9})
        for e in s["effekt"]:
            hass.states.async_set(e, "0")
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    hub = hass.data[DOMAIN][entry.entry_id]
    assert hub.fritidsbolig()
    await hub.engine.tick(); await hass.async_block_till_done()
    # presetverdier lagt inn én gang
    assert float(hass.states.get("number.ki_temp_helg").state) == 8.0
    assert float(hass.states.get("number.ki_maks_time_kwh").state) == 9.5
    assert hass.states.get("switch.ki_elbil_natt").state == "on"
    assert hass.states.get("sensor.ki_energi_status").attributes["hustype"] == "fritidsbolig"
    # bereder uten bryter: måles, styres ikke
    await hub.vvb.tick(); await hass.async_block_till_done()
    assert "ingen bryter" in hass.states.get("sensor.ki_vvb_forklaring").state
    # helg-auto: tom hytte på en tirsdag → frostsikring etter 3 t
    m = hub.moduser
    tirsdag = dt_util.now().replace(hour=12, minute=30)
    while tirsdag.weekday() != 1:
        tirsdag += timedelta(days=1)
    m.m["borte_siden"] = (tirsdag - timedelta(hours=4)).isoformat()
    with patch("homeassistant.util.dt.now", return_value=tirsdag):
        await m.tick(); await hass.async_block_till_done()
    assert hass.states.get("switch.ki_helgemodus").state == "on"
    # torsdag: «Ja, vi kommer fredag» → ankomst planlagt fredag 17:00, frost beholdes
    torsdag = tirsdag + timedelta(days=2)
    with patch("homeassistant.util.dt.now", return_value=torsdag):
        await m._handling(AKSJON_HELG_JA); await hass.async_block_till_done()
    plan = hub.dt("ki_hjemkomst_planlagt")
    assert plan.weekday() == 4 and plan.hour == 17
    assert hass.states.get("switch.ki_hjemkomst_aktiv").state == "on"
    assert hass.states.get("switch.ki_helgemodus").state == "on"
    # fredag: «Ja, vi kommer» → oppvarming nå, plan i dag kl. 17
    from custom_components.ki_energi.const import AKSJON_HELG_NAA, AKSJON_HYTTE_DRAR
    fredag = torsdag + timedelta(days=1)
    fredag = fredag.replace(hour=10)
    with patch("homeassistant.util.dt.now", return_value=fredag):
        await m._handling(AKSJON_HELG_NAA); await hass.async_block_till_done()
    plan = hub.dt("ki_hjemkomst_planlagt")
    assert plan.date() == fredag.date() and plan.hour == 17
    # søndag: alle er der, «Ja, vi drar» → armert; siste drar → frost
    for pid in ("person.barn", "person.ungdom", "person.voksen"):
        hass.states.async_set(pid, "home")
    sondag = fredag + timedelta(days=2)
    with patch("homeassistant.util.dt.now", return_value=sondag):
        await m.tick(); await hass.async_block_till_done()          # noen kom → ankomst ferdig, helg av
        assert hass.states.get("switch.ki_helgemodus").state == "off"
        await m._handling(AKSJON_HYTTE_DRAR); await hass.async_block_till_done()
        assert m.m.get("helg_ved_avreise") is True
        for pid in ("person.barn", "person.ungdom", "person.voksen"):
            hass.states.async_set(pid, "not_home")
        await m.tick(); await hass.async_block_till_done()
    assert hass.states.get("switch.ki_helgemodus").state == "on"
    # >20 t fram: målet er fortsatt frost (sett opp ny torsdagsplan for sjekken)
    with patch("homeassistant.util.dt.now", return_value=torsdag):
        await m._handling(AKSJON_HELG_JA); await hass.async_block_till_done()
    with patch("homeassistant.util.dt.now", return_value=torsdag):
        mal, grunn, frist = hub.engine.mal_temperatur("soverom_ungdom", hub.soner()["soverom_ungdom"])
    assert mal == 8.0 and frist is None


async def test_oppdag_soner_fra_omrader(hass):
    """Automatisk gjenkjenning: én sone per område med termostat, effekt og vindu i samme område kobles på."""
    from homeassistant.helpers import area_registry as ar, entity_registry as er
    from custom_components.ki_energi import oppdag
    areg = ar.async_get(hass); ereg = er.async_get(hass)
    stue = areg.async_create("Stue"); bad = areg.async_create("Bad")
    for eid, area, attrs in (
        ("climate.stue_panelovn", stue.id, {"hvac_modes": ["off", "heat"]}),
        ("climate.stue_varmepumpe", stue.id, {"hvac_modes": ["off", "heat", "cool"]}),
        ("sensor.stue_panelovn_effekt", stue.id, {"device_class": "power", "unit_of_measurement": "W"}),
        ("binary_sensor.stue_vindu", stue.id, {"device_class": "window"}),
        ("climate.bad_gulv", bad.id, {"hvac_modes": ["off", "heat"]}),
    ):
        dom, obj = eid.split(".")
        e = ereg.async_get_or_create(dom, "test", obj, suggested_object_id=obj)
        ereg.async_update_entity(e.entity_id, area_id=area)
        hass.states.async_set(e.entity_id, "heat" if dom == "climate" else "0", {**attrs, "friendly_name": obj.replace("_", " ")})
    soner = oppdag.soner_fra_omrader(hass)
    assert set(soner) == {"stue", "bad"}
    assert soner["stue"]["type"] == "varmepumpe" and soner["stue"]["profil"] == "stue"
    assert len(soner["stue"]["climate"]) == 2 and soner["stue"]["effekt"] == ["sensor.stue_panelovn_effekt"]
    assert soner["stue"]["vindu"] == ["binary_sensor.stue_vindu"]
    assert soner["bad"]["type"] == "gulv" and soner["bad"]["profil"] == "konstant"
    # sensorgjenkjenning
    hass.states.async_set("sensor.ams_maler_effekt", "3400", {"device_class": "power", "unit_of_measurement": "W"})
    hass.states.async_set("sensor.ams_maler_energi_importert", "12345", {"device_class": "energy", "unit_of_measurement": "kWh", "state_class": "total_increasing"})
    hass.states.async_set("sensor.energi_i_dag", "8", {"device_class": "energy", "unit_of_measurement": "kWh", "state_class": "total_increasing"})
    f = oppdag.forslag_alle(hass)
    assert f["total_effekt"] == "sensor.ams_maler_effekt"
    assert f["importert_energi"] == "sensor.ams_maler_energi_importert"


async def test_personer_generisk_og_vindu_forvarming(hass):
    """Egendefinerte personer: hjelpere lages per type, profil person:<key> styrer rommet.
    Åpent vindu blokkerer ikke forvarmingen mot vekking."""
    from custom_components.ki_energi.const import CONF_PERSONER
    data = dict(DEFAULT_CONFIG)
    data[CONF_PERSONER] = [{"key": "emma", "navn": "Emma", "type": "barn", "entity": "person.emma"},
                           {"key": "ola", "navn": "Ola", "type": "ungdom", "entity": ""},
                           {"key": "kari", "navn": "Kari", "type": "voksen", "entity": "person.kari"}]
    data[CONF_SONER] = {"emma": dict(navn="Emma", rom="Emma", climate=["climate.emma"], effekt=[], type="panel", prio=3,
                                     nominell=1.0, sol=False, profil="person:emma", aktiv=True, vindu=["binary_sensor.emma_vindu"])}
    hass.states.async_set("sensor.strommaler_effekt", "1500"); hass.states.async_set("sensor.strommaler_imported_energy", "10")
    hass.states.async_set("person.emma", "home"); hass.states.async_set("person.kari", "not_home")
    hass.states.async_set("climate.emma", "heat", {"temperature": 21, "current_temperature": 17})
    hass.states.async_set("binary_sensor.emma_vindu", "on")
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    hub = hass.data[DOMAIN][entry.entry_id]
    for eid in ("time.ki_emma_dag", "time.ki_emma_borte_til", "time.ki_ola_vekking", "time.ki_ola_vekking_helg", "switch.ki_ola_ferie"):
        assert hass.states.get(eid) is not None, eid
    assert hass.states.get("time.ki_kari_dag") is None            # voksen får ingen tider
    assert hub.voksne_hjemme() is False
    # kl. 04:30 sover Emma (05:30 opp); vinduet er åpent, men forvarmingen mot 05:30 skal gå
    await hass.services.async_call("number", "set_value", {"entity_id": "number.ki_vindu_forsinkelse_min", "value": 0}, blocking=True)
    kl = dt_util.now().replace(hour=4, minute=30)
    with patch("homeassistant.util.dt.now", return_value=kl):
        await hub.engine.tick(); await hass.async_block_till_done()
    l = [x for x in hass.states.get("sensor.ki_laster").attributes["laster"] if x["key"] == "emma"][0]
    assert l["person"] == "Emma" and l["person_type"] == "barn"
    assert l["handling"] != "vindu" and l["vindu"] is False   # vinduet ignoreres under forvarming


async def test_auto_soveromsmodus(hass):
    """Søvnsensor overstyrer klokkeslettet når bryteren er på; av → klokkeslett som før."""
    from custom_components.ki_energi.const import CONF_PERSONER
    data = dict(DEFAULT_CONFIG)
    data[CONF_PERSONER] = [{"key": "ola", "navn": "Ola", "type": "ungdom", "entity": "", "sover": "binary_sensor.ola_sover"}]
    data[CONF_SONER] = {"ola": dict(navn="Ola", rom="Ola", climate=["climate.ola"], effekt=[], type="panel", prio=3,
                                    nominell=1.0, sol=False, profil="person:ola", aktiv=True)}
    hass.states.async_set("sensor.strommaler_effekt", "1500"); hass.states.async_set("sensor.strommaler_imported_energy", "10")
    hass.states.async_set("climate.ola", "heat", {"temperature": 21, "current_temperature": 20})
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    hub = hass.data[DOMAIN][entry.entry_id]
    konf = hub.soner()["ola"]
    kveld = dt_util.now().replace(hour=21, minute=0)     # før leggetid 23:00
    natt = dt_util.now().replace(hour=23, minute=30)     # etter leggetid
    with patch("homeassistant.util.dt.now", return_value=kveld):
        hass.states.async_set("binary_sensor.ola_sover", "on")
        mal, grunn, frist = hub.engine.mal_temperatur("ola", konf)
        assert "sover (registrert)" in grunn and mal < 21                   # sovnet tidlig → natt nå
    with patch("homeassistant.util.dt.now", return_value=natt):
        hass.states.async_set("binary_sensor.ola_sover", "off")
        mal, grunn, frist = hub.engine.mal_temperatur("ola", konf)
        assert "våken" in grunn and mal >= 21                               # oppe sent → dag
        hass.states.async_set("binary_sensor.ola_sover", "unavailable")
        mal, grunn, frist = hub.engine.mal_temperatur("ola", konf)
        assert grunn == "Sover"                                              # sensor borte → klokkeslett
        await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.ki_auto_soveromsmodus"}, blocking=True)
        hass.states.async_set("binary_sensor.ola_sover", "off")
        mal, grunn, frist = hub.engine.mal_temperatur("ola", konf)
        assert grunn == "Sover"                                              # bryter av → klokkeslett


async def test_prognoselaering_i_motoren_og_gradvis_gjenoppvarming(hass):
    """Sensoren publiseres, marginen telles én gang (fordel), strategisk reserve står urørt i nettleie,
    og senkede soner slippes gradvis."""
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]
    await hub.engine.tick(); await hass.async_block_till_done()
    pl = hass.states.get("sensor.ki_prognoselaering")
    assert pl is not None and pl.state == "laerer"
    a = pl.attributes
    assert a["strategisk_reserve_kwh"] == 0.3 and a["kilde"] == "fast"
    assert a["kwh"] == pytest.approx(0.35 * a["horisont"] / 60, abs=0.15)   # fast reserve × tid igjen (ca.)
    # nettleie bruker bare den strategiske reserven (ikke timemarginen)
    nv = hub.engine.nettleie_vurdering
    assert nv["reserve_kwh"] >= 0.3 and "prognose" not in " ".join(nv["reserve_grunner"])
    # gradvis gjenoppvarming: to senkede soner → maks én slippes per runde
    laster = hub.engine.bygg_laster()
    kandidater = [l for l in laster if l["levende"] and l["styrt"] and l["key"] != "vvb"][:2]
    hub.engine._senket_forrige = {l["key"]: 1.0 for l in kandidater}
    for l in laster:
        l["trenger"] = l["key"] in {k["key"] for k in kandidater}
        l["vindu"] = False
    b = dict(hub.engine.budsjett()); b["tillatt_snitt"] = sum(l["effekt"] for l in kandidater) + 0.5 + 0.35
    plan, _ = hub.engine.fordel(laster, b, 0.0, 0.0, None)
    handlinger = {p["key"]: p.get("venter", False) for p in plan if p["key"] in {k["key"] for k in kandidater}}
    assert sum(1 for v in handlinger.values() if v) == 1, handlinger                 # én venter, én slippes


async def test_lysregler(hass):
    """Glemt lys: med sensor slås av etter fravær, ikke mens noen er der; uten sensor etter maks på-tid.
    Demping: settes ved overgang, manuell endring respekteres. Bryter per regel."""
    from custom_components.ki_energi.const import CONF_LYSREGLER
    data = dict(DEFAULT_CONFIG)
    data[CONF_LYSREGLER] = [
        {"key": "soverom", "navn": "Soverom", "type": "glemt", "light": "light.sov", "presence": "binary_sensor.sov_bev", "fravaer_min": 5},
        {"key": "vaskerom", "navn": "Vaskerom", "type": "glemt", "light": "light.vask", "maks_pa_min": 30},
        {"key": "inngang", "navn": "Inngang", "type": "demp", "light": "light.inng", "natt_prosent": 25, "dag_prosent": 80},
    ]
    hass.states.async_set("sensor.strommaler_effekt", "1500"); hass.states.async_set("sensor.strommaler_imported_energy", "10")
    for l in ("light.sov", "light.vask"):
        hass.states.async_set(l, "on")
    hass.states.async_set("light.inng", "on", {"brightness": 204})
    hass.states.async_set("binary_sensor.sov_bev", "on")
    kall = []
    async def fake(call): kall.append((call.service, call.data.get("entity_id"), call.data.get("brightness_pct")))
    hass.services.async_register("light", "turn_off", fake); hass.services.async_register("light", "turn_on", fake)
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    hub = hass.data[DOMAIN][entry.entry_id]
    for k in ("soverom", "vaskerom", "inngang"):
        assert hass.states.get(f"switch.ki_lys_{k}") is not None
    dag = dt_util.now().replace(hour=14, minute=0)
    with patch("homeassistant.util.dt.now", return_value=dag):
        await hub.lys.tick(); await hass.async_block_till_done()
        st = {r["key"]: r for r in hass.states.get("sensor.ki_lys").attributes["regler"]}
        assert st["soverom"]["status"] == "i_bruk" and st["vaskerom"]["status"] == "venter"
        assert ("turn_off", "light.sov", None) not in kall
        # noen forlot rommet for 10 min siden
        hass.states.async_set("binary_sensor.sov_bev", "off")
        hass.states.get("binary_sensor.sov_bev")  # last_changed = nå
        hub.lys.m["pa_siden"]["vaskerom"] = (dag - timedelta(minutes=45)).isoformat()
    with patch("homeassistant.util.dt.now", return_value=dag + timedelta(minutes=10)):
        await hub.lys.tick(); await hass.async_block_till_done()
    assert ("turn_off", "light.sov", None) in kall and ("turn_off", "light.vask", None) in kall
    # demping: dag 80 % — allerede 80 → ingen kall; natt → 25 %
    assert not any(k[1] == "light.inng" for k in kall)
    natt = dt_util.now().replace(hour=23, minute=30)
    with patch("homeassistant.util.dt.now", return_value=natt):
        await hub.lys.tick(); await hass.async_block_till_done()
    assert ("turn_on", "light.inng", 25) in kall
    # bryter av → regelen gjør ingenting
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.ki_lys_vaskerom"}, blocking=True)
    hass.states.async_set("light.vask", "on"); hub.lys.m["pa_siden"]["vaskerom"] = (dag - timedelta(minutes=90)).isoformat()
    hass.states.async_set("light.sov", "off"); hass.states.async_set("light.inng", "off")
    n = len(kall)
    with patch("homeassistant.util.dt.now", return_value=dag):
        await hub.lys.tick(); await hass.async_block_till_done()
    assert len(kall) == n
