"""Henter appens tilstand fra Homey med jevne mellomrom."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .klient import HomeyAvvist, HomeyFeil, HomeyKlient

_LOGGER = logging.getLogger(__name__)

# Nøkkel i dataene → sti i API-et
KILDER = {
    "status": "/status",                        # strømkalkulatoren
    "motor": "/motor",                          # energimotoren og rommene
    "hus": "/hus",                              # modus, personer, bereder
    "innstillinger": "/innstillinger",
    "motorinnstillinger": "/motorinnstillinger",
    "husinnstillinger": "/husinnstillinger",
}


class HomeyKoordinator(DataUpdateCoordinator[dict[str, Any]]):
    def __init__(self, hass: HomeAssistant, klient: HomeyKlient, sekunder: int = 30) -> None:
        super().__init__(hass, _LOGGER, name="KI Energi (Homey)", update_interval=timedelta(seconds=max(10, sekunder)))
        self.klient = klient

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            svar = await asyncio.gather(*(self.klient.hent(sti) for sti in KILDER.values()))
        except HomeyAvvist as feil:
            raise ConfigEntryAuthFailed(str(feil)) from feil
        except HomeyFeil as feil:
            raise UpdateFailed(str(feil)) from feil
        return dict(zip(KILDER, svar))

    async def endre(self, metode: str, sti: str, kropp: dict | None = None) -> None:
        """Send en endring til Homey og hent ny tilstand med en gang (appen regner på nytt før den svarer)."""
        if metode == "PUT":
            await self.klient.sett(sti, kropp or {})
        else:
            await self.klient.send(sti, kropp)
        await self.async_refresh()

    def rom(self) -> list[dict]:
        return list(((self.data or {}).get("motor") or {}).get("soner") or [])

    def rominnstillinger(self) -> list[dict]:
        return list(((self.data or {}).get("motorinnstillinger") or {}).get("soner") or [])
