"""Oppsett via UI: entiteter, husets data og soner."""
from __future__ import annotations

import re
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_AREAL, CONF_BYGGEAR, CONF_ENERGILEDD_DAG, CONF_ENERGILEDD_NATT, CONF_GARDINER,
    CONF_GLASS_M2, CONF_HANKLEVARMER, CONF_HANKLEVARMER_EFFEKT, CONF_HVITEVARER,
    CONF_IMPORTERT_ENERGI, CONF_KAPASITETSTRINN, CONF_NORDPOOL, CONF_NORGESPRIS_AKTIV, CONF_SONER,
    CONF_STROMPRIS, CONF_STUE_AREAL, CONF_TILSTEDE_CYBELE, CONF_TILSTEDE_RUNE,
    CONF_TILSTEDE_SEBASTIAN, CONF_TOPP1, CONF_TOPP2, CONF_TOPP3, CONF_TOTAL_EFFEKT, CONF_UTE_TEMP,
    CONF_VAER, CONF_VARSEL_MOTTAKERE, CONF_VVB_BRYTER, CONF_VVB_EFFEKT, DEFAULT_CONFIG,
    DEFAULT_SONER, DOMAIN, PROFILER, PROFIL_TEKST,
)


def _ent(domain, multiple=False):
    return selector.EntitySelector(selector.EntitySelectorConfig(domain=domain, multiple=multiple))


def _num(mn, mx, step=1, unit=None, mode="box"):
    konf = dict(min=mn, max=mx, step=step, mode=mode)
    if unit:
        konf["unit_of_measurement"] = unit
    return selector.NumberSelector(selector.NumberSelectorConfig(**konf))


def _tekst():
    return selector.TextSelector(selector.TextSelectorConfig())


def _notify(hass=None):
    """Flervalg av notify-tjenester (mobile_app_* først). Egne verdier tillatt."""
    navn: list[str] = []
    if hass is not None:
        navn = sorted(hass.services.async_services().get("notify", {}).keys())
    navn = [n for n in navn if n not in ("notify", "send_message", "persistent_notification")]
    navn.sort(key=lambda n: (not n.startswith("mobile_app_"), n))
    return selector.SelectSelector(selector.SelectSelectorConfig(
        options=[selector.SelectOptionDict(value=n, label=n.replace("mobile_app_", "📱 ").replace("_", " ")) for n in navn],
        multiple=True, custom_value=True, mode=selector.SelectSelectorMode.DROPDOWN))


def skjema_hus(hass=None) -> dict:
    return {
        vol.Required(CONF_AREAL, default=120): _num(20, 1000, 1, "m²"),
        vol.Required(CONF_BYGGEAR, default=1980): _num(1800, 2100, 1),
        vol.Required(CONF_GLASS_M2, default=20): _num(0, 200, 1, "m²"),
        vol.Required(CONF_STUE_AREAL, default=40): _num(5, 300, 1, "m²"),
        vol.Optional(CONF_VARSEL_MOTTAKERE, default=[]): _notify(hass),
    }


ALLE_DOMENER = ["sensor", "binary_sensor", "switch", "input_boolean", "person", "device_tracker", "group"]

SKJEMA_MALING = {
    vol.Required(CONF_TOTAL_EFFEKT): _ent("sensor"),
    vol.Required(CONF_IMPORTERT_ENERGI): _ent("sensor"),
    vol.Optional(CONF_UTE_TEMP): _ent("sensor"),
    vol.Optional(CONF_VAER): _ent("weather"),
}
SKJEMA_UTSTYR = {
    vol.Optional(CONF_VVB_BRYTER): _ent(["switch", "input_boolean"]),
    vol.Optional(CONF_VVB_EFFEKT): _ent("sensor"),
    vol.Optional(CONF_HANKLEVARMER): _ent("switch"),
    vol.Optional(CONF_HANKLEVARMER_EFFEKT): _ent("sensor"),
    vol.Optional(CONF_GARDINER): _ent("cover"),
    vol.Optional(CONF_HVITEVARER): _ent("sensor", multiple=True),
}
SKJEMA_PERSONER = {
    vol.Optional(CONF_TILSTEDE_CYBELE): _ent(ALLE_DOMENER),
    vol.Optional(CONF_TILSTEDE_SEBASTIAN): _ent(ALLE_DOMENER),
    vol.Optional(CONF_TILSTEDE_RUNE): _ent(ALLE_DOMENER),
}
SKJEMA_NETTLEIE = {
    vol.Optional(CONF_TOPP1): _ent("sensor"),
    vol.Optional(CONF_TOPP2): _ent("sensor"),
    vol.Optional(CONF_TOPP3): _ent("sensor"),
    vol.Optional(CONF_ENERGILEDD_DAG): _ent("sensor"),
    vol.Optional(CONF_ENERGILEDD_NATT): _ent("sensor"),
    vol.Optional(CONF_STROMPRIS): _ent("sensor"),
    vol.Optional(CONF_KAPASITETSTRINN): _ent("sensor"),
    vol.Optional(CONF_NORGESPRIS_AKTIV): _ent("binary_sensor"),
    vol.Optional(CONF_NORDPOOL): _ent("sensor"),
}
SKJEMA_HUS = skjema_hus()


