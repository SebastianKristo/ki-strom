"""Binærsensorer motoren skriver til."""
from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import BINARY_SENSORS, DOMAIN
from .entity import KiSensorBase


class KiBinarySensor(KiSensorBase, BinarySensorEntity):
    def __init__(self, hub, key, navn, ikon, device_class) -> None:
        super().__init__(hub, "binary_sensor", key, navn, ikon)
        if device_class:
            self._attr_device_class = device_class

    @property
    def is_on(self):
        if self._state is None:
            return None
        return bool(self._state)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([KiBinarySensor(hub, *s) for s in BINARY_SENSORS])
