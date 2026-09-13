"""Dato+tid-innstillinger (erstatter input_datetime med dato)."""
from __future__ import annotations

from datetime import datetime

from homeassistant.components.datetime import DateTimeEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DATETIMES, DOMAIN
from .entity import KiHelper


class KiDateTime(KiHelper, DateTimeEntity):
    def __init__(self, hub, key, navn, ikon) -> None:
        super().__init__(hub, "datetime", key, navn, None, ikon)

    def fra_tekst(self, tekst):
        v = dt_util.parse_datetime(tekst)
        if v is None:
            return None
        if v.tzinfo is None:
            v = dt_util.as_utc(v.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE))
        return v

    @property
    def native_value(self) -> datetime | None:
        return self.verdi

    async def async_set_value(self, value: datetime) -> None:
        self.sett_internt(value)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([KiDateTime(hub, *d) for d in DATETIMES])
