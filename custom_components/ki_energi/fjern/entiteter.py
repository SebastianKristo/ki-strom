"""Entitetene i kontrollversjonen. Alt leses fra koordinatoren; endringer sendes til Homey."""
from __future__ import annotations

from collections.abc import Callable
from datetime import time as dtime
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.components.button import ButtonEntity
from homeassistant.components.climate import ClimateEntity, ClimateEntityFeature, HVACAction, HVACMode
from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.components.switch import SwitchEntity
from homeassistant.components.time import TimeEntity
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from ..const import DOMAIN
from .koordinator import HomeyKoordinator

STATUSTEKST = {"gronn": "God margin", "gul": "Følger med", "oransje": "Nær grensen", "rod": "På grensen",
               "kritisk": "Over grensen", "av": "Av", "starter": "Starter"}
MAAL = SensorStateClass.MEASUREMENT
SUM = SensorStateClass.TOTAL


def grav(data: dict | None, *sti: str) -> Any:
    """Slå opp en verdi dypt i dataene; None hvis noe på veien mangler."""
    verdi: Any = data
    for ledd in sti:
        if not isinstance(verdi, dict):
            return None
        verdi = verdi.get(ledd)
    return verdi


def _klokke(tekst: Any) -> dtime | None:
    try:
        t, m = str(tekst).split(":")[:2]
        return dtime(int(t), int(m))
    except (ValueError, AttributeError):
        return None


class Grunn(CoordinatorEntity[HomeyKoordinator]):
    """Felles for alle entitetene: samme enhet, og utilgjengelig når Homey ikke svarer."""

    _attr_has_entity_name = True

    def __init__(self, koordinator: HomeyKoordinator, nokkel: str, navn: str, ikon: str | None = None) -> None:
        super().__init__(koordinator)
        self._attr_unique_id = f"ki_homey_{nokkel}"
        self._attr_name = navn
        if ikon:
            self._attr_icon = ikon
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, "homey")}, name="KI Energi (Homey)",
                                            manufacturer="KI Energi", model="Kontrollversjon")

    @property
    def d(self) -> dict:
        return self.coordinator.data or {}


