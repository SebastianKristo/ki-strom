"""Naven i integrasjonen: holder konfigurasjon, hjelpere, sensorer og lagring.

Alle motorene (energi, varmtvann, moduser) snakker med Home Assistant gjennom
denne klassen. Det gjør logikken testbar og holder I/O på ett sted.
"""
from __future__ import annotations

import logging
from datetime import datetime, time as dtime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_SONER, DEFAULT_CONFIG, DEFAULT_SONER, DOMAIN, Z_AKTIV, Z_PROFIL,
    Z_TEMP_BORTE, Z_TEMP_DAG, Z_TEMP_NATT,
)

_LOGGER = logging.getLogger(__name__)
STORE_VERSION = 1
UGYLDIG = (None, "unknown", "unavailable", "none", "")


class KiHub:
    """Delt tilstand for én konfigurasjonsoppføring."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.helpers: dict[str, Any] = {}     # nøkkel -> hjelperentitet
        self.sensors: dict[str, Any] = {}     # nøkkel -> sensor-/binærsensorentitet
        self.sensor_cache: dict[str, tuple[Any, dict]] = {}
        self.store = Store(hass, STORE_VERSION, f"{DOMAIN}.{entry.entry_id}.minne")
        self.minne: dict[str, Any] = {
            "profil": {}, "tau": {}, "state": {"overstyringer": {}, "rotasjon": 0},
            "logg": [], "vvb": {}, "moduser": {},
        }
        self.engine = None
        self.vvb = None
        self.moduser = None
        self._avmeldinger: list = []

    # ------------------------------------------------------------------
    #  Konfigurasjon
    # ------------------------------------------------------------------
    def cfg(self, key: str, default: Any = None) -> Any:
        """Options overstyrer data, data overstyrer standard."""
        if key in self.entry.options:
            return self.entry.options[key]
        if key in self.entry.data:
            return self.entry.data[key]
        if default is not None:
            return default
        return DEFAULT_CONFIG.get(key)

    def soner(self) -> dict[str, dict]:
        """Sonetabellen: lagrede soner fylt ut med standardfelt."""
        lagret = self.entry.options.get(CONF_SONER) or self.entry.data.get(CONF_SONER) or {}
        ut: dict[str, dict] = {}
        kilde = lagret if lagret else DEFAULT_SONER
        for key, konf in kilde.items():
            mal = DEFAULT_SONER.get(key, {})
            s = dict(mal)
            s.update(konf or {})
            s.setdefault("navn", key)
            s.setdefault("rom", key)
            s.setdefault("type", "panel")
            s.setdefault("prio", 3)
            # prioritet kan flyttes fra kortet — lagres i minnet, ikke i konfigurasjonen
            p_ov = (self.minne.get("state") or {}).get("prio_overstyring", {}).get(key)
            if p_ov is not None:
                s["prio"] = int(p_ov)
            s.setdefault("nominell", 1.0)
            s.setdefault("sol", False)
            s.setdefault(Z_PROFIL, "fellesrom")
            s.setdefault(Z_AKTIV, True)
            s.setdefault(Z_TEMP_DAG, f"ki_temp_{key}_dag")
            s.setdefault(Z_TEMP_NATT, f"ki_temp_{key}_natt")
            s.setdefault(Z_TEMP_BORTE, "")
            for felt in ("climate", "effekt", "duty", "temp"):
                s.setdefault(felt, "")
            ut[key] = s
        return ut

    def aktive_soner(self) -> dict[str, dict]:
        return {k: v for k, v in self.soner().items() if v.get(Z_AKTIV, True) and v.get("climate")}

    # ------------------------------------------------------------------
    #  Lagring
    # ------------------------------------------------------------------
    async def last_minne(self) -> None:
        data = await self.store.async_load()
        if isinstance(data, dict):
            for k in self.minne:
                if k in data and data[k] is not None:
                    self.minne[k] = data[k]
        self.minne["state"].setdefault("overstyringer", {})
        self.minne["state"].setdefault("rotasjon", 0)

    @callback
    def lagre(self, forsinket: bool = True) -> None:
        if forsinket:
            self.store.async_delay_save(lambda: self.minne, 15)
        else:
            self.hass.async_create_task(self.store.async_save(self.minne))

    async def lagre_naa(self) -> None:
        await self.store.async_save(self.minne)

    # ------------------------------------------------------------------
    #  Lesing av tilstand i Home Assistant
    # ------------------------------------------------------------------
    def st(self, entity_id: str | None) -> str | None:
        if not entity_id:
            return None
        s = self.hass.states.get(entity_id)
        if s is None or s.state in UGYLDIG:
            return None
        return s.state

    def f(self, entity_id: str | None, standard: float | None = None) -> float | None:
        v = self.st(entity_id)
        if v is None:
            return standard
        try:
            return float(v)
        except (TypeError, ValueError):
            return standard

    def attr(self, entity_id: str | None, navn: str, standard: Any = None) -> Any:
        if not entity_id:
            return standard
        s = self.hass.states.get(entity_id)
        if s is None:
            return standard
        v = s.attributes.get(navn, standard)
        return standard if v in UGYLDIG else v

    def pa(self, entity_id: str | None) -> bool:
        return self.st(entity_id) in ("on", "home", "true", "True")

    def finnes(self, entity_id: str | None) -> bool:
        return bool(entity_id) and self.st(entity_id) is not None

    def hjemme(self, entity_id: str | None) -> bool | None:
        """True/False hvis kjent, None hvis sensoren mangler."""
        v = self.st(entity_id)
        if v is None:
            return None
        return v in ("on", "home")

    # ------------------------------------------------------------------
    #  Hjelpere (number/switch/time/datetime/text-entitetene våre)
    # ------------------------------------------------------------------
    def h(self, key: str) -> Any:
        return self.helpers.get(key)

    def num(self, key: str, standard: float = 0.0) -> float:
        e = self.helpers.get(key)
        if e is None or e.verdi is None:
            return standard
        try:
            return float(e.verdi)
        except (TypeError, ValueError):
            return standard

    def on(self, key: str, standard: bool = False) -> bool:
        e = self.helpers.get(key)
        if e is None or e.verdi is None:
            return standard
        return bool(e.verdi)

    def tid_min(self, key: str, standard: str = "00:00") -> int:
        """Klokkeslett som minutter siden midnatt."""
        e = self.helpers.get(key)
        v = e.verdi if e is not None else None
        if isinstance(v, dtime):
            return v.hour * 60 + v.minute
        try:
            h, m = standard.split(":")[:2]
            return int(h) * 60 + int(m)
        except Exception:  # noqa: BLE001
            return 0

    def tid_str(self, key: str, standard: str = "00:00") -> str:
        m = self.tid_min(key, standard)
        return f"{m // 60:02d}:{m % 60:02d}"

    def dt(self, key: str) -> datetime | None:
        e = self.helpers.get(key)
        v = e.verdi if e is not None else None
        if isinstance(v, datetime):
            return dt_util.as_local(v)
        return None

    def tekst(self, key: str, standard: str = "") -> str:
        e = self.helpers.get(key)
        if e is None or e.verdi is None:
            return standard
        return str(e.verdi)

    @callback
    def sett(self, key: str, verdi: Any) -> None:
        """Sett en hjelper fra motoren (ikke fra brukeren)."""
        e = self.helpers.get(key)
        if e is None:
            _LOGGER.debug("ki_energi: hjelper %s finnes ikke", key)
            return
        e.sett_internt(verdi)

    @callback
    def tell(self, key: str, verdi: float) -> None:
        self.sett(key, round(self.num(key, 0.0) + verdi, 3))

    # ------------------------------------------------------------------
    #  Sensorer motoren skriver
    # ------------------------------------------------------------------
    @callback
    def sett_sensor(self, key: str, state: Any, attrs: dict | None = None) -> None:
        self.sensor_cache[key] = (state, attrs or {})
        e = self.sensors.get(key)
        if e is not None:
            e.oppdater(state, attrs or {})

    def sensor_state(self, key: str) -> Any:
        return self.sensor_cache.get(key, (None, {}))[0]

    def sensor_attr(self, key: str, navn: str, standard: Any = None) -> Any:
        return self.sensor_cache.get(key, (None, {}))[1].get(navn, standard)

    # ------------------------------------------------------------------
    #  Tjenestekall og varsling
    # ------------------------------------------------------------------
    async def kall(self, domene: str, tjeneste: str, data: dict) -> None:
        try:
            await self.hass.services.async_call(domene, tjeneste, data, blocking=False)
        except Exception as e:  # noqa: BLE001
            _LOGGER.warning("ki_energi: %s.%s feilet: %s", domene, tjeneste, e)

    def mottakere(self) -> list[str]:
        raa = self.cfg("varsel_mottakere", []) or []
        if isinstance(raa, str):
            raa = raa.split(",")
        ut = []
        for del_ in raa:
            d = str(del_).strip()
            if not d:
                continue
            if d.startswith("notify."):
                d = d[len("notify."):]
            ut.append(d)
        return ut

    async def varsle(self, tittel: str, melding: str, aksjoner: list[dict] | None = None,
                     tag: str | None = None, alltid: bool = False, kategori: str | None = None) -> None:
        """Send varsel til alle mottakere. `alltid` omgår både hovedbryteren og kategoribryteren
        (brukes bare for kritiske feil). `kategori` peker på switch.ki_varsel_<kategori>."""
        if not alltid:
            if not self.on("ki_energi_varsler", True):
                return
            if kategori and not self.on(f"ki_varsel_{kategori}", True):
                return
        data: dict[str, Any] = {}
        if aksjoner:
            data["actions"] = aksjoner
        if tag:
            data["tag"] = tag
        for m in self.mottakere():
            payload = {"title": tittel, "message": melding}
            if data:
                payload["data"] = data
            await self.kall("notify", m, payload)
        # Persistent notification som reserve hvis ingen mottakere er satt
        if not self.mottakere():
            await self.kall("persistent_notification", "create",
                            {"title": tittel, "message": melding, "notification_id": tag or f"{DOMAIN}_{tittel}"})

    async def logbook(self, navn: str, melding: str, entity_id: str | None = None) -> None:
        data = {"name": navn, "message": melding}
        if entity_id:
            data["entity_id"] = entity_id
        await self.kall("logbook", "log", data)

    # ------------------------------------------------------------------
    #  Tid
    # ------------------------------------------------------------------
    @staticmethod
    def naa() -> datetime:
        return dt_util.now()

    @staticmethod
    def naa_min() -> int:
        n = dt_util.now()
        return n.hour * 60 + n.minute

    @staticmethod
    def mellom(start_min: int, slutt_min: int, naa: int | None = None) -> bool:
        naa = KiHub.naa_min() if naa is None else naa
        if start_min <= slutt_min:
            return start_min <= naa < slutt_min
        return naa >= start_min or naa < slutt_min

    @staticmethod
    def i_manedsvindu(start: int, slutt: int, maned: int | None = None) -> bool:
        m = maned or dt_util.now().month
        if start <= slutt:
            return start <= m <= slutt
        return m >= start or m <= slutt

    def avmeld_ved_stopp(self, fn) -> None:
        self._avmeldinger.append(fn)

    async def stopp(self) -> None:
        for fn in self._avmeldinger:
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass
        self._avmeldinger.clear()
        await self.lagre_naa()


def timedelta_min(m: float) -> timedelta:
    return timedelta(minutes=m)
