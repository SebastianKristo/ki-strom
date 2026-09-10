"""Oppsett via UI: entiteter, husets data og soner."""
from __future__ import annotations

import re
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from . import oppdag
from .const import (
    CONF_AREAL, CONF_BYGGEAR, CONF_ENERGILEDD_DAG, CONF_ENERGILEDD_NATT, CONF_GARDINER,
    CONF_GLASS_M2, CONF_HANKLEVARMER, CONF_HANKLEVARMER_EFFEKT, CONF_HVITEVARER,
    CONF_HAR_ELBIL, CONF_HUSTYPE, CONF_PERSONER, CONF_PRESET, LEGACY_PERSONER, PERSONTYPER, PRESETS, PROFIL_LEGACY,
    CONF_IMPORTERT_ENERGI, CONF_KAPASITETSTRINN, CONF_NORDPOOL, CONF_NORGESPRIS_AKTIV, CONF_SONER,
    CONF_STROMPRIS, CONF_STUE_AREAL, CONF_TILSTEDE_CYBELE, CONF_TILSTEDE_RUNE,
    CONF_TILSTEDE_SEBASTIAN, CONF_TOPP1, CONF_TOPP2, CONF_TOPP3, CONF_TOTAL_EFFEKT, CONF_UTE_TEMP,
    CONF_VAER, CONF_VARSEL_MOTTAKERE, CONF_VVB_BRYTER, CONF_VVB_EFFEKT, DEFAULT_CONFIG,
    DEFAULT_SONER, DOMAIN, PROFILER, PROFIL_TEKST,
)


def _ent(domain, multiple=False, device_class=None):
    konf = dict(domain=domain, multiple=multiple)
    if device_class:
        konf["device_class"] = device_class
    return selector.EntitySelector(selector.EntitySelectorConfig(**konf))


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
        vol.Required(CONF_HUSTYPE, default="bolig"): selector.SelectSelector(selector.SelectSelectorConfig(
            options=[selector.SelectOptionDict(value="bolig", label="Bolig — noen bor her fast"),
                     selector.SelectOptionDict(value="fritidsbolig", label="Fritidsbolig — tom mesteparten av tiden, frostsikring når ingen er der")],
            mode="dropdown")),
        vol.Required(CONF_AREAL, default=120): _num(20, 1000, 1, "m²"),
        vol.Required(CONF_BYGGEAR, default=1980): _num(1800, 2100, 1),
        vol.Required(CONF_GLASS_M2, default=20): _num(0, 200, 1, "m²"),
        vol.Required(CONF_STUE_AREAL, default=40): _num(5, 300, 1, "m²"),
        vol.Optional(CONF_VARSEL_MOTTAKERE, default=[]): _notify(hass),
    }


ALLE_DOMENER = ["sensor", "binary_sensor", "switch", "input_boolean", "person", "device_tracker", "group"]

SKJEMA_MALING = {
    vol.Required(CONF_TOTAL_EFFEKT): _ent("sensor", device_class="power"),
    vol.Required(CONF_IMPORTERT_ENERGI): _ent("sensor", device_class="energy"),
    vol.Optional(CONF_UTE_TEMP): _ent("sensor", device_class="temperature"),
    vol.Optional(CONF_VAER): _ent("weather"),
}
SKJEMA_UTSTYR = {
    vol.Optional(CONF_VVB_BRYTER): _ent(["switch", "input_boolean"]),
    vol.Optional(CONF_VVB_EFFEKT): _ent("sensor", device_class="power"),
    vol.Optional(CONF_HANKLEVARMER): _ent("switch"),
    vol.Optional(CONF_HANKLEVARMER_EFFEKT): _ent("sensor", device_class="power"),
    vol.Optional(CONF_GARDINER): _ent("cover"),
    vol.Optional(CONF_HVITEVARER): _ent("sensor", multiple=True, device_class="power"),
    vol.Optional(CONF_HAR_ELBIL, default=False): selector.BooleanSelector(),
}
SKJEMA_PERSONER = {
    vol.Optional(CONF_TILSTEDE_CYBELE): _ent(ALLE_DOMENER),
    vol.Optional(CONF_TILSTEDE_SEBASTIAN): _ent(ALLE_DOMENER),
    vol.Optional(CONF_TILSTEDE_RUNE): _ent(ALLE_DOMENER),
}
ANTALL_PERSONRADER = 4


