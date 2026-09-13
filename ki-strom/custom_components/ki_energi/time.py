"""Klokkeslett-innstillinger (erstatter input_datetime uten dato)."""
from __future__ import annotations

from datetime import time as dtime

from homeassistant.components.time import TimeEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, TIMES
from .entity import KiHelper


def _parse(tekst: str) -> dtime:
    deler = str(tekst).split(":")
    return dtime(int(deler[0]), int(deler[1]), int(deler[2]) if len(deler) > 2 else 0)


class KiTime(KiHelper, TimeEntity):
    def __init__(self, hub, key, navn, standard, ikon) -> None:
        super().__init__(hub, "time", key, navn, _parse(standard), ikon)

    def fra_tekst(self, tekst):
        return _parse(tekst)

    @property
    def native_value(self) -> dtime | None:
        return self.verdi

    async def async_set_value(self, value: dtime) -> None:
        self.sett_internt(value)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    ent = [KiTime(hub, *t) for t in TIMES]
    from .const import PERSON_TIDER  # noqa: PLC0415
    for p in hub.personer():
        for suffiks, navn, std, ikon in PERSON_TIDER.get(p["type"], []):
            ent.append(KiTime(hub, f"ki_{p['key']}_{suffiks}", f"KI {p['navn']} {navn}", std, ikon))
    async_add_entities(ent)
