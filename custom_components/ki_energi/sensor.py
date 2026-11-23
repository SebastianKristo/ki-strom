"""Sensorer motoren skriver til."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SENSORS
from .const import CONF_MODUS, MODUS_HOMEY  # noqa: E402
from .entity import KiSensorBase


class KiSensor(KiSensorBase, SensorEntity):
    # Store lister som skrives hvert minutt. Kortet leser dem fra tilstanden, ikke historikken,
    # så recorder trenger dem ikke — der fylte de databasen med flere MB i døgnet.
    _unrecorded_attributes = frozenset({
        "laster", "tankegang", "linjer", "doegn", "regler", "entiteter", "soner",
    })

    def __init__(self, hub, key, navn, ikon, enhet, device_class, state_class) -> None:
        super().__init__(hub, "sensor", key, navn, ikon)
        self._attr_native_unit_of_measurement = enhet
        if device_class:
            self._attr_device_class = device_class
        if state_class:
            self._attr_state_class = state_class

    @property
    def native_value(self):
        return self._state


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    if entry.data.get(CONF_MODUS) == MODUS_HOMEY:
        from .fjern import entiteter  # noqa: PLC0415
        async_add_entities(entiteter.lag("sensor", hass.data[DOMAIN][entry.entry_id]))
        return
    hub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([KiSensor(hub, *s) for s in SENSORS])
