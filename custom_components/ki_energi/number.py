"""Tall-innstillinger (erstatter input_number fra pakken)."""
from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, NUMBERS, Z_TEMP_BORTE, Z_TEMP_DAG, Z_TEMP_NATT
from .entity import KiHelper


class KiNumber(KiHelper, NumberEntity):
    _attr_mode = NumberMode.BOX

    def __init__(self, hub, key, navn, mn, mx, steg, enhet, standard, ikon) -> None:
        super().__init__(hub, "number", key, navn, float(standard), ikon)
        self._attr_native_min_value = float(mn)
        self._attr_native_max_value = float(mx)
        self._attr_native_step = float(steg)
        self._attr_native_unit_of_measurement = enhet or None

    def fra_tekst(self, tekst):
        return float(tekst)

    @property
    def native_value(self) -> float | None:
        return None if self.verdi is None else float(self.verdi)

    async def async_set_native_value(self, value: float) -> None:
        self.sett_internt(float(value))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    kjente = {n[0] for n in NUMBERS}
    entiteter = [KiNumber(hub, *n) for n in NUMBERS]
    # Soner som er lagt til av brukeren og som ikke har ferdige temperaturhjelpere
    for key, konf in hub.soner().items():
        for felt, navn, std in ((Z_TEMP_DAG, "Dag", 21), (Z_TEMP_NATT, "Natt", 18), (Z_TEMP_BORTE, "Borte", 19)):
            hk = konf.get(felt) or ""
            if hk and hk not in kjente:
                kjente.add(hk)
                entiteter.append(KiNumber(hub, hk, f"KI Temp {konf['navn']} {navn}", 5, 30, 0.5, "°C", std, "mdi:thermometer"))
    async_add_entities(entiteter)
