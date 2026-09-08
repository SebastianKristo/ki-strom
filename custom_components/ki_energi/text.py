"""Tekst-innstillinger (erstatter input_text)."""
from __future__ import annotations

from homeassistant.components.text import TextEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_VARSEL_MOTTAKERE, DOMAIN, TEXTS
from .entity import KiHelper


class KiText(KiHelper, TextEntity):
    _attr_native_max = 255

    def __init__(self, hub, key, navn, standard, ikon) -> None:
        super().__init__(hub, "text", key, navn, standard, ikon)

    @property
    def native_value(self) -> str | None:
        return self.verdi

    async def async_set_value(self, value: str) -> None:
        self.sett_internt(value[:255])


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    entiteter = []
    for key, navn, ikon in TEXTS:
        std = hub.cfg(CONF_VARSEL_MOTTAKERE, "") if key == "ki_varsel_mottakere" else ""
        if key == "ki_tariff_tabell":
            from .const import TARIFF_TABELL_STANDARD  # noqa: PLC0415
            std = TARIFF_TABELL_STANDARD
        entiteter.append(KiText(hub, key, navn, std or "", ikon))
    async_add_entities(entiteter)
