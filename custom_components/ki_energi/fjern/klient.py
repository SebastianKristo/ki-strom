"""Klient mot KI Energi-appens lokale API på Homey."""
from __future__ import annotations

import asyncio
from typing import Any

import aiohttp

APP_ID = "no.kristo.kienergi"
TIDSAVBRUDD = aiohttp.ClientTimeout(total=15)


class HomeyFeil(Exception):
    """Homey svarte ikke, eller svarte med en feil."""


class HomeyAvvist(HomeyFeil):
    """API-nøkkelen ble ikke godtatt."""


class HomeyManglerApp(HomeyFeil):
    """Homey svarer, men KI Energi-appen er ikke installert eller kjører ikke."""


def grunnadresse(host: str) -> str:
    """«192.168.1.20», «homey.local/» eller «https://…» → adresse uten avsluttende skråstrek."""
    h = (host or "").strip().rstrip("/")
    if not h.startswith(("http://", "https://")):
        h = "http://" + h
    return h


class HomeyKlient:
    def __init__(self, sesjon: aiohttp.ClientSession, host: str, token: str) -> None:
        self._sesjon = sesjon
        self._rot = f"{grunnadresse(host)}/api/app/{APP_ID}"
        self._hode = {"Authorization": f"Bearer {(token or '').strip()}"}

    async def _kall(self, metode: str, sti: str, kropp: dict | None = None) -> Any:
        try:
            async with self._sesjon.request(metode, self._rot + sti, json=kropp, headers=self._hode, timeout=TIDSAVBRUDD) as svar:
                if svar.status in (401, 403):
                    raise HomeyAvvist("API-nøkkelen ble ikke godtatt")
                if svar.status == 404:
                    raise HomeyManglerApp("KI Energi-appen svarer ikke på Homey")
                if svar.status >= 400:
                    raise HomeyFeil(f"Homey svarte {svar.status}: {(await svar.text())[:200]}")
                return await svar.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError) as feil:
            raise HomeyFeil(f"Får ikke kontakt med Homey: {feil}") from feil

    async def hent(self, sti: str) -> Any:
        return await self._kall("GET", sti)

    async def sett(self, sti: str, kropp: dict) -> Any:
        return await self._kall("PUT", sti, kropp)

    async def send(self, sti: str, kropp: dict | None = None) -> Any:
        return await self._kall("POST", sti, kropp or {})
