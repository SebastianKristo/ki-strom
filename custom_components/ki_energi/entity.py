"""Felles entitetsklasser."""
from __future__ import annotations

from typing import Any

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DEVICE_NAME, DOMAIN, VERSION
from .hub import KiHub


def device_info(hub: KiHub) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, hub.entry.entry_id)},
        name=DEVICE_NAME,
        manufacturer="Sebastian Jemtland",
        model="KI klima- og energistyring",
        sw_version=VERSION,
    )


class KiEntity(Entity):
    """Basis: fast entitets-ID slik at kortet finner entitetene."""

    _attr_should_poll = False
    _attr_has_entity_name = False

    def __init__(self, hub: KiHub, domene: str, key: str, navn: str, ikon: str | None = None) -> None:
        self.hub = hub
        self.key = key
        self._attr_name = navn
        self._attr_icon = ikon
        self._attr_unique_id = f"{DOMAIN}_{key}"
        self.entity_id = f"{domene}.{key}"
        self._attr_device_info = device_info(hub)


class KiHelper(KiEntity, RestoreEntity):
    """Hjelperentitet (number/switch/time/datetime/text) med verdi som overlever restart."""

    def __init__(self, hub: KiHub, domene: str, key: str, navn: str, standard: Any, ikon: str | None = None) -> None:
        super().__init__(hub, domene, key, navn, ikon)
        self.verdi: Any = standard
        self._standard = standard

    def fra_tekst(self, tekst: str) -> Any:
        """Gjenopprett verdi fra lagret tilstandstekst. Overstyres per type."""
        return tekst

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        gammel = await self.async_get_last_state()
        if gammel is not None and gammel.state not in (None, "unknown", "unavailable"):
            try:
                self.verdi = self.fra_tekst(gammel.state)
            except Exception:  # noqa: BLE001
                self.verdi = self._standard
        self.hub.helpers[self.key] = self
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        self.hub.helpers.pop(self.key, None)
        await super().async_will_remove_from_hass()

    @callback
    def sett_internt(self, verdi: Any) -> None:
        self.verdi = verdi
        if self.hass is not None:
            self.async_write_ha_state()
        # Endringer i innstillinger skal merkes av motoren med en gang
        if self.hub.engine is not None:
            self.hub.engine.marker_endring(self.key)


class KiSensorBase(KiEntity):
    """Sensor motoren skriver til via hub.sett_sensor."""

    def __init__(self, hub: KiHub, domene: str, key: str, navn: str, ikon: str | None = None) -> None:
        super().__init__(hub, domene, key, navn, ikon)
        cached = hub.sensor_cache.get(key)
        self._state = cached[0] if cached else None
        self._attrs = cached[1] if cached else {}

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.hub.sensors[self.key] = self
        cached = self.hub.sensor_cache.get(self.key)
        if cached:
            self._state, self._attrs = cached
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        self.hub.sensors.pop(self.key, None)
        await super().async_will_remove_from_hass()

    @callback
    def oppdater(self, state: Any, attrs: dict) -> None:
        self._state = state
        self._attrs = attrs
        if self.hass is not None:
            self.async_write_ha_state()

    @property
    def extra_state_attributes(self) -> dict:
        return self._attrs