# ----------------------------------------------------------------------
#  Sensorer
# ----------------------------------------------------------------------
# (nøkkel, navn, sti, enhet, device_class, state_class, ikon)
SENSORER = [
    # Strømkalkulatoren
    ("effekt", "Effekt nå", ("status", "effekt_w"), "W", SensorDeviceClass.POWER, MAAL, None),
    ("tariff", "Tariff", ("status", "nettleie", "tariff"), None, None, None, "mdi:clock-outline"),
    ("energiledd", "Energiledd", ("status", "nettleie", "energiledd"), "kr/kWh", None, MAAL, "mdi:transmission-tower"),
    ("kapasitetsledd", "Kapasitetsledd", ("status", "nettleie", "kapasitetsledd"), "kr/mnd", None, MAAL, "mdi:stairs"),
    ("kapasitetstrinn", "Kapasitetstrinn", ("status", "nettleie", "kapasitetstrinn"), None, None, None, "mdi:stairs"),
    ("snitt_topp", "Snitt toppforbruk", ("status", "nettleie", "snitt_topp_kw"), "kW", SensorDeviceClass.POWER, MAAL, None),
    ("margin_trinn", "Margin til neste trinn", ("status", "nettleie", "margin_kw"), "kW", SensorDeviceClass.POWER, MAAL, None),
    ("tak_idag", "Høyeste time i dag uten nytt trinn", ("status", "nettleie", "tak_idag_kwh"), "kWh", None, MAAL, "mdi:arrow-collapse-up"),
    ("spotpris", "Spotpris inkl. mva", ("status", "pris", "spot"), "kr/kWh", None, MAAL, "mdi:cash"),
    ("stromstotte", "Strømstøtte", ("status", "pris", "stromstotte"), "kr/kWh", None, MAAL, "mdi:cash-refund"),
    ("totalpris", "Total strømpris", ("status", "pris", "total"), "kr/kWh", None, MAAL, "mdi:cash-multiple"),
    ("time_forbruk", "Forbruk denne timen", ("status", "time", "kwh"), "kWh", SensorDeviceClass.ENERGY, None, None),
    ("dag_forbruk", "Forbruk i dag", ("status", "idag", "kwh"), "kWh", SensorDeviceClass.ENERGY, None, None),
    ("dag_kostnad", "Dagens kostnad", ("status", "idag", "kostnad_kr"), "kr", None, SUM, "mdi:cash"),
    ("mnd_forbruk", "Forbruk denne måneden", ("status", "maaned", "kwh"), "kWh", SensorDeviceClass.ENERGY, None, None),
    ("mnd_nettleie", "Nettleie denne måneden", ("status", "maaned", "nettleie_kr"), "kr", None, SUM, "mdi:transmission-tower"),
    ("mnd_stromstotte", "Strømstøtte denne måneden", ("status", "maaned", "stromstotte_kr"), "kr", None, SUM, "mdi:cash-refund"),
    ("mnd_kostnad", "Strømkostnad denne måneden", ("status", "maaned", "kostnad_kr"), "kr", None, SUM, "mdi:cash-multiple"),
    ("mnd_estimert", "Estimert månedskostnad", ("status", "maaned", "estimert_kr"), "kr", None, MAAL, "mdi:chart-line"),
    ("forrige_forbruk", "Forrige måned forbruk", ("status", "forrige_maaned", "kwh"), "kWh", SensorDeviceClass.ENERGY, None, None),
    ("forrige_kostnad", "Forrige måned strømkostnad", ("status", "forrige_maaned", "kostnad_kr"), "kr", None, None, "mdi:cash-multiple"),
    # Energimotoren
    ("motor_forklaring", "Forklaring", ("motor", "forklaring"), None, None, None, "mdi:message-text-outline"),
    ("time_grense", "Timens grense", ("motor", "budsjett", "grense"), "kWh", None, MAAL, "mdi:flash-alert"),
    ("time_forventet", "Timen ligger an til", ("motor", "forventet_time_kwh"), "kWh", None, MAAL, "mdi:chart-bell-curve"),
    ("ledig_effekt", "Ledig effekt", ("motor", "ledig_kw"), "kW", SensorDeviceClass.POWER, MAAL, None),
    ("uregulert_effekt", "Annet forbruk", ("motor", "uregulert_kw"), "kW", SensorDeviceClass.POWER, MAAL, None),
    ("styrt_effekt", "Styrt varme", ("motor", "styrt_w"), "W", SensorDeviceClass.POWER, MAAL, None),
    ("ute_temp", "Utetemperatur", ("motor", "ute"), "°C", SensorDeviceClass.TEMPERATURE, MAAL, None),
    ("plan_spart", "Varmeplanen sparer (36 t)", ("motor", "plan_spart_kr"), "kr", None, MAAL, "mdi:piggy-bank-outline"),
    # Huset
    ("modus", "Modus", ("hus", "modus"), None, None, None, "mdi:home-account"),
    ("hjemkomst", "Huset er varmt til", ("hus", "hjemkomst_kl"), None, None, None, "mdi:home-clock"),
    ("bereder_status", "Bereder", ("hus", "bereder", "status"), None, None, None, "mdi:water-boiler"),
    ("bereder_dager", "Dager siden berederen var varm", ("hus", "bereder", "dager_siden_varm"), "d", None, MAAL, "mdi:water-boiler-alert"),
]


class KiHomeySensor(Grunn, SensorEntity):
    def __init__(self, k, nokkel, navn, sti, enhet, klasse, tilstandsklasse, ikon) -> None:
        super().__init__(k, nokkel, navn, ikon)
        self._sti = sti
        self._attr_native_unit_of_measurement = enhet
        self._attr_device_class = klasse
        self._attr_state_class = tilstandsklasse

    @property
    def native_value(self):
        return grav(self.d, *self._sti)


class KiHomeyStatus(Grunn, SensorEntity):
    """Motorens status i klartekst, med rommene og budsjettet som attributter."""

    def __init__(self, k) -> None:
        super().__init__(k, "motor_status", "Status", "mdi:lightning-bolt-circle")

    @property
    def native_value(self):
        status = grav(self.d, "motor", "status")
        return STATUSTEKST.get(status, status)

    @property
    def extra_state_attributes(self) -> dict:
        return {
            "farge": grav(self.d, "motor", "status"),
            "skyggemodus": grav(self.d, "motor", "skygge"),
            "budsjett": grav(self.d, "motor", "budsjett"),
            "rom": [{k: r.get(k) for k in ("key", "navn", "temp", "settpunkt", "krav", "mal", "handling", "forklaring", "laert", "prio")}
                    for r in self.coordinator.rom()],
            "topper": grav(self.d, "status", "nettleie", "topper"),
            "problemer": grav(self.d, "status", "problemer"),
            "forslag": grav(self.d, "hus", "forslag"),
        }


