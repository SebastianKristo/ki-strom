"""Automatisk gjenkjenning av entiteter til oppsettet.

Alt her er forslag: brukeren ser dem forhåndsutfylt i skjemaet og kan bytte. Vi gjetter ut fra
device_class, enhet, state_class og navn — aldri fra hardkodede ID-er.
"""
from __future__ import annotations

import re
import unicodedata

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er


def _f(state) -> float | None:
    try:
        return float(state.state)
    except (TypeError, ValueError, AttributeError):
        return None


def _navn(state) -> str:
    return (state.attributes.get("friendly_name") or state.entity_id).lower()


def _treff(state, *ord_: str) -> bool:
    n = _navn(state) + " " + state.entity_id.lower()
    return any(o in n for o in ord_)


def slug(tekst: str) -> str:
    t = unicodedata.normalize("NFKD", tekst.replace("ø", "o").replace("æ", "ae").replace("å", "a"))
    t = t.encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", t).strip("_") or "sone"


# ----------------------------------------------------------------------
#  Måling
# ----------------------------------------------------------------------
def finn_effektmaler(hass: HomeAssistant) -> str | None:
    """Hovedmåleren: power-sensor i W med høyest verdi, helst med «meter/måler/ams/han/tibber/total» i navnet."""
    kand = []
    for st in hass.states.async_all("sensor"):
        if st.attributes.get("device_class") != "power":
            continue
        enhet = str(st.attributes.get("unit_of_measurement") or "")
        v = _f(st)
        if v is None:
            continue
        w = v * 1000 if enhet == "kW" else v
        poeng = w
        if _treff(st, "meter", "måler", "maler", "ams", "han", "tibber", "pulse", "total", "hus", "strøm", "strom"):
            poeng += 100000
        if _treff(st, "bereder", "varmtvann", "panelovn", "gulv", "lader", "charger", "pumpe"):
            poeng -= 100000
        kand.append((poeng, st.entity_id))
    return max(kand)[1] if kand else None


def finn_energiregister(hass: HomeAssistant) -> str | None:
    """Importert energi: energy-sensor i kWh med state_class total_increasing og høyest verdi."""
    kand = []
    for st in hass.states.async_all("sensor"):
        if st.attributes.get("device_class") != "energy":
            continue
        if st.attributes.get("state_class") not in ("total_increasing", "total"):
            continue
        if str(st.attributes.get("unit_of_measurement") or "") not in ("kWh", "Wh", "MWh"):
            continue
        v = _f(st)
        if v is None:
            continue
        poeng = v
        if _treff(st, "import", "consum", "forbruk", "total", "accumulated", "akkumulert", "meter", "måler"):
            poeng += 1e9
        if _treff(st, "export", "eksport", "produ", "solar", "sol", "bereder", "lader", "charger", "daily", "dag", "hour", "time", "month", "måned"):
            poeng -= 1e9
        kand.append((poeng, st.entity_id))
    return max(kand)[1] if kand else None


def finn_utetemp(hass: HomeAssistant) -> str | None:
    kand = []
    for st in hass.states.async_all("sensor"):
        if st.attributes.get("device_class") != "temperature":
            continue
        if _treff(st, "ute", "outdoor", "outside", "utend", "yr", "met.no", "weather"):
            kand.append(((0 if _treff(st, "ute", "outdoor") else 1), st.entity_id))
    if kand:
        return sorted(kand)[0][1]
    return None


def finn_vaer(hass: HomeAssistant) -> str | None:
    ider = [st.entity_id for st in hass.states.async_all("weather")]
    ider.sort(key=lambda i: (0 if "home" in i or "hjem" in i else 1, i))
    return ider[0] if ider else None


def finn_nordpool(hass: HomeAssistant) -> str | None:
    for st in hass.states.async_all("sensor"):
        if "raw_today" in st.attributes and ("nordpool" in st.entity_id or _treff(st, "nord pool", "nordpool", "spot")):
            return st.entity_id
    return None


