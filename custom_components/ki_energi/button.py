"""Knapper — finnes bare i kontrollversjonen (Homey)."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_MODUS, DOMAIN, MODUS_HOMEY


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    if entry.data.get(CONF_MODUS) != MODUS_HOMEY:
        return
    from .fjern import entiteter  # noqa: PLC0415
    async_add_entities(entiteter.lag("button", hass.data[DOMAIN][entry.entry_id]))
