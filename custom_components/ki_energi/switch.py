"""Brytere (erstatter input_boolean fra pakken)."""
from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SWITCHES
from .entity import KiHelper


class KiSwitch(KiHelper, SwitchEntity):
    def __init__(self, hub, key, navn, standard, ikon) -> None:
        super().__init__(hub, "switch", key, navn, bool(standard), ikon)

    def fra_tekst(self, tekst):
        return tekst == "on"

    @property
    def is_on(self) -> bool:
        return bool(self.verdi)

    async def async_turn_on(self, **kwargs) -> None:
        self.sett_internt(True)
        if self.hub.moduser is not None:
            await self.hub.moduser.bryter_endret(self.key, True)

    async def async_turn_off(self, **kwargs) -> None:
        self.sett_internt(False)
        if self.hub.moduser is not None:
            await self.hub.moduser.bryter_endret(self.key, False)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    entiteter = [KiSwitch(hub, *s) for s in SWITCHES]
    from .const import PERSON_BRYTERE  # noqa: PLC0415
    for p in hub.personer():
        for suffiks, navn, std, ikon in PERSON_BRYTERE.get(p["type"], []):
            entiteter.append(KiSwitch(hub, f"ki_{p['key']}_{suffiks}", f"KI {p['navn']} {navn}", std, ikon))
    # Én "KI styrer"-bryter per sone
    for key, konf in hub.soner().items():
        entiteter.append(KiSwitch(hub, f"ki_styr_{key}", f"KI Styrer {konf['navn']}", True, "mdi:robot"))
    async_add_entities(entiteter)