def finn_person(hass: HomeAssistant, navn: str) -> str | None:
    n = navn.lower()
    for dom in ("person", "device_tracker", "binary_sensor", "switch", "input_boolean"):
        for st in hass.states.async_all(dom):
            if n in st.entity_id.lower() or n in _navn(st):
                if dom == "person" or _treff(st, "hjemme", "home", "posisjon", "presence", "tilstede"):
                    return st.entity_id
    return None


def finn_vvb(hass: HomeAssistant) -> tuple[str | None, str | None]:
    bryter = effekt = None
    for st in hass.states.async_all("switch"):
        if _treff(st, "bereder", "varmtvann", "water heater", "vvb", "boiler"):
            bryter = st.entity_id
            break
    for st in hass.states.async_all("sensor"):
        if st.attributes.get("device_class") == "power" and _treff(st, "bereder", "varmtvann", "water heater", "vvb", "boiler"):
            effekt = st.entity_id
            break
    return bryter, effekt


def finn_hanklevarmer(hass: HomeAssistant) -> tuple[str | None, str | None]:
    bryter = effekt = None
    for st in hass.states.async_all("switch"):
        if _treff(st, "håndkle", "handkle", "towel"):
            bryter = st.entity_id
            break
    for st in hass.states.async_all("sensor"):
        if st.attributes.get("device_class") == "power" and _treff(st, "håndkle", "handkle", "towel"):
            effekt = st.entity_id
            break
    return bryter, effekt


def finn_stromkalkulator(hass: HomeAssistant) -> dict[str, str]:
    """Strømkalkulator/egne nettleiesensorer: topp 1–3, energiledd, kapasitetstrinn, Norgespris."""
    ut: dict[str, str] = {}
    for st in hass.states.async_all("sensor"):
        e = st.entity_id
        n = _navn(st)
        if ("toppforbruk" in e or "topp" in n) and "3" in e:
            ut.setdefault("topp3", e)
        elif ("toppforbruk" in e or "topp" in n) and "2" in e:
            ut.setdefault("topp2", e)
        elif "toppforbruk" in e or ("topp" in n and "forbruk" in n):
            ut.setdefault("topp1", e)
        elif "energiledd" in e and ("dag" in e or "day" in e):
            ut.setdefault("energiledd_dag", e)
        elif "energiledd" in e and ("natt" in e or "night" in e):
            ut.setdefault("energiledd_natt", e)
        elif "kapasitetstrinn" in e or "kapasitetsledd" in e or "capacity_step" in e:
            ut.setdefault("kapasitetstrinn", e)
        elif "totalpris" in e or ("total" in e and "pris" in e) or "strompris" in e:
            ut.setdefault("strompris", e)
    for st in hass.states.async_all("binary_sensor"):
        if "norgespris" in st.entity_id and ("aktiv" in st.entity_id or "active" in st.entity_id):
            ut.setdefault("norgespris_aktiv", st.entity_id)
            break
    return ut


def forslag_alle(hass: HomeAssistant) -> dict[str, str]:
    """Samlet gjetning for hele oppsettet (bare nøkler vi faktisk fant)."""
    ut: dict[str, str] = {}
    for k, v in (("total_effekt", finn_effektmaler(hass)), ("importert_energi", finn_energiregister(hass)),
                 ("ute_temp", finn_utetemp(hass)), ("vaer", finn_vaer(hass)), ("nordpool", finn_nordpool(hass))):
        if v:
            ut[k] = v
    b, e = finn_vvb(hass)
    if b:
        ut["vvb_bryter"] = b
    if e:
        ut["vvb_effekt"] = e
    b, e = finn_hanklevarmer(hass)
    if b:
        ut["hanklevarmer"] = b
    if e:
        ut["hanklevarmer_effekt"] = e
    for navn in ("cybele", "sebastian", "rune"):
        p = finn_person(hass, navn)
        if p:
            ut[f"tilstede_{navn}"] = p
    ut.update(finn_stromkalkulator(hass))
    return ut


