"""Kontrollversjonen: Home Assistant viser og styrer KI Energi-appen på Homey.

All beregning skjer på Homey. Her hentes appens tilstand over det lokale API-et
(http://<homey>/api/app/no.kristo.kienergi/…) og gjøres om til entiteter; brytere, tall
og knapper sender endringene tilbake.
"""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from ..const import CONF_HOMEY_HOST, CONF_HOMEY_INTERVALL, CONF_HOMEY_TOKEN, DOMAIN
from .klient import HomeyKlient
from .koordinator import HomeyKoordinator

PLATTFORMER = ["sensor", "binary_sensor", "switch", "number", "time", "button", "climate"]


def _verdi(entry: ConfigEntry, nokkel: str, standard=None):
    return entry.options.get(nokkel, entry.data.get(nokkel, standard))


async def sett_opp(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    klient = HomeyKlient(async_get_clientsession(hass), _verdi(entry, CONF_HOMEY_HOST), _verdi(entry, CONF_HOMEY_TOKEN))
    koordinator = HomeyKoordinator(hass, klient, int(_verdi(entry, CONF_HOMEY_INTERVALL, 30)))
    # Første henting feiler oppsettet (ConfigEntryNotReady) hvis Homey ikke svarer; HA prøver igjen selv.
    await koordinator.async_config_entry_first_refresh()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = koordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATTFORMER)
    return True


async def last_av(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATTFORMER)
    if ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return ok