def _persontype():
    return selector.SelectSelector(selector.SelectSelectorConfig(
        options=[selector.SelectOptionDict(value=k, label=v) for k, v in PERSONTYPER.items()], mode="dropdown"))


def skjema_personer_rader() -> dict:
    """Første oppsett: inntil fire personer på én side. Flere legges til under Konfigurer."""
    ut = {}
    for i in range(1, ANTALL_PERSONRADER + 1):
        ut[vol.Optional(f"navn_{i}")] = _tekst()
        ut[vol.Optional(f"type_{i}", default="voksen")] = _persontype()
        ut[vol.Optional(f"tilstede_{i}")] = _ent(ALLE_DOMENER)
        ut[vol.Optional(f"sover_{i}")] = _ent("binary_sensor")
    return ut


def personer_fra_rader(data: dict) -> list[dict]:
    ut = []
    for i in range(1, ANTALL_PERSONRADER + 1):
        navn = (data.get(f"navn_{i}") or "").strip()
        if not navn:
            continue
        key = oppdag.slug(navn)
        if any(p["key"] == key for p in ut):
            key = f"{key}_{i}"
        ut.append({"key": key, "navn": navn, "type": data.get(f"type_{i}") or "voksen", "entity": data.get(f"tilstede_{i}") or "",
                   "sover": data.get(f"sover_{i}") or ""})
    return ut


def profilvalg(personer: list[dict]):
    valg = [selector.SelectOptionDict(value=p, label=PROFIL_TEKST[p]) for p in PROFILER]
    for p in personer:
        valg.append(selector.SelectOptionDict(value=f"person:{p['key']}",
                                              label=f"{p['navn']}s rom ({PERSONTYPER[p['type']].split(' — ')[0].lower()})"))
    return selector.SelectSelector(selector.SelectSelectorConfig(options=valg, mode="dropdown"))
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


