"""Tall-innstillinger (erstatter input_number fra pakken).

I tillegg til hjelperne per sone lages ett felles temperaturpunkt per **rom**. Et rom kan
ha flere varmekilder — stua har panelovn og oljefyr, kjøkkenet panelovn og gulvvarme — og
romtallet setter dagpunktet på alle sammen og sender temperaturen rett til klimaenhetene.
Da trenger ikke kortene i dashbordet en egen input_number per rom.
"""
from __future__ import annotations

import re

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, NUMBERS, Z_TEMP_BORTE, Z_TEMP_DAG, Z_TEMP_NATT
from .entity import KiHelper


def rom_slug(navn: str) -> str:
    t = str(navn or "").lower()
    for fra, til in (("ø", "o"), ("æ", "a"), ("å", "a"), ("ö", "o"), ("ä", "a")):
        t = t.replace(fra, til)
    return re.sub(r"[^a-z0-9]+", "_", t).strip("_")


def rom_med_soner(hub) -> dict[str, list[tuple[str, dict]]]:
    """Grupperer sonene på rom. Kjøkken med panelovn og gulvvarme blir ett rom med to."""
    ut: dict[str, list[tuple[str, dict]]] = {}
    for key, konf in (hub.soner() or {}).items():
        if not konf.get("aktiv", True):
            continue
        rom = (konf.get("rom") or konf.get("navn") or key).strip()
        if not rom:
            continue
        ut.setdefault(rom, []).append((key, konf))
    return ut


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


class KiRomTemp(KiHelper, NumberEntity):
    """Ett temperaturpunkt for hele rommet, uansett hvor mange varmekilder det har."""

    _attr_mode = NumberMode.BOX
    _attr_native_min_value = 5.0
    _attr_native_max_value = 30.0
    _attr_native_step = 0.5
    _attr_native_unit_of_measurement = "°C"

    def __init__(self, hub, rom: str, soner: list[tuple[str, dict]]) -> None:
        super().__init__(hub, "number", f"ki_rom_{rom_slug(rom)}_temp",
                         f"KI Temp {rom}", 21.0, "mdi:home-thermometer")
        self.rom = rom
        self._soner = soner

    def fra_tekst(self, tekst):
        return float(tekst)

    def _konf(self) -> list[tuple[str, dict]]:
        """Hent sonene på nytt hver gang – oppsettet kan ha endret seg."""
        return rom_med_soner(self.hub).get(self.rom, self._soner)

    def _klima(self) -> list[str]:
        ut: list[str] = []
        for _key, konf in self._konf():
            c = konf.get("climate")
            for e in ([c] if isinstance(c, str) else list(c or [])):
                if e and e not in ut:
                    ut.append(e)
        return ut

    @property
    def native_value(self) -> float | None:
        """Vårt eget tall hvis det er satt, ellers dagpunktet til første sone."""
        if self.verdi is not None:
            return float(self.verdi)
        for _key, konf in self._konf():
            hk = konf.get(Z_TEMP_DAG)
            v = self.hub.helpers.get(hk) if hk else None
            if v is not None and v.verdi is not None:
                return float(v.verdi)
        return None

    @property
    def extra_state_attributes(self) -> dict:
        kilder = []
        for key, konf in self._konf():
            kilder.append({
                "sone": key,
                "navn": konf.get("navn") or key,
                "type": konf.get("type") or "panel",
                "nominell_kw": konf.get("nominell"),
                "klima": konf.get("climate"),
            })
        return {"rom": self.rom, "kilder": kilder, "antall_kilder": len(kilder)}

    async def async_set_native_value(self, value: float) -> None:
        v = float(value)
        self.sett_internt(v)
        # Dagpunktet på hver sone i rommet, så motoren regner med den nye temperaturen
        for _key, konf in self._konf():
            hk = konf.get(Z_TEMP_DAG)
            if hk:
                self.hub.sett(hk, v)
        # ...og rett til klimaenhetene, så det merkes med en gang
        klima = self._klima()
        if klima:
            await self.hub.kall("climate", "set_temperature",
                                {"entity_id": klima, "temperature": v})


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    hub = hass.data[DOMAIN][entry.entry_id]
    kjente = {n[0] for n in NUMBERS}
    entiteter = [KiNumber(hub, *n) for n in NUMBERS]
    # Soner som er lagt til av brukeren og som ikke har ferdige temperaturhjelpere
    for konf in hub.soner().values():
        for felt, navn, std in ((Z_TEMP_DAG, "Dag", 21), (Z_TEMP_NATT, "Natt", 18), (Z_TEMP_BORTE, "Borte", 19)):
            hk = konf.get(felt) or ""
            if hk and hk not in kjente:
                kjente.add(hk)
                entiteter.append(KiNumber(hub, hk, f"KI Temp {konf['navn']} {navn}", 5, 30, 0.5, "°C", std, "mdi:thermometer"))

    # Ett felles punkt per rom. Rom med bare én sone får det også, så kortene kan bruke
    # samme entitetsnavn uansett hvor mange varmekilder rommet har.
    for rom, soner in rom_med_soner(hub).items():
        entiteter.append(KiRomTemp(hub, rom, soner))

    async_add_entities(entiteter)