def _rens(data: dict, skjema: dict | None = None) -> dict:
    """Tomme/utelatte valg lagres som tom streng, så hub.cfg gir '' i stedet for standard."""
    ut = {}
    if skjema:
        for k in skjema:
            ut[str(k)] = ""
    for k, v in data.items():
        ut[k] = v if v is not None else ""
    if "varsel_mottakere" in ut and not isinstance(ut["varsel_mottakere"], list):
        ut["varsel_mottakere"] = [x.strip() for x in str(ut["varsel_mottakere"]).split(",") if x.strip()]
    return ut


class KiEnergiConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            self._data.update(_rens(user_input, SKJEMA_MALING))
            return await self.async_step_utstyr()
        return self.async_show_form(step_id="user", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_MALING), {k: DEFAULT_CONFIG[k] for k in (CONF_TOTAL_EFFEKT, CONF_IMPORTERT_ENERGI, CONF_UTE_TEMP, CONF_VAER)}))

    async def async_step_utstyr(self, user_input=None):
        if user_input is not None:
            self._data.update(_rens(user_input, SKJEMA_UTSTYR))
            return await self.async_step_personer()
        return self.async_show_form(step_id="utstyr", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_UTSTYR), {k: DEFAULT_CONFIG[k] for k in (CONF_VVB_BRYTER, CONF_VVB_EFFEKT, CONF_HANKLEVARMER, CONF_HANKLEVARMER_EFFEKT)}))

    async def async_step_personer(self, user_input=None):
        if user_input is not None:
            self._data.update(_rens(user_input, SKJEMA_PERSONER))
            return await self.async_step_nettleie()
        return self.async_show_form(step_id="personer", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_PERSONER), {k: DEFAULT_CONFIG[k] for k in (CONF_TILSTEDE_CYBELE, CONF_TILSTEDE_SEBASTIAN, CONF_TILSTEDE_RUNE)}))

    async def async_step_nettleie(self, user_input=None):
        if user_input is not None:
            self._data.update(_rens(user_input, SKJEMA_NETTLEIE))
            return await self.async_step_hus()
        return self.async_show_form(step_id="nettleie", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_NETTLEIE), {k: DEFAULT_CONFIG[k] for k in (CONF_TOPP1, CONF_TOPP2, CONF_TOPP3, CONF_ENERGILEDD_DAG, CONF_ENERGILEDD_NATT, CONF_STROMPRIS, CONF_KAPASITETSTRINN, CONF_NORGESPRIS_AKTIV)}))

    async def async_step_hus(self, user_input=None):
        skjema = skjema_hus(self.hass)
        if user_input is not None:
            self._data.update(_rens(user_input, skjema))
            self._data[CONF_SONER] = {k: dict(v) for k, v in DEFAULT_SONER.items()}
            return self.async_create_entry(title="KI Energi", data=self._data)
        tilgjengelig = set(self.hass.services.async_services().get("notify", {}).keys())
        forslag = [m for m in DEFAULT_CONFIG[CONF_VARSEL_MOTTAKERE] if m in tilgjengelig]
        return self.async_show_form(step_id="hus", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(skjema), {CONF_VARSEL_MOTTAKERE: forslag}))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return KiEnergiOptionsFlow(config_entry)