def _valider_maling(hass, data: dict) -> dict[str, str]:
    """Sjekk at målesensorene faktisk er det de skal være. Returnerer feil per felt."""
    feil: dict[str, str] = {}
    st = hass.states.get(data.get(CONF_TOTAL_EFFEKT) or "")
    if st is None:
        feil[CONF_TOTAL_EFFEKT] = "finnes_ikke"
    elif str(st.attributes.get("unit_of_measurement") or "") not in ("W", "kW"):
        feil[CONF_TOTAL_EFFEKT] = "ikke_effekt"
    st = hass.states.get(data.get(CONF_IMPORTERT_ENERGI) or "")
    if st is None:
        feil[CONF_IMPORTERT_ENERGI] = "finnes_ikke"
    elif st.attributes.get("state_class") not in ("total_increasing", "total") \
            or str(st.attributes.get("unit_of_measurement") or "") not in ("kWh", "Wh", "MWh"):
        feil[CONF_IMPORTERT_ENERGI] = "ikke_register"
    return feil


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

    def _forslag(self, *keys):
        """Forslag til feltverdier. Rekkefølge: preset → standard → automatisk gjenkjenning.
        En preset-/standardverdi som ikke finnes i denne Home Assistant-en byttes ut med det vi fant."""
        preset = PRESETS.get(self._data.get(CONF_PRESET, "bolig"), PRESETS["bolig"])
        funnet = getattr(self, "_funnet", None)
        if funnet is None:
            funnet = self._funnet = oppdag.forslag_alle(self.hass)
        ut = {}
        for k in keys:
            v = preset["config"].get(k, DEFAULT_CONFIG.get(k))
            if isinstance(v, str) and v.startswith(("sensor.", "switch.", "binary_sensor.", "climate.", "person.", "weather.", "cover.")) \
                    and self.hass.states.get(v) is None:
                v = funnet.get(k, "")
            if v in (None, "") and k in funnet:
                v = funnet[k]
            if v not in (None, ""):
                ut[k] = v
        return ut

    async def async_step_user(self, user_input=None):
        """Første steg: velg hus (preset). Alt etterpå fylles med forslag fra valget."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            self._data[CONF_PRESET] = user_input[CONF_PRESET]
            self._data[CONF_HUSTYPE] = PRESETS[user_input[CONF_PRESET]]["hustype"]
            return await self.async_step_maling()
        return self.async_show_form(step_id="user", data_schema=vol.Schema({
            vol.Required(CONF_PRESET, default="bolig"): selector.SelectSelector(selector.SelectSelectorConfig(
                options=[selector.SelectOptionDict(value=k, label=p["navn"] + (" — " + p["beskrivelse"] if p["beskrivelse"] else ""))
                         for k, p in PRESETS.items() if k in ("bolig", "hytte", "tom")], mode="list"))}))

    async def async_step_maling(self, user_input=None):
        feil = {}
        if user_input is not None:
            feil = _valider_maling(self.hass, user_input)
            if not feil:
                self._data.update(_rens(user_input, SKJEMA_MALING))
                return await self.async_step_utstyr()
        forslag = user_input or self._forslag(CONF_TOTAL_EFFEKT, CONF_IMPORTERT_ENERGI, CONF_UTE_TEMP, CONF_VAER)
        funnet = getattr(self, "_funnet", {}) or {}
        return self.async_show_form(step_id="maling", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_MALING), forslag), errors=feil,
            description_placeholders={"funnet": ", ".join(f"{k} → {v}" for k, v in funnet.items()
                                                          if k in ("total_effekt", "importert_energi", "ute_temp", "vaer")) or "ingenting"})

    async def async_step_utstyr(self, user_input=None):
        if user_input is not None:
            self._data.update(_rens(user_input, SKJEMA_UTSTYR))
            return await self.async_step_personer()
        return self.async_show_form(step_id="utstyr", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_UTSTYR), {**self._forslag(CONF_VVB_BRYTER, CONF_VVB_EFFEKT, CONF_HANKLEVARMER, CONF_HANKLEVARMER_EFFEKT),
                                        CONF_HAR_ELBIL: bool(PRESETS.get(self._data.get(CONF_PRESET, "bolig"), PRESETS["bolig"])["config"].get(CONF_HAR_ELBIL, False))}))

    async def async_step_personer(self, user_input=None):
        preset = PRESETS.get(self._data.get(CONF_PRESET, "bolig"), PRESETS["bolig"])
        if user_input is not None:
            self._data[CONF_PERSONER] = personer_fra_rader(user_input)
            return await self.async_step_nettleie()
        forslag = {}
        for i, p in enumerate(preset.get("personer", [])[:ANTALL_PERSONRADER], start=1):
            forslag[f"navn_{i}"] = p["navn"]
            forslag[f"type_{i}"] = p["type"]
            ent = p.get("entity") or ""
            if ent and self.hass.states.get(ent) is None:
                ent = oppdag.finn_person(self.hass, p["navn"]) or ""
            if ent:
                forslag[f"tilstede_{i}"] = ent
        return self.async_show_form(step_id="personer", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(skjema_personer_rader()), forslag))

    async def async_step_nettleie(self, user_input=None):
        if user_input is not None:
            self._data.update(_rens(user_input, SKJEMA_NETTLEIE))
            return await self.async_step_hus()
        return self.async_show_form(step_id="nettleie", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(SKJEMA_NETTLEIE), self._forslag(CONF_TOPP1, CONF_TOPP2, CONF_TOPP3, CONF_ENERGILEDD_DAG, CONF_ENERGILEDD_NATT, CONF_STROMPRIS, CONF_KAPASITETSTRINN, CONF_NORGESPRIS_AKTIV)))

    async def async_step_hus(self, user_input=None):
        skjema = skjema_hus(self.hass)
        preset = PRESETS.get(self._data.get(CONF_PRESET, "bolig"), PRESETS["bolig"])
        if user_input is not None:
            self._data.update(_rens(user_input, skjema))
            return await self.async_step_soner_auto()
        tilgjengelig = set(self.hass.services.async_services().get("notify", {}).keys())
        forslag = self._forslag(CONF_AREAL, CONF_BYGGEAR, CONF_GLASS_M2, CONF_STUE_AREAL)
        forslag[CONF_VARSEL_MOTTAKERE] = [m for m in DEFAULT_CONFIG[CONF_VARSEL_MOTTAKERE] if m in tilgjengelig]
        forslag[CONF_HUSTYPE] = preset["hustype"]
        return self.async_show_form(step_id="hus", data_schema=self.add_suggested_values_to_schema(
            vol.Schema(skjema), forslag))

    async def async_step_soner_auto(self, user_input=None):
        """Siste steg: lag soner fra Home Assistant-områdene (én per rom med termostat), eller bruk presetets."""
        preset = PRESETS.get(self._data.get(CONF_PRESET, "bolig"), PRESETS["bolig"])
        funnet = oppdag.soner_fra_omrader(self.hass)
        if user_input is not None:
            valgt = user_input.get("soner") or []
            if user_input.get("kilde") == "omrader" and valgt:
                self._data[CONF_SONER] = {k: dict(funnet[k]) for k in valgt if k in funnet}
            else:
                self._data[CONF_SONER] = {k: dict(v) for k, v in preset["soner"].items()}
            tittel = "KI Energi" if self._data.get(CONF_HUSTYPE, preset["hustype"]) == "bolig" else "KI Energi (hytte)"
            return self.async_create_entry(title=tittel, data=self._data)
        valg = [selector.SelectOptionDict(value=k, label=f"{v['navn']} — {len(v['climate'])} termostat(er), "
                                          f"{len(v['effekt'])} effektsensor(er), {v['type']}, profil {v['profil']}")
                for k, v in sorted(funnet.items())]
        skjema = vol.Schema({
            vol.Required("kilde", default="omrader" if funnet else "preset"): selector.SelectSelector(selector.SelectSelectorConfig(
                options=[selector.SelectOptionDict(value="omrader", label=f"Lag soner fra områdene mine ({len(funnet)} funnet)"),
                         selector.SelectOptionDict(value="preset", label=f"Bruk sonene fra «{preset['navn']}» og rett dem opp etterpå")],
                mode="list")),
            vol.Optional("soner", default=[k for k in funnet]): selector.SelectSelector(selector.SelectSelectorConfig(
                options=valg or [selector.SelectOptionDict(value="_", label="Ingen områder med termostater funnet")], multiple=True, mode="list")),
        })
        return self.async_show_form(step_id="soner_auto", data_schema=skjema,
                                    description_placeholders={"antall": str(len(funnet))})

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
        g = self._gjeldende()
        mangler = []
        for k, navn in ((CONF_TOTAL_EFFEKT, "effektmåler"), (CONF_IMPORTERT_ENERGI, "energiregister"), (CONF_UTE_TEMP, "utetemperatur"),
                        (CONF_VVB_BRYTER, "bereder-bryter"), (CONF_TOPP1, "toppsensor 1"), (CONF_NORDPOOL, "spotpris (Nord Pool)")):
            v = g.get(k)
            if not v or self.hass.states.get(v) is None:
                mangler.append(navn)
        soner = self._soner()
        dode = [s["navn"] for s in soner.values()
                if not any(self.hass.states.get(c) for c in (s.get("climate") if isinstance(s.get("climate"), list) else [s.get("climate")]) if c)]
        status = f"{len(soner)} soner" + (f" — termostat svarer ikke i: {', '.join(dode)}" if dode else "") \
            + (f". Ikke satt opp: {', '.join(mangler)}" if mangler else ". Alt er koblet.")
        return self.async_show_menu(step_id="init", menu_options=["maling", "utstyr", "personer", "nettleie", "hus", "soner", "soner_auto"],
                                    description_placeholders={"status": status})

    async def async_step_soner_auto(self, user_input=None):
        """Lag/oppdater soner fra HA-områdene. Eksisterende soner med samme nøkkel beholder egne innstillinger."""
        funnet = oppdag.soner_fra_omrader(self.hass)
        if user_input is not None:
            soner = self._soner()
            for k in user_input.get("soner") or []:
                if k not in funnet:
                    continue
                ny = dict(funnet[k])
                if k in soner and not user_input.get("overskriv"):
                    gammel = soner[k]
                    for felt in ("type", "prio", "nominell", "sol", "profil", "aktiv", "navn"):
                        ny[felt] = gammel.get(felt, ny[felt])
                soner[k] = ny
            return self._lagre({}, soner)
        valg = [selector.SelectOptionDict(value=k, label=f"{v['navn']} — {len(v['climate'])} termostat(er), {len(v['effekt'])} effektsensor(er), {v['type']}")
                for k, v in sorted(funnet.items())]
        if not valg:
            return self.async_abort(reason="ingen_omrader")
        return self.async_show_form(step_id="soner_auto", data_schema=vol.Schema({
            vol.Optional("soner", default=list(funnet)): selector.SelectSelector(selector.SelectSelectorConfig(options=valg, multiple=True, mode="list")),
            vol.Optional("overskriv", default=False): selector.BooleanSelector(),
        }), description_placeholders={"antall": str(len(funnet))})

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

    def _personer(self) -> list[dict]:
        g = self._gjeldende()
        liste = g.get(CONF_PERSONER)
        if isinstance(liste, list):
            return [dict(p) for p in liste]
        ut = []
        for p in LEGACY_PERSONER:
            if g.get(f"tilstede_{p['key']}"):
                ut.append({"key": p["key"], "navn": p["key"].capitalize(), "type": p["type"], "entity": g.get(f"tilstede_{p['key']}"), "sover": ""})
        return ut

    async def async_step_personer(self, user_input=None):
        personer = self._personer()
        if user_input is not None:
            valg = user_input["person"]
            if valg == "__ny__":
                return await self.async_step_ny_person()
            self._person_key = valg
            return await self.async_step_person()
        valg = [selector.SelectOptionDict(value=p["key"], label=f"{p['navn']} — {PERSONTYPER[p['type']].split(' — ')[0]}"
                                          + (f" — {p['entity']}" if p.get("entity") else " — ingen tilstedeværelse"))
                for p in personer]
        valg.append(selector.SelectOptionDict(value="__ny__", label="＋ Legg til person"))
        return self.async_show_form(step_id="personer", data_schema=vol.Schema({
            vol.Required("person"): selector.SelectSelector(selector.SelectSelectorConfig(options=valg, mode="list"))}))

    async def async_step_ny_person(self, user_input=None):
        if user_input is not None:
            navn = user_input["navn"].strip()
            key = oppdag.slug(navn)
            personer = self._personer()
            if any(p["key"] == key for p in personer):
                key += "_2"
            personer.append({"key": key, "navn": navn, "type": user_input["type"], "entity": user_input.get("tilstede") or "",
                             "sover": user_input.get("sover") or ""})
            return self._lagre({CONF_PERSONER: personer})
        return self.async_show_form(step_id="ny_person", data_schema=vol.Schema({
            vol.Required("navn"): _tekst(), vol.Required("type", default="voksen"): _persontype(),
            vol.Optional("tilstede"): _ent(ALLE_DOMENER), vol.Optional("sover"): _ent("binary_sensor")}))

    async def async_step_person(self, user_input=None):
        personer = self._personer()
        p = next((x for x in personer if x["key"] == self._person_key), None)
        if p is None:
            return await self.async_step_personer()
        if user_input is not None:
            if user_input.get("slett"):
                personer = [x for x in personer if x["key"] != p["key"]]
            else:
                p.update(navn=user_input["navn"].strip(), type=user_input["type"], entity=user_input.get("tilstede") or "",
                         sover=user_input.get("sover") or "")
            return self._lagre({CONF_PERSONER: personer})
        skjema = vol.Schema({
            vol.Required("navn", default=p["navn"]): _tekst(),
            vol.Required("type", default=p["type"]): _persontype(),
            vol.Optional("tilstede"): _ent(ALLE_DOMENER),
            vol.Optional("sover"): _ent("binary_sensor"),
            vol.Optional("slett", default=False): selector.BooleanSelector()})
        forslag = {}
        if p.get("entity"):
            forslag["tilstede"] = p["entity"]
        sover = p.get("sover") or (f"binary_sensor.{p['key']}_sover" if self.hass.states.get(f"binary_sensor.{p['key']}_sover") else "")
        if sover:
            forslag["sover"] = sover
        return self.async_show_form(step_id="person", data_schema=self.add_suggested_values_to_schema(skjema, forslag),
            description_placeholders={"navn": p["navn"], "key": p["key"]})

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
                "climate": list(user_input.get("climate") or []), "effekt": list(user_input.get("effekt") or []),
                "duty": user_input.get("duty") or "", "temp": user_input.get("temp") or "",
                "vindu": list(user_input.get("vindu") or []),
                "type": user_input["type"], "prio": int(user_input["prio"]),
                "nominell": float(user_input["nominell"]), "sol": bool(user_input.get("sol", False)),
                "profil": user_input["profil"], "aktiv": bool(user_input.get("aktiv", True)),
            })
            soner[key] = s
            return self._lagre({}, soner)
        skjema = vol.Schema({
            vol.Required("navn", default=s.get("navn", key)): _tekst(),
            vol.Optional("rom", default=s.get("rom", "")): _tekst(),
            vol.Optional("climate"): _ent("climate", multiple=True),
            vol.Optional("effekt"): _ent("sensor", multiple=True),
            vol.Optional("duty"): _ent("sensor"),
            vol.Optional("temp"): _ent("sensor"),
            vol.Optional("vindu"): _ent("binary_sensor", multiple=True),
            vol.Required("type", default=s.get("type", "panel")): selector.SelectSelector(selector.SelectSelectorConfig(
                options=[selector.SelectOptionDict(value="panel", label="Panelovn (rask)"),
                         selector.SelectOptionDict(value="gulv", label="Gulvvarme (treg)"),
                         selector.SelectOptionDict(value="varmepumpe", label="Varmepumpe (billigst — senkes sist)")], mode="dropdown")),
            vol.Required("profil", default=PROFIL_LEGACY.get(s.get("profil", "fellesrom"), s.get("profil", "fellesrom"))): selector.SelectSelector(selector.SelectSelectorConfig(
                options=profilvalg(self._personer()).config["options"], mode="dropdown")),
            vol.Required("prio", default=int(s.get("prio", 3))): _num(1, 5, 1, mode="slider"),
            vol.Required("nominell", default=float(s.get("nominell", 1.0))): _num(0.1, 5, 0.1, "kW"),
            vol.Required("sol", default=bool(s.get("sol", False))): selector.BooleanSelector(),
            vol.Required("aktiv", default=bool(s.get("aktiv", True))): selector.BooleanSelector(),
            vol.Optional("slett", default=False): selector.BooleanSelector(),
        })
        forslag = {k: s.get(k) for k in ("climate", "effekt", "duty", "temp", "vindu") if s.get(k)}
        for k in ("climate", "effekt"):
            if isinstance(forslag.get(k), str):
                forslag[k] = [forslag[k]]
        return self.async_show_form(step_id="sone", data_schema=self.add_suggested_values_to_schema(skjema, forslag),
                                    description_placeholders={"key": key, "navn": s.get("navn", key)})