# ----------------------------------------------------------------------
#  Soner fra områder
# ----------------------------------------------------------------------
def _type_fra_navn(navn: str, hvac_modes: list | None = None) -> str:
    n = navn.lower()
    if any(o in n for o in ("varmepumpe", "heat pump", "heatpump", "daikin", "mitsubishi", "panasonic", "toshiba", "fujitsu", "lg ")):
        return "varmepumpe"
    if any(o in n for o in ("gulv", "floor", "underfloor")):
        return "gulv"
    if hvac_modes and "cool" in hvac_modes:
        return "varmepumpe"
    return "panel"


def _profil_fra_navn(navn: str) -> str:
    n = navn.lower()
    if "stue" in n or "living" in n:
        return "stue"
    if "bad" in n or "bath" in n or "dusj" in n:
        return "konstant"
    if "cybele" in n:
        return "cybele"
    if "sebastian" in n:
        return "sebastian"
    if any(o in n for o in ("gang", "hall", "trapp", "bod", "kjeller", "loft", "garasje", "vaskerom", "vask", "inngang", "entre", "entré")):
        return "sjelden"
    return "fellesrom"


def soner_fra_omrader(hass: HomeAssistant) -> dict[str, dict]:
    """Én sone per HA-område som har minst én termostat. Effektsensorer i samme område kobles på.

    Returnerer {key: sonekonfig} klar til lagring. Alt kan endres etterpå.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)

    def omrade_for(entity_id: str) -> str | None:
        e = ent_reg.async_get(entity_id)
        if e is None:
            return None
        if e.area_id:
            return e.area_id
        if e.device_id:
            d = dev_reg.async_get(e.device_id)
            if d and d.area_id:
                return d.area_id
        return None

    klima: dict[str, list] = {}
    for st in hass.states.async_all("climate"):
        a = omrade_for(st.entity_id)
        if a:
            klima.setdefault(a, []).append(st)
    effekt: dict[str, list[str]] = {}
    temp: dict[str, list[str]] = {}
    vindu: dict[str, list[str]] = {}
    for st in hass.states.async_all("sensor"):
        a = omrade_for(st.entity_id)
        if not a or a not in klima:
            continue
        dc = st.attributes.get("device_class")
        if dc == "power":
            effekt.setdefault(a, []).append(st.entity_id)
        elif dc == "temperature" and not _treff(st, "ute", "outdoor", "target", "sett"):
            temp.setdefault(a, []).append(st.entity_id)
    for st in hass.states.async_all("binary_sensor"):
        a = omrade_for(st.entity_id)
        if a in klima and st.attributes.get("device_class") in ("window", "door", "opening"):
            vindu.setdefault(a, []).append(st.entity_id)

    ut: dict[str, dict] = {}
    for area_id, klimaer in klima.items():
        area = area_reg.async_get_area(area_id)
        navn = area.name if area else area_id
        key = slug(navn)
        typer = [_type_fra_navn(_navn(c), c.attributes.get("hvac_modes")) for c in klimaer]
        typ = "varmepumpe" if "varmepumpe" in typer else "gulv" if all(t == "gulv" for t in typer) else "panel"
        profil = _profil_fra_navn(navn)
        # effektsensorer som hører til termostatene (samme navnestamme) først, så resten i området
        eff = effekt.get(area_id, [])
        ut[key] = dict(
            navn=navn, rom=navn, climate=[c.entity_id for c in klimaer], effekt=eff, duty="",
            temp=(temp.get(area_id) or [""])[0], vindu=vindu.get(area_id, []),
            type=typ, prio=1 if typ == "varmepumpe" else 2 if profil == "konstant" else 3,
            nominell=round(1.0 * len(klimaer) if typ != "gulv" else 0.8 * len(klimaer), 1),
            sol=profil == "stue", profil=profil, aktiv=True,
            temp_dag=f"ki_temp_{key}_dag", temp_natt=f"ki_temp_{key}_natt", temp_borte="",
        )
    return ut