# ----------------------------------------------------------------------
#  Binære sensorer
# ----------------------------------------------------------------------
BINAERE = [
    ("kapasitetsvarsel", "Kapasitetsvarsel", lambda d: grav(d, "status", "nettleie", "kapasitetsvarsel"), None, "mdi:alert-outline"),
    ("norgespris_aktiv", "Norgespris aktiv nå", lambda d: grav(d, "status", "pris", "norgespris_aktiv"), None, "mdi:cash-lock"),
    ("alle_borte", "Alle er borte", lambda d: grav(d, "hus", "alle_borte"), None, "mdi:home-export-outline"),
    ("bereder_varmer", "Berederen varmer", lambda d: grav(d, "hus", "bereder", "varmer"), BinarySensorDeviceClass.HEAT, None),
    ("maleproblem", "Måledata-problem", lambda d: bool(grav(d, "status", "problemer")) if grav(d, "status") else None,
     BinarySensorDeviceClass.PROBLEM, None),
]


class KiHomeyBinaer(Grunn, BinarySensorEntity):
    def __init__(self, k, nokkel, navn, les: Callable[[dict], Any], klasse, ikon) -> None:
        super().__init__(k, nokkel, navn, ikon)
        self._les = les
        self._attr_device_class = klasse

    @property
    def is_on(self) -> bool | None:
        v = self._les(self.d)
        return None if v is None else bool(v)