class KiEnergiOptionsFlow(config_entries.OptionsFlow):
    def __init__(self, entry: config_entries.ConfigEntry) -> None:
        self._entry = entry
        self._sone_key: str | None = None

    # -- hjelpere --------------------------------------------------------
    def _gjeldende(self) -> dict:
        d = dict(self._entry.data)
        d.update(self._entry.options)
        return d

    def _soner(self) -> dict:
        g = self._gjeldende()
        soner = g.get(CONF_SONER) or DEFAULT_SONER
        return {k: dict(v) for k, v in soner.items()}

    def _lagre(self, endringer: dict, soner: dict | None = None):
        ny = dict(self._entry.options)
        ny.update(endringer)
        if soner is not None:
            ny[CONF_SONER] = soner
        elif CONF_SONER not in ny:
            ny[CONF_SONER] = self._soner()
        return self.async_create_entry(title="", data=ny)

    # -- meny ------------------------------------------------------------
    async def async_step_init(self, user_input=None):
        return self.async_show_menu(step_id="init", menu_options=["maling", "utstyr", "personer", "nettleie", "hus", "soner"])

    async def _enkelt_skjema(self, step_id: str, skjema: dict, user_input):
        if user_input is not None:
            return self._lagre(_rens(user_input, skjema))
        g = self._gjeldende()
        forslag = {str(k): g.get(str(k)) for k in skjema if g.get(str(k)) not in (None, "")}
        return self.async_show_form(step_id=step_id, data_schema=self.add_suggested_values_to_schema(vol.Schema(skjema), forslag))

    async def async_step_maling(self, user_input=None):
        return await self._enkelt_skjema("maling", SKJEMA_MALING, user_input)

    async def async_step_utstyr(self, user_input=None):
        return await self._enkelt_skjema("utstyr", SKJEMA_UTSTYR, user_input)

    async def async_step_personer(self, user_input=None):
        return await self._enkelt_skjema("personer", SKJEMA_PERSONER, user_input)

    async def async_step_nettleie(self, user_input=None):
        return await self._enkelt_skjema("nettleie", SKJEMA_NETTLEIE, user_input)

    async def async_step_hus(self, user_input=None):
        return await self._enkelt_skjema("hus", skjema_hus(self.hass), user_input)

    # -- soner -----------------------------------------------------------
    async def async_step_soner(self, user_input=None):
        soner = self._soner()
        if user_input is not None:
            valg = user_input["sone"]
            if valg == "__ny__":
                return await self.async_step_ny_sone()
            self._sone_key = valg
            return await self.async_step_sone()
        valg = [selector.SelectOptionDict(value=k, label=f"{v.get('navn', k)}  ({k})" + ("" if v.get("aktiv", True) else " — inaktiv"))
                for k, v in soner.items()]
        valg.append(selector.SelectOptionDict(value="__ny__", label="+ Legg til ny sone"))
        return self.async_show_form(step_id="soner", data_schema=vol.Schema({
            vol.Required("sone"): selector.SelectSelector(selector.SelectSelectorConfig(options=valg, mode="list"))}))

    async def async_step_ny_sone(self, user_input=None):
        errors = {}
        if user_input is not None:
            key = re.sub(r"[^a-z0-9_]", "_", user_input["key"].strip().lower())
            if not key or key in self._soner():
                errors["key"] = "finnes"
            else:
                self._sone_key = key
                soner = self._soner()
                soner[key] = dict(navn=user_input["navn"], rom=user_input["navn"], climate="", effekt="", duty="", temp="",
                                  type="panel", prio=3, nominell=1.0, sol=False, profil="fellesrom", aktiv=True,
                                  temp_dag=f"ki_temp_{key}_dag", temp_natt=f"ki_temp_{key}_natt", temp_borte="")
                self._ny_soner = soner
                return await self.async_step_sone()
        return self.async_show_form(step_id="ny_sone", data_schema=vol.Schema({
            vol.Required("key"): _tekst(), vol.Required("navn"): _tekst()}), errors=errors)

    async def async_step_sone(self, user_input=None):
        soner = getattr(self, "_ny_soner", None) or self._soner()
        key = self._sone_key
        s = soner[key]
        if user_input is not None:
            if user_input.get("slett"):
                soner.pop(key, None)
                return self._lagre({}, soner)
            s.update({
                "navn": user_input["navn"], "rom": user_input.get("rom") or user_input["navn"],
                "climate": user_input.get("climate") or "", "effekt": user_input.get("effekt") or "",
                "duty": user_input.get("duty") or "", "temp": user_input.get("temp") or "",
                "type": user_input["type"], "prio": int(user_input["prio"]),
                "nominell": float(user_input["nominell"]), "sol": bool(user_input.get("sol", False)),
                "profil": user_input["profil"], "aktiv": bool(user_input.get("aktiv", True)),
            })
            soner[key] = s
            return self._lagre({}, soner)
        skjema = vol.Schema({
            vol.Required("navn", default=s.get("navn", key)): _tekst(),
            vol.Optional("rom", default=s.get("rom", "")): _tekst(),
            vol.Optional("climate"): _ent("climate"),
            vol.Optional("effekt"): _ent("sensor"),
            vol.Optional("duty"): _ent("sensor"),
            vol.Optional("temp"): _ent("sensor"),
            vol.Required("type", default=s.get("type", "panel")): selector.SelectSelector(selector.SelectSelectorConfig(
                options=[selector.SelectOptionDict(value="panel", label="Panelovn (rask)"),
                         selector.SelectOptionDict(value="gulv", label="Gulvvarme (treg)")], mode="dropdown")),
            vol.Required("profil", default=s.get("profil", "fellesrom")): selector.SelectSelector(selector.SelectSelectorConfig(
                options=[selector.SelectOptionDict(value=p, label=PROFIL_TEKST[p]) for p in PROFILER], mode="dropdown")),
            vol.Required("prio", default=int(s.get("prio", 3))): _num(1, 5, 1, mode="slider"),
            vol.Required("nominell", default=float(s.get("nominell", 1.0))): _num(0.1, 5, 0.1, "kW"),
            vol.Required("sol", default=bool(s.get("sol", False))): selector.BooleanSelector(),
            vol.Required("aktiv", default=bool(s.get("aktiv", True))): selector.BooleanSelector(),
            vol.Optional("slett", default=False): selector.BooleanSelector(),
        })
        forslag = {k: s.get(k) for k in ("climate", "effekt", "duty", "temp") if s.get(k)}
        return self.async_show_form(step_id="sone", data_schema=self.add_suggested_values_to_schema(skjema, forslag),
                                    description_placeholders={"key": key, "navn": s.get("navn", key)})
