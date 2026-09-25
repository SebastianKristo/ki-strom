"""Robusthet i 2.31: ticket tåler at en del feiler, overlapper ikke seg selv, og
effektsensorene skrives ikke oftere enn hvert annet sekund. Pluss diagnostikk og at
tjenestene registreres og fjernes fra samme liste."""
import asyncio
from datetime import timedelta
from unittest.mock import patch

import pytest
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.ki_energi.const import DOMAIN, TICK_SEK, TJENESTER
from custom_components.ki_energi.diagnostics import async_get_config_entry_diagnostics
from test_smoke import _setup

pytestmark = pytest.mark.asyncio


async def _tikk(hass):
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=TICK_SEK + 1))
    await hass.async_block_till_done()


async def test_en_del_som_feiler_stopper_ikke_motoren(hass):
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]

    async def sprekk():
        raise RuntimeError("bereder uten kontakt")

    with patch.object(hub.vvb, "tick", sprekk), patch.object(hub.engine, "tick", wraps=hub.engine.tick) as motor:
        await _tikk(hass)
        assert motor.await_count >= 1, "motoren skal kjøre selv om berederen feilet"
    assert hub.feil_i_tick == {"bereder": "bereder uten kontakt"}
    st = hass.states.get("sensor.ki_energi_status")
    assert st.attributes["feil"] == {"bereder": "bereder uten kontakt"}
    # neste tick går bra → feilen forsvinner
    await _tikk(hass)
    assert hub.feil_i_tick == {}


async def test_tick_overlapper_ikke_seg_selv(hass):
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]
    slipp = asyncio.Event()

    async def treg():
        await slipp.wait()

    with patch.object(hub.moduser, "tick", treg):
        forste = asyncio.ensure_future(hub.moduser.tick())  # bare for å vise at den henger
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=TICK_SEK + 1))
        await asyncio.sleep(0.05)                           # første tick henger i moduser
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=2 * TICK_SEK + 2))
        await asyncio.sleep(0.05)
        # både oppstartsticket (20 s) og intervallticket treffer mens det første henger
        assert hub.tick_hoppet_over >= 1
        slipp.set()
        await forste
        await hass.async_block_till_done()


async def test_effektsensorene_skrives_samlet(hass):
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]
    with patch.object(hub.engine, "oppdater_effektsensorer", wraps=hub.engine.oppdater_effektsensorer) as skriv, \
         patch.object(hub.engine, "integrer_effekt", wraps=hub.engine.integrer_effekt) as integrer:
        for w in (3210, 3250, 3300, 3290, 3400):
            hass.states.async_set("sensor.strommaler_effekt", str(w), {"unit_of_measurement": "W"})
            await hass.async_block_till_done()
        assert integrer.call_count == 5, "integralet må ha hver eneste måling"
        assert skriv.call_count == 0, "sensorene venter"
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=3))
        await hass.async_block_till_done()
        assert skriv.call_count == 1, "…og skrives én gang for hele skuren"


async def test_diagnostikk(hass):
    entry = await _setup(hass)
    hass.config_entries.async_update_entry(entry, options={**entry.options, "varsel_mottakere": ["mobile_app_x"]})
    await hass.async_block_till_done()          # oppdaterte options laster integrasjonen på nytt
    await _tikk(hass)                            # …og et tick fyller sensorene
    d = await async_get_config_entry_diagnostics(hass, entry)
    assert d["options"]["varsel_mottakere"] == "**REDACTED**"
    assert "ki_energi_status" in d["sensorer"]
    assert d["kilder"]["total_effekt"]["entity_id"] == "sensor.strommaler_effekt"
    assert "feil_i_tick" in d["helse"]


async def test_tjenestene_registreres_og_fjernes(hass):
    entry = await _setup(hass)
    for tj in TJENESTER:
        assert hass.services.has_service(DOMAIN, tj), tj
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    for tj in TJENESTER:
        assert not hass.services.has_service(DOMAIN, tj), tj


async def test_overstyring_synes_i_lastlista(hass):
    """Kortet trenger å vite til når en manuell temperatur gjelder."""
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]
    sone = next(iter(hub.aktive_soner()))
    await hass.services.async_call(DOMAIN, "overstyr", {"sone": sone, "temp": 23.5, "minutter": 90}, blocking=True)
    await hass.async_block_till_done()
    rad = next(r for r in hass.states.get("sensor.ki_laster").attributes["laster"] if r["key"] == sone)
    assert rad["overstyrt"] is True
    assert rad["overstyrt_temp"] == 23.5
    til = dt_util.parse_datetime(rad["overstyrt_til"])
    assert 85 <= (til - dt_util.now()).total_seconds() / 60 <= 91
    await hass.services.async_call(DOMAIN, "fjern_overstyring", {"sone": sone}, blocking=True)
    await hass.async_block_till_done()
    rad = next(r for r in hass.states.get("sensor.ki_laster").attributes["laster"] if r["key"] == sone)
    assert rad["overstyrt"] is False and rad["overstyrt_til"] is None