class KiHomeyPerson(Grunn, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PRESENCE

    def __init__(self, k, person: dict) -> None:
        super().__init__(k, f"hjemme_{person['key']}", f"{person.get('navn') or person['key']} hjemme")
        self._key = person["key"]

    @property
    def is_on(self) -> bool | None:
        p = next((x for x in grav(self.d, "hus", "personer") or [] if x.get("key") == self._key), None)
        return None if p is None or p.get("hjemme") is None else bool(p["hjemme"])


# ----------------------------------------------------------------------
#  Brytere
# ----------------------------------------------------------------------
# (nøkkel, navn, les, (metode, sti, kropp fra verdi), ikon)
BRYTERE = [
    ("motor_aktiv", "Energimotor", lambda d: grav(d, "motorinnstillinger", "aktiv"),
     ("PUT", "/motorinnstillinger", lambda v: {"aktiv": v}), "mdi:lightning-bolt-circle"),
    ("skyggemodus", "Skyggemodus", lambda d: grav(d, "motorinnstillinger", "skygge"),
     ("PUT", "/motorinnstillinger", lambda v: {"skygge": v}), "mdi:ghost-outline"),
    ("varmeplan", "Prisoptimal varmeplan", lambda d: grav(d, "motorinnstillinger", "planAktiv"),
     ("PUT", "/motorinnstillinger", lambda v: {"planAktiv": v}), "mdi:chart-timeline-variant"),
    ("bortemodus", "Bortemodus", lambda d: grav(d, "hus", "borte"),
     ("POST", "/bortemodus", lambda v: {"paa": v}), "mdi:bag-suitcase"),
    ("norgespris", "Jeg har Norgespris", lambda d: grav(d, "innstillinger", "harNorgespris"),
     ("PUT", "/innstillinger", lambda v: {"harNorgespris": v}), "mdi:cash-lock"),
    ("bereder_styring", "KI styrer berederen", lambda d: grav(d, "husinnstillinger", "vvb", "prisstyring"),
     ("PUT", "/husinnstillinger", lambda v: {"vvb": {"prisstyring": v}}), "mdi:water-boiler-auto"),
]


class KiHomeyBryter(Grunn, SwitchEntity):
    def __init__(self, k, nokkel, navn, les, skriv, ikon) -> None:
        super().__init__(k, nokkel, navn, ikon)
        self._les = les
        self._skriv = skriv

    @property
    def is_on(self) -> bool | None:
        v = self._les(self.d)
        return None if v is None else bool(v)

    async def _sett(self, verdi: bool) -> None:
        metode, sti, kropp = self._skriv
        await self.coordinator.endre(metode, sti, kropp(verdi))

    async def async_turn_on(self, **kwargs) -> None:
        await self._sett(True)

    async def async_turn_off(self, **kwargs) -> None:
        await self._sett(False)


# ----------------------------------------------------------------------
#  Tall
# ----------------------------------------------------------------------
# (nøkkel, navn, kilde, felt, min, maks, steg, enhet, ikon)
TALL = [
    ("maks_time", "Absolutt grense per time", "motorinnstillinger", "maksTimeKwh", 1, 25, 0.1, "kWh", "mdi:flash-alert"),
    ("min_time", "Laveste grense per time", "motorinnstillinger", "minTimeKwh", 0.5, 15, 0.1, "kWh", "mdi:flash-outline"),
    ("plan_opp", "Planen får forvarme", "motorinnstillinger", "planOppGrader", 0, 3, 0.5, "°C", "mdi:thermometer-plus"),
    ("forvarming_maks", "Forvarming maks timer", "motorinnstillinger", "forvarmingMaksTimer", 2, 36, 1, "t", "mdi:timer-sand"),
    ("borte_min_temp", "Laveste bortetemperatur", "husinnstillinger", "borteMinTemp", 8, 20, 0.5, "°C", "mdi:thermometer-low"),
    ("borte_auto_timer", "Bortemodus etter timer ute", "husinnstillinger", "borteAutoTimer", 1, 48, 1, "t", "mdi:timer-sand"),
]


class KiHomeyTall(Grunn, NumberEntity):
    _attr_mode = NumberMode.BOX

    def __init__(self, k, nokkel, navn, kilde, felt, minste, storste, steg, enhet, ikon) -> None:
        super().__init__(k, nokkel, navn, ikon)
        self._kilde, self._felt = kilde, felt
        self._attr_native_min_value, self._attr_native_max_value, self._attr_native_step = minste, storste, steg
        self._attr_native_unit_of_measurement = enhet

    @property
    def native_value(self) -> float | None:
        v = grav(self.d, self._kilde, self._felt)
        return None if v is None else float(v)

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.endre("PUT", f"/{self._kilde}", {self._felt: value})


class KiHomeyRomtemp(Grunn, NumberEntity):
    """Dag- eller nattemperaturen for et rom. Hele romlista sendes tilbake, med ett felt endret."""

    _attr_mode = NumberMode.BOX
    _attr_native_min_value = 5
    _attr_native_max_value = 30
    _attr_native_step = 0.5
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS

    def __init__(self, k, rom: dict, felt: str) -> None:
        navn = rom.get("navn") or rom["key"]
        super().__init__(k, f"temp_{rom['key']}_{felt}", f"{navn} {'dag' if felt == 'dag' else 'natt'}",
                         "mdi:white-balance-sunny" if felt == "dag" else "mdi:weather-night")
        self._key, self._felt = rom["key"], felt

    def _rom(self) -> dict | None:
        return next((r for r in self.coordinator.rominnstillinger() if r.get("key") == self._key), None)

    @property
    def available(self) -> bool:
        return super().available and self._rom() is not None

    @property
    def native_value(self) -> float | None:
        r = self._rom()
        v = None if r is None else r.get(self._felt)
        return None if v is None else float(v)

    async def async_set_native_value(self, value: float) -> None:
        soner = [dict(r, **({self._felt: value} if r.get("key") == self._key else {})) for r in self.coordinator.rominnstillinger()]
        await self.coordinator.endre("PUT", "/motorinnstillinger", {"soner": soner})


# ----------------------------------------------------------------------
#  Klokkeslett
# ----------------------------------------------------------------------
class KiHomeyTid(Grunn, TimeEntity):
    def __init__(self, k, nokkel, navn, kilde, felt, ikon) -> None:
        super().__init__(k, nokkel, navn, ikon)
        self._kilde, self._felt = kilde, felt

    @property
    def native_value(self) -> dtime | None:
        return _klokke(grav(self.d, self._kilde, self._felt))

    async def async_set_value(self, value: dtime) -> None:
        await self.coordinator.endre("PUT", f"/{self._kilde}", {self._felt: f"{value.hour:02d}:{value.minute:02d}"})


class KiHomeyHjemkomst(Grunn, TimeEntity):
    """«Vi kommer hjem kl. …». Å sette den slår på bortemodus og varmer huset til tidspunktet."""

    def __init__(self, k) -> None:
        super().__init__(k, "hjemkomst_tid", "Vi kommer hjem kl.", "mdi:home-import-outline")

    @property
    def native_value(self) -> dtime | None:
        return _klokke(grav(self.d, "hus", "hjemkomst_kl"))

    async def async_set_value(self, value: dtime) -> None:
        await self.coordinator.endre("POST", "/hjemkomst", {"tid": f"{value.hour:02d}:{value.minute:02d}"})


TIDER = [
    ("dag_start", "Dagen starter", "motorinnstillinger", "dagStart", "mdi:weather-sunset-up"),
    ("natt_start", "Natten starter", "motorinnstillinger", "nattStart", "mdi:weather-night"),
    ("fast_hjemkomst", "Fast hjemkomst klokka", "husinnstillinger", "hjemkomstTid", "mdi:home-clock"),
]


# ----------------------------------------------------------------------
#  Knapper
# ----------------------------------------------------------------------
KNAPPER = [
    ("bereder_boost", "Varm opp berederen nå (60 min)", "/bereder", {"handling": "boost", "minutter": 60}, "mdi:water-boiler"),
    ("bereder_tving", "Full oppvarming av berederen", "/bereder", {"handling": "tving"}, "mdi:bacteria-outline"),
    ("forleng_borte", "Vi blir borte lenger", "/forleng", {}, "mdi:calendar-arrow-right"),
    ("fjern_overstyringer", "Fjern alle overstyringer", "/fjernoverstyring", {}, "mdi:restore"),
]


class KiHomeyKnapp(Grunn, ButtonEntity):
    def __init__(self, k, nokkel, navn, sti, kropp, ikon) -> None:
        super().__init__(k, nokkel, navn, ikon)
        self._sti, self._kropp = sti, kropp

    async def async_press(self) -> None:
        await self.coordinator.endre("POST", self._sti, dict(self._kropp))


# ----------------------------------------------------------------------
#  Rom som klimaenheter
# ----------------------------------------------------------------------
class KiHomeyRom(Grunn, ClimateEntity):
    """Et rom fra energimotoren. Å sette temperaturen overstyrer rommet i to timer."""

    _attr_hvac_modes = [HVACMode.HEAT]
    _attr_hvac_mode = HVACMode.HEAT
    _attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_target_temperature_step = 0.5
    _attr_min_temp = 5
    _attr_max_temp = 30
    _enable_turn_on_off_backwards_compatibility = False
    OVERSTYR_MINUTTER = 120

    def __init__(self, k, rom: dict) -> None:
        super().__init__(k, f"rom_{rom['key']}", rom.get("navn") or rom["key"])
        self._key = rom["key"]

    def _rom(self) -> dict | None:
        return next((r for r in self.coordinator.rom() if r.get("key") == self._key), None)

    @property
    def available(self) -> bool:
        return super().available and self._rom() is not None

    @property
    def current_temperature(self) -> float | None:
        r = self._rom()
        return None if r is None else r.get("temp")

    @property
    def target_temperature(self) -> float | None:
        r = self._rom() or {}
        return r.get("settpunkt") if r.get("settpunkt") is not None else r.get("mal")

    @property
    def hvac_action(self) -> HVACAction | None:
        r = self._rom()
        if r is None or r.get("effekt_w") is None:
            return None
        return HVACAction.HEATING if r["effekt_w"] > 50 else HVACAction.IDLE

    @property
    def extra_state_attributes(self) -> dict:
        r = self._rom() or {}
        return {k: r.get(k) for k in ("krav", "mal", "handling", "forklaring", "senket", "laert", "prio", "type", "effekt_w")}

    async def async_set_temperature(self, **kwargs) -> None:
        temp = kwargs.get(ATTR_TEMPERATURE)
        if temp is None:
            return
        await self.coordinator.endre("POST", "/overstyr", {"rom": self._key, "temp": float(temp), "minutter": self.OVERSTYR_MINUTTER})

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Rommet har bare «varme»; av og på styres på Homey."""


# ----------------------------------------------------------------------
#  Samling per plattform
# ----------------------------------------------------------------------
def lag(plattform: str, k: HomeyKoordinator) -> list:
    """Entitetene for én plattform. Rom og personer lages fra det Homey har nå; nye rom krever omlasting."""
    if plattform == "sensor":
        return [KiHomeyStatus(k)] + [KiHomeySensor(k, *s) for s in SENSORER]
    if plattform == "binary_sensor":
        personer = grav(k.data, "hus", "personer") or []
        return [KiHomeyBinaer(k, *b) for b in BINAERE] + [KiHomeyPerson(k, p) for p in personer if p.get("key")]
    if plattform == "switch":
        return [KiHomeyBryter(k, *b) for b in BRYTERE]
    if plattform == "number":
        rom = [KiHomeyRomtemp(k, r, felt) for r in k.rominnstillinger() if r.get("key") for felt in ("dag", "natt")]
        return [KiHomeyTall(k, *t) for t in TALL] + rom
    if plattform == "time":
        return [KiHomeyHjemkomst(k)] + [KiHomeyTid(k, *t) for t in TIDER]
    if plattform == "button":
        return [KiHomeyKnapp(k, *b) for b in KNAPPER]
    if plattform == "climate":
        return [KiHomeyRom(k, r) for r in k.rom() if r.get("key")]
    return []
