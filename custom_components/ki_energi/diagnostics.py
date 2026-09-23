"""Diagnostikk: Innstillinger → Enheter → KI Energi → Last ned diagnostikk.

Gir alt som trengs for å feilsøke uten å be om skjermbilder: oppsettet, det motoren
sist regnet ut, sensorene slik de står, minnet (læringen) og helsen til ticket.
Varselmottakerne strykes – det er de eneste personlige dataene.
"""
from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import DOMAIN

TIL_STRYKING = {"varsel_mottakere"}


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    hub = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    ut: dict[str, Any] = {
        "versjon": entry.version,
        "data": async_redact_data(dict(entry.data), TIL_STRYKING),
        "options": async_redact_data(dict(entry.options), TIL_STRYKING),
    }
    if hub is None:
        ut["feil"] = "Integrasjonen er ikke lastet"
        return ut

    motor = getattr(hub, "engine", None)
    ut["helse"] = {
        "naa": dt_util.now().isoformat(),
        "siste_tick": getattr(motor, "siste_tick", None) and motor.siste_tick.isoformat(),
        "feil_i_tick": dict(getattr(hub, "feil_i_tick", {})),
        "ticks_hoppet_over": getattr(hub, "tick_hoppet_over", 0),
    }
    ut["sensorer"] = {
        nokkel: {"state": verdi, "attributes": attrs}
        for nokkel, (verdi, attrs) in sorted(getattr(hub, "sensor_cache", {}).items())
    }
    # Kildeentitetene slik Home Assistant ser dem nå – de fleste feil er en kilde som
    # står utilgjengelig eller melder i feil enhet.
    kilder: dict[str, Any] = {}
    for nokkel in ("total_effekt", "importert_energi", "ute_temp", "vaer", "topp1", "topp2", "topp3",
                   "vvb_bryter", "vvb_effekt", "hanklevarmer_effekt"):
        eid = hub.cfg(nokkel) if hasattr(hub, "cfg") else None
        if eid:
            st = hass.states.get(eid)
            kilder[nokkel] = {"entity_id": eid, "state": st.state if st else None,
                              "unit": (st.attributes.get("unit_of_measurement") if st else None),
                              "last_updated": st.last_updated.isoformat() if st else None}
    ut["kilder"] = kilder
    try:
        ut["minne"] = await hub.store.async_load()
    except Exception as e:  # noqa: BLE001
        ut["minne"] = f"kunne ikke lese: {e}"
    return ut
