"""KI Energi — intelligent klima- og energistyring for Home Assistant."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers.event import (
    async_call_later, async_track_state_change_event, async_track_time_change, async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from .const import (
    CONF_IMPORTERT_ENERGI,
    CONF_HANKLEVARMER_EFFEKT, CONF_HVITEVARER, CONF_TOTAL_EFFEKT, CONF_VVB_EFFEKT, DOMAIN, EFFEKTSENSOR_SEK,
    LAERING_MIN, PLATFORMS, TICK_SEK, TJENESTER,
)
from .engine import KiEngine
from .hub import KiHub
from .modes import KiModuser
from .nettleie import KiNettleie
from .sparing import KiSparing
from .prognose import KiPrognoselaering
from .lys import KiLys
from .lading import KiLading
from .vvb import KiVvb

_LOGGER = logging.getLogger(__name__)

SCHEMA_OVERSTYR = vol.Schema({
    vol.Required("sone"): str,
    vol.Required("temp"): vol.Coerce(float),
    vol.Optional("minutter", default=120): vol.Coerce(float),
})
SCHEMA_SONE = vol.Schema({vol.Optional("sone"): str})
SCHEMA_HVA = vol.Schema({vol.Optional("hva", default="alt"): vol.In(["alt", "profil", "tau"])})
SCHEMA_BOOST = vol.Schema({vol.Optional("minutter"): vol.Coerce(float)})
SCHEMA_HJEMKOMST = vol.Schema({vol.Optional("tid"): str, vol.Optional("naa", default=False): bool})
SCHEMA_STANDARD = vol.Schema({})


def _slug(tekst: str) -> str:
    import unicodedata  # noqa: PLC0415
    t = unicodedata.normalize("NFKD", tekst).encode("ascii", "ignore").decode().lower()
    t = t.replace("ø", "o").replace("æ", "ae").replace("å", "a")
    return "".join(c if c.isalnum() else "_" for c in t).strip("_") or "sone"


def _migrer_soner_til_rom(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """2.9.0: soner er rom, ikke ovner. Flere soner med samme rom (og samme type/profil) slås
    sammen til én sone med lister av climate/effekt. Kjøres én gang, markeres i options."""
    opts = dict(entry.options)
    if opts.get("soner_rom_migrert"):
        return
    soner = dict(opts.get("soner") or entry.data.get("soner") or {})
    if not soner:
        opts["soner_rom_migrert"] = True
        hass.config_entries.async_update_entry(entry, options=opts)
        return
    grupper: dict[tuple, list[str]] = {}
    for key, s in soner.items():
        rom = (s.get("rom") or s.get("navn") or key).strip().lower()
        grupper.setdefault((rom, s.get("type", "panel"), s.get("profil", "fellesrom")), []).append(key)
    nye: dict[str, dict] = {}
    endret = False
    for (rom, _t, _p), keys in grupper.items():
        if len(keys) == 1:
            nye[keys[0]] = soner[keys[0]]
            continue
        endret = True
        forste = soner[keys[0]]
        ny_key = _slug(forste.get("rom") or rom)
        if ny_key in soner and ny_key not in keys:
            ny_key = ny_key + "_rom"
        liste = lambda felt: [x for k in keys for x in ((soner[k].get(felt) if isinstance(soner[k].get(felt), list) else [soner[k].get(felt)]) or []) if x]  # noqa: E731,B023
        ny = dict(forste)
        ny.update(navn=forste.get("rom") or forste.get("navn"), climate=liste("climate"), effekt=liste("effekt"),
                  vindu=liste("vindu"), duty=next((soner[k].get("duty") for k in keys if soner[k].get("duty")), ""),
                  temp=next((soner[k].get("temp") for k in keys if soner[k].get("temp")), ""),
                  prio=min(int(soner[k].get("prio", 3)) for k in keys),
                  nominell=round(sum(float(soner[k].get("nominell", 1.0)) for k in keys), 2),
                  sol=any(bool(soner[k].get("sol")) for k in keys),
                  temp_dag=forste.get("temp_dag") or f"ki_temp_{ny_key}_dag",
                  temp_natt=forste.get("temp_natt") or f"ki_temp_{ny_key}_natt")
        nye[ny_key] = ny
        _LOGGER.info("ki_energi: slo sammen sonene %s til rommet «%s» (%s)", ", ".join(keys), ny["navn"], ny_key)
    opts["soner_rom_migrert"] = True
    if endret:
        opts["soner"] = nye
    hass.config_entries.async_update_entry(entry, options=opts)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    _migrer_soner_til_rom(hass, entry)
    hub = KiHub(hass, entry)
    await hub.last_minne()
    hub.engine = KiEngine(hub)
    hub.vvb = KiVvb(hub)
    hub.lading = KiLading(hub)
    hub.moduser = KiModuser(hub)
    hub.nettleie = KiNettleie(hub)
    hub.sparing = KiSparing(hub)
    hub.prognose = KiPrognoselaering(hub)
    hub.lys = KiLys(hub)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = hub

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_options_oppdatert))

    tick_laas = asyncio.Lock()

    async def _del(navn: str, koro) -> None:
        """Én del av ticket. Feiler den, logges det – og resten av ticket kjører likevel.

        Før lå moduser og bereder rett i rekkefølge foran motoren: en feil i én av dem
        stoppet hele ticket, og varmestyringen sto stille det minuttet uten at noe ble
        logget. Motoren har alltid hatt sin egen vakt; nå har de andre det også."""
        try:
            await koro
        except Exception as e:  # noqa: BLE001
            _LOGGER.exception("ki_energi: %s feilet i tick: %s", navn, e)
            hub.feil_i_tick[navn] = str(e)
        else:
            hub.feil_i_tick.pop(navn, None)

    async def _tick(_now=None):
        # Overlapp: et tick som venter på et tregt tjenestekall skal ikke få et nytt
        # oppå seg – da skriver to ticks settpunkter om hverandre. Det som pågår, får
        # gjøre seg ferdig; det neste minuttet tar igjen.
        if tick_laas.locked():
            hub.tick_hoppet_over += 1
            _LOGGER.warning("ki_energi: forrige tick pågår fortsatt – hopper over dette")
            return
        async with tick_laas:
            await _del("moduser", hub.moduser.tick())
            await _del("bereder", hub.vvb.tick())
            await _del("lys", hub.lys.tick())
            await hub.engine.tick()

    async def _laering(_now=None):
        await _del("læring", hub.engine.laering())

    async def _timeslutt(_now=None):
        await _del("timeslutt", hub.engine.timeslutt())

    async def _midnatt(_now=None):
        if dt_util.now().day == 1:
            await _del("månedsskifte", hub.engine.manedsskifte())

    # Effektsensoren kan melde flere ganger i sekundet (Tibber Pulse, smartplugger).
    # Integralet må ha hver eneste måling for å bli riktig, men de tre avledede
    # sensorene trenger ikke skrives oftere enn hvert annet sekund – ellers er det
    # tre tilstandsendringer i recorderen per måling, hele døgnet.
    sensor_timer: list = []

    @callback
    def _skriv_effektsensorer(_now=None):
        sensor_timer.clear()
        hub.engine.oppdater_effektsensorer()

    @callback
    def _effekt_endret(_event):
        hub.engine.integrer_effekt()
        if not sensor_timer:
            sensor_timer.append(async_call_later(hass, EFFEKTSENSOR_SEK, _skriv_effektsensorer))

    # Første tick litt etter oppstart, så alle hjelpere har gjenopprettet verdiene sine.
    hub.avmeld_ved_stopp(async_call_later(hass, 20, _tick))
    hub.avmeld_ved_stopp(async_track_time_interval(hass, _tick, timedelta(seconds=TICK_SEK)))
    hub.avmeld_ved_stopp(async_track_time_interval(hass, _laering, timedelta(minutes=LAERING_MIN)))
    # Timen lukkes på hele klokketimen (+5 s så registeret rekker å oppdatere), ikke kl. :59:30.
    hub.avmeld_ved_stopp(async_track_time_change(hass, _timeslutt, minute=0, second=5))
    # Energiregisteret prøves ved hver oppdatering, med sensorens eget tidsstempel.
    if hub.cfg(CONF_IMPORTERT_ENERGI):
        @callback
        def _energi_endret(event):
            hub.nettleie.prove_fra_state(event.data.get("new_state"))
        hub.avmeld_ved_stopp(async_track_state_change_event(hass, [hub.cfg(CONF_IMPORTERT_ENERGI)], _energi_endret))
    hub.avmeld_ved_stopp(async_track_time_change(hass, _midnatt, hour=0, minute=0, second=5))

    fulgt = [e for e in [hub.cfg(CONF_TOTAL_EFFEKT), hub.cfg(CONF_VVB_EFFEKT), hub.cfg(CONF_HANKLEVARMER_EFFEKT)] if e]
    fulgt += [k.get("effekt") for k in hub.aktive_soner().values() if k.get("effekt")]
    fulgt += list(hub.cfg(CONF_HVITEVARER, []) or [])
    if fulgt:
        hub.avmeld_ved_stopp(async_track_state_change_event(hass, fulgt, _effekt_endret))
    hub.avmeld_ved_stopp(hass.bus.async_listen("mobile_app_notification_action", hub.moduser.handling))

    _registrer_tjenester(hass)
    return True


async def _options_oppdatert(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hub: KiHub = hass.data[DOMAIN][entry.entry_id]
    await hub.stopp()
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    if not hass.data[DOMAIN]:
        for tj in TJENESTER:
            hass.services.async_remove(DOMAIN, tj)
    return ok


def _hub(hass: HomeAssistant) -> KiHub | None:
    huber = hass.data.get(DOMAIN, {})
    for h in huber.values():
        return h
    return None


def _registrer_tjenester(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, "overstyr"):
        return

    async def overstyr(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.engine.overstyr(call.data["sone"], call.data["temp"], call.data.get("minutter", 120))

    async def fjern_overstyring(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.engine.fjern_overstyring(call.data.get("sone"))

    async def nullstill_laering(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.engine.nullstill_laering(call.data.get("hva", "alt"))

    async def vvb_boost(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.vvb.boost(call.data.get("minutter"))

    async def vvb_avbryt_boost(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.vvb.avbryt_boost()

    async def vvb_tving_syklus(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.vvb.tving_syklus()

    async def hjemkomst(call: ServiceCall):
        hub = _hub(hass)
        if not hub:
            return
        if call.data.get("naa"):
            await hub.moduser.start_hjemkomst(dt_util.now() + timedelta(minutes=20), "Tjeneste: kommer hjem nå")
            return
        plan = None
        tid = call.data.get("tid")
        if tid:
            try:
                h, m = str(tid).split(":")[:2]
                plan = dt_util.now().replace(hour=int(h), minute=int(m), second=0, microsecond=0)
                if plan < dt_util.now():
                    plan += timedelta(days=1)
            except ValueError:
                plan = None
        await hub.moduser.start_hjemkomst(plan, "Tjeneste: hjemkomst")

    async def hjemkomst_ferdig(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.moduser.hjemkomst_ferdig("Avsluttet manuelt")

    async def helg_sporsmal(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.moduser.still_hjemkomstsporsmal()

    async def sett_standardverdier(call: ServiceCall):
        hub = _hub(hass)
        if not hub:
            return
        from .const import DATETIMES, NUMBERS, SWITCHES, TIMES  # noqa: PLC0415
        for key, _n, _mn, _mx, _st, _u, std, _i in NUMBERS:
            hub.sett(key, float(std))
        for key, _n, std, _i in SWITCHES:
            hub.sett(key, bool(std))
        from .time import _parse  # noqa: PLC0415
        for key, _n, std, _i in TIMES:
            hub.sett(key, _parse(std))
        for key in hub.aktive_soner():
            hub.sett(f"ki_styr_{key}", True)
        _ = DATETIMES
        hub.engine.logg_hendelse("Alle innstillinger satt til standardverdier.")
        await hub.engine.tick()

    async def leggetid(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.engine.leggetid(call.data["sone"], bool(call.data.get("avbryt", False)))

    async def nullstill_prognoselaering(call: ServiceCall):
        hub = _hub(hass)
        if hub and hub.prognose is not None:
            hub.prognose.nullstill()
            if hub.engine is not None:
                hub.engine.logg_hendelse("Prognoselæringen er nullstilt — fast reserve gjelder til nytt grunnlag er samlet.")

    async def sett_prio(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.engine.sett_prio(call.data["sone"], int(call.data["prio"]))

    async def tick(call: ServiceCall):
        hub = _hub(hass)
        if hub:
            await hub.moduser.tick()
            await hub.vvb.tick()
            await hub.engine.tick()

    # Én liste. Den samme brukes ved avlasting, så en ny tjeneste ikke kan bli glemt der.
    handlere = {
        "overstyr": (overstyr, SCHEMA_OVERSTYR),
        "leggetid": (leggetid, vol.Schema({vol.Required("sone"): str, vol.Optional("avbryt", default=False): bool})),
        "nullstill_prognoselaering": (nullstill_prognoselaering, SCHEMA_STANDARD),
        "sett_prio": (sett_prio, vol.Schema({vol.Required("sone"): str, vol.Required("prio"): vol.Coerce(int)})),
        "fjern_overstyring": (fjern_overstyring, SCHEMA_SONE),
        "nullstill_laering": (nullstill_laering, SCHEMA_HVA),
        "vvb_boost": (vvb_boost, SCHEMA_BOOST),
        "vvb_avbryt_boost": (vvb_avbryt_boost, SCHEMA_STANDARD),
        "vvb_tving_syklus": (vvb_tving_syklus, SCHEMA_STANDARD),
        "hjemkomst": (hjemkomst, SCHEMA_HJEMKOMST),
        "hjemkomst_ferdig": (hjemkomst_ferdig, SCHEMA_STANDARD),
        "helg_sporsmal": (helg_sporsmal, SCHEMA_STANDARD),
        "sett_standardverdier": (sett_standardverdier, SCHEMA_STANDARD),
        "tick": (tick, SCHEMA_STANDARD),
    }
    assert set(handlere) == set(TJENESTER), "TJENESTER i const.py må nevne alle tjenestene"
    for navn, (fn, skjema) in handlere.items():
        hass.services.async_register(DOMAIN, navn, fn, schema=skjema)
