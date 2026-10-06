"""2.33.0 — framtidssikring for hytte og hus.

Rene funksjoner testes uten Home Assistant; motoren, modusene, berederen og laderen
mot falske huber eller en ekte HA-testinstans (via _setup i test_smoke).
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi import const
from custom_components.ki_energi.const import DOMAIN
from custom_components.ki_energi.engine import KiEngine
from custom_components.ki_energi.lading import KiLading, trinn_kw, velg_trinn
from custom_components.ki_energi.modes import KiModuser
from custom_components.ki_energi.nettleie import KiNettleie, Timemaler, i_hoylast
from custom_components.ki_energi.vvb import KiVvb

from test_nettleie import FakeHub, _fyll_dag, frys_tid  # noqa: F401 – fixture
from test_smoke import _setup

OSLO = ZoneInfo("Europe/Oslo")
KILDE = Path("custom_components/ki_energi")


# ----------------------------------------------------------------------
#  Versjon
# ----------------------------------------------------------------------
def test_versjon_i_const_og_manifest_er_like():
    """sw_version på enheten kom fra const.VERSION, som sto på 2.0.0 mens manifestet sa 2.32.0."""
    manifest = json.loads((KILDE / "manifest.json").read_text())
    assert manifest["version"] == const.VERSION


def test_ingen_hardkodet_stedsnavn_i_varslene():
    s = (KILDE / "modes.py").read_text()
    assert "Toten" not in s, "stedsnavnet skal komme fra oppsettet (sted_navn), ikke stå i koden"


# ----------------------------------------------------------------------
#  Hub: stedsnavn og frostpåslag
# ----------------------------------------------------------------------
class _Hub:
    """Minimal hub til engine/vvb/lading: cfg, hjelpere, tilstander."""

    def __init__(self, cfg=None, num=None, on=None, states=None, tid=None, sensor=None):
        self._cfg = cfg or {}
        self._num = num or {}
        self._on = on or {}
        self._states = states or {}
        self._tid = tid or {}
        self._sensor = sensor or {}
        self.minne = {"profil": {}, "tau": {}, "state": {"overstyringer": {}, "rotasjon": 0}, "logg": [], "vvb": {},
                      "moduser": {}, "nettleie": {}, "sparing": {}, "prognose": {}, "lys": {}, "lading": {}}
        self.helpers = {}
        self.sensors = {}
        self.sensor_cache = {}
        self.satt = {}
        self.varsler = []
        self.kall_logg = []
        self.engine = None
        self.vvb = None
        self.lading = None
        self.nettleie = None
        self.prognose = None
        self.hass = SimpleNamespace(states=SimpleNamespace(get=lambda eid: self._states.get(eid)))

    # konfig/hjelpere
    def cfg(self, k, d=None):
        return self._cfg.get(k, d if d is not None else const.DEFAULT_CONFIG.get(k))

    def num(self, k, d=0.0):
        return self._num.get(k, d)

    def on(self, k, d=False):
        return self._on.get(k, d)

    def tid_min(self, k, d="00:00"):
        v = self._tid.get(k, d)
        h, m = v.split(":")[:2]
        return int(h) * 60 + int(m)

    def tid_str(self, k, d="00:00"):
        return self._tid.get(k, d)

    def tekst(self, k, d=""):
        return d

    def dt(self, k):
        return self._tid.get(k) if isinstance(self._tid.get(k), datetime) else None

    def sett(self, k, v):
        self.satt[k] = v

    def tell(self, k, v):
        self._num[k] = self._num.get(k, 0.0) + v

    def lagre(self, forsinket=True):
        pass

    # tilstand
    def st(self, eid):
        s = self._states.get(eid)
        return None if s is None or s.state in (None, "unknown", "unavailable", "") else s.state

    def f(self, eid, d=None):
        v = self.st(eid)
        try:
            return float(v) if v is not None else d
        except ValueError:
            return d

    def attr(self, eid, navn, d=None):
        s = self._states.get(eid)
        return d if s is None else s.attributes.get(navn, d)

    def pa(self, eid):
        return self.st(eid) in ("on", "home")

    def finnes(self, eid):
        return bool(eid) and self.st(eid) is not None

    def hjemme(self, eid):
        v = self.st(eid)
        return None if v is None else v in ("on", "home")

    def sensor_state(self, k):
        return self._sensor.get(k)

    def sensor_attr(self, k, n, d=None):
        return d

    def sett_sensor(self, k, v, a=None):
        self.sensor_cache[k] = (v, a or {})

    def mellom(self, a, b, naa=None):
        from custom_components.ki_energi.hub import KiHub
        return KiHub.mellom(a, b, naa)

    def naa_min(self):
        n = dt_util.now()
        return n.hour * 60 + n.minute

    def personer(self):
        return self._cfg.get("personer", [])

    def person(self, key):
        return next((p for p in self.personer() if p["key"] == key), None)

    def aktive_soner(self):
        return self._cfg.get("soner", {})

    def soner(self):
        return self._cfg.get("soner", {})

    def fritidsbolig(self):
        return self._cfg.get("hustype") == "fritidsbolig"

    # de nye fra hub.py – samme kode som der
    def sted(self):
        from custom_components.ki_energi.hub import KiHub
        return KiHub.sted(self)

    def ute(self):
        from custom_components.ki_energi.hub import KiHub
        return KiHub.ute(self)

    def frost_paslag(self):
        from custom_components.ki_energi.hub import KiHub
        return KiHub.frost_paslag(self)

    async def varsle(self, tittel, melding, **kw):
        self.varsler.append((tittel, melding, kw))

    async def kall(self, dom, tj, data):
        self.kall_logg.append((dom, tj, data))

    async def logbook(self, *a, **k):
        pass


def _state(value, **attrs):
    return SimpleNamespace(state=str(value), attributes=attrs)


def test_sted_fra_oppsettet_ellers_hytta_eller_huset():
    assert _Hub(cfg={"hustype": "fritidsbolig"}).sted() == "hytta"
    assert _Hub(cfg={"hustype": "bolig"}).sted() == "huset"
    assert _Hub(cfg={"hustype": "fritidsbolig", "sted_navn": " Strömstad "}).sted() == "Strömstad"


def test_frostpaslag_trinnvis_etter_utetemperatur():
    h = _Hub(on={"ki_frostvakt": True}, num={"ki_frost_ute_grense": -10, "ki_frost_paslag": 2},
             states={"sensor.outdoor_meter_temperature": _state(-4)})
    assert h.frost_paslag() == (0.0, "")
    h._states["sensor.outdoor_meter_temperature"] = _state(-12)
    assert h.frost_paslag()[0] == 2
    h._states["sensor.outdoor_meter_temperature"] = _state(-25)
    assert h.frost_paslag()[0] == 4
    h._on["ki_frostvakt"] = False
    assert h.frost_paslag() == (0.0, "")


def test_utetemperatur_faller_tilbake_pa_vaerentiteten():
    h = _Hub(states={"weather.forecast_home": _state("cloudy", temperature=-7.5)})
    assert h.ute() == -7.5


# ----------------------------------------------------------------------
#  Motor: termisk modell, helgevekking, nattsenking, frost, profil
# ----------------------------------------------------------------------
def _motor(**kw) -> KiEngine:
    h = _Hub(**kw)
    m = KiEngine(h)
    h.engine = m
    return m


def test_forvarming_uten_laering_bruker_gammel_rate():
    m = _motor()
    minutter, grunn = m.forvarming_minutter("stue", 8.0, 20.0, -10.0)
    assert minutter == pytest.approx(12 / 1.2 * 60) and "lært" in grunn


def test_forvarming_tar_lenger_tid_i_kulda():
    """Samme rom, samme mål: −20 ute må ta lenger tid enn +5. Den gamle regelen ga samme svar."""
    m = _motor()
    m.hub.minne["tau"]["stue"] = {"k": 0.05, "varme_rate": 1.5, "rate_max": 3.0, "n": 40}
    mildt, _ = m.forvarming_minutter("stue", 8.0, 20.0, 5.0)
    kaldt, _ = m.forvarming_minutter("stue", 8.0, 20.0, -20.0)
    assert kaldt > mildt * 1.5, (mildt, kaldt)
    # kontroll mot den lukkede formelen
    k, r = 0.05, 3.0
    forventet = math.log((r - k * (8 + 20)) / (r - k * (20 + 20))) / k * 60
    assert kaldt == pytest.approx(forventet, rel=1e-6)


def test_forvarming_sier_fra_nar_malet_ikke_kan_nas():
    m = _motor()
    m.hub.minne["tau"]["stue"] = {"k": 0.1, "varme_rate": 1.5, "rate_max": 3.0, "n": 40}
    minutter, grunn = m.forvarming_minutter("stue", 8.0, 22.0, -15.0)   # tap 3,7 °C/t > evne 3,0
    assert minutter is None and "klarer" in grunn


def test_helgevekking_avgjores_av_morgenen_etter(monkeypatch):
    m = _motor(on={})
    person = {"key": "ungdom", "navn": "U", "type": "ungdom"}
    fredag_kveld = datetime(2026, 10, 9, 23, 30, tzinfo=OSLO)
    monkeypatch.setattr(dt_util, "now", lambda: fredag_kveld)
    assert m.helgevekking(person) is True
    sondag_kveld = datetime(2026, 10, 11, 23, 30, tzinfo=OSLO)
    monkeypatch.setattr(dt_util, "now", lambda: sondag_kveld)
    assert m.helgevekking(person) is False


def test_nattsenking_lonner_seg_med_vanlig_prisforskjell():
    """k = 0,08 og 8 t natt: den gamle regelen (k·t = 0,64 mot 1,1) sa nei. Energien som
    hentes igjen om morgenen er den som ikke ble brukt om natten — den koster bare
    prisforskjellen, og resten av natta er ren sparing."""
    m = _motor(on={"ki_nattsenk_aktiv": True, "ki_nattsenk_okonomi": True},
               num={"ki_natt_senk_ute_grense": 12},
               tid={"ki_tid_natt_start": "22:30", "ki_tid_dag_start": "06:30"},
               cfg={"energiledd_dag": "s.dag", "energiledd_natt": "s.natt", "strompris": "s.pris"},
               states={"s.dag": _state(0.5), "s.natt": _state(0.4), "s.pris": _state(1.0),
                       "sensor.outdoor_meter_temperature": _state(-5)})
    m.hub.minne["tau"]["stue"] = {"k": 0.08, "varme_rate": 1.2, "n": 30}
    ok, grunn = m.nattsenk_lonnsomt("stue")
    assert ok, grunn
    # et svært tregt rom (τ 100 t) når aldri senkingen på en natt → ikke verdt gjenoppvarmingen til dagpris
    m.hub.minne["tau"]["stue"] = {"k": 0.01, "varme_rate": 1.2, "n": 30}
    ok, grunn = m.nattsenk_lonnsomt("stue")
    assert not ok and "kjøle seg ned" in grunn


def test_profil_laeres_per_tilstedevaerelse_og_hentes_riktig():
    m = _motor(sensor={"ki_alle_borte": False, "ki_uregulert_effekt": 1500.0}, on={"ki_energi_hovedbryter": True})
    nokkel = m.profilnokkel()
    for _ in range(4):
        m._laering_indre()
    assert m.hub.minne["profil"][nokkel]["n"] == 4
    assert m.hub.minne["profil"][nokkel + "-h"]["n"] == 4
    # tomt hus: egen profil, lavt forbruk
    m.hub._sensor["ki_alle_borte"] = True
    m.hub._sensor["ki_uregulert_effekt"] = 200.0
    for _ in range(4):
        m._laering_indre()
    assert m.hub.minne["profil"][nokkel + "-b"]["kw"] == pytest.approx(0.2)
    assert m.profil_hent(nokkel, tilstede="b")[0] == pytest.approx(0.2)
    assert m.profil_hent(nokkel, tilstede="h")[0] == pytest.approx(1.5)
    assert m.profil_hent(nokkel)[0] == pytest.approx(m.hub.minne["profil"][nokkel]["kw"])


def test_tap_laeres_ikke_uten_effektsensor_mens_ovnen_gar():
    """Uten effektsensor ble «ingen sensor» lest som 0 W, og tapet lært mens ovnen sto på.
    Nå avgjør termostatens hvac_action; er den ukjent, læres ingenting."""
    sone = {"navn": "Stue", "climate": "climate.stue", "climater": ["climate.stue"], "effekter": [], "effekt": "", "temp": ""}
    m = _motor(cfg={"soner": {"stue": sone}}, on={"ki_energi_hovedbryter": True, "ki_laering_tau": True},
               states={"sensor.outdoor_meter_temperature": _state(-5),
                       "climate.stue": _state("heat", current_temperature=20.0, hvac_action="heating")})
    t0 = dt_util.utcnow().timestamp()
    m.temp_forrige = {"stue": (20.5, t0 - 600)}    # faller 0,5 °C på 10 min mens ovnen varmer
    m._laering_indre()
    assert "stue" not in m.hub.minne["tau"]
    # idle: da er fallet et tap
    m.hub._states["climate.stue"] = _state("heat", current_temperature=20.0, hvac_action="idle")
    m.temp_forrige = {"stue": (20.5, t0 - 600)}
    m._laering_indre()
    assert m.hub.minne["tau"]["stue"]["n"] == 1


def test_oppvarmingsevne_laeres_av_stigning_pluss_tap():
    sone = {"navn": "Stue", "climate": "climate.stue", "climater": ["climate.stue"], "effekter": ["s.e"], "effekt": "s.e", "temp": ""}
    m = _motor(cfg={"soner": {"stue": sone}}, on={"ki_energi_hovedbryter": True, "ki_laering_tau": True},
               states={"sensor.outdoor_meter_temperature": _state(0),
                       "climate.stue": _state("heat", current_temperature=20.0), "s.e": _state(900)})
    m.hub.minne["tau"]["stue"] = {"k": 0.1, "varme_rate": 1.2, "n": 10}
    t0 = dt_util.utcnow().timestamp()
    m.temp_forrige = {"stue": (19.5, t0 - 1200)}   # +1,5 °C/t ved 20 °C over ute → evne 1,5 + 0,1·20 = 3,5
    m._laering_indre()
    assert m.hub.minne["tau"]["stue"]["rate_max"] == pytest.approx(3.5, abs=0.02)
    assert m._rate_max("stue") == pytest.approx(3.5, abs=0.02)


def test_frostpaslag_lofter_bortetemperaturene_i_motoren():
    sone = {"navn": "Stue", "climate": "climate.stue", "climater": ["climate.stue"], "type": "panel", "prio": 3,
            "profil": "stue", "temp_dag": "ki_temp_stue_dag", "temp_natt": "ki_temp_stue_natt", "rom": "Stue"}
    m = _motor(cfg={"soner": {"stue": sone}, "hustype": "fritidsbolig"},
               on={"ki_helgemodus": True, "ki_frostvakt": True},
               num={"ki_temp_helg": 8.0, "ki_frost_ute_grense": -10, "ki_frost_paslag": 2, "ki_temp_stue_dag": 22, "ki_temp_stue_natt": 19},
               states={"sensor.outdoor_meter_temperature": _state(-22)})
    mal, grunn, _ = m.mal_temperatur("stue", sone)
    assert mal == 12.0 and "frostvakt" in grunn      # 8 + 2·2


@pytest.mark.asyncio
async def test_frostfare_varmer_uansett_budsjett_og_varsler_alltid():
    sone = {"navn": "Bod", "climate": "climate.bod", "climater": ["climate.bod"], "effekter": [], "effekt": "", "temp": "",
            "type": "panel", "prio": 5, "profil": "sjelden", "rom": "Bod", "temp_dag": "ki_temp_bod_dag", "temp_natt": "", "nominell": 1.0}
    m = _motor(cfg={"soner": {"bod": sone}, "hustype": "fritidsbolig"},
               on={"ki_helgemodus": True, "ki_frostvakt": True, "ki_styr_bod": True, "ki_energi_varsler": False},
               num={"ki_temp_helg": 8.0, "ki_frost_alarm_temp": 5, "ki_temp_bod_dag": 20},
               states={"climate.bod": _state("heat", current_temperature=3.8, temperature=8)})
    laster = m.bygg_laster()
    l = laster[0]
    assert l["frostfare"] and l["prio"] == 1 and l["mal"] == 10.0 and l["trenger"]
    budsjett = dict(tillatt_snitt=0.0, igjen=0.0, grense=3.0, timer_igjen=0.5, minutter_igjen=30)
    plan, _ = m.fordel(laster, budsjett, 0.0, 0.0)
    assert plan[0]["handling"] == "normal", "prio 1 (frost) senkes aldri, selv uten budsjett"
    await m.frostvakt(laster, plan)
    assert m.hub.varsler and m.hub.varsler[0][0] == "Frostfare" and m.hub.varsler[0][2]["alltid"]
    assert m.hub.sensor_cache["ki_frostfare"][0] is True
    # ikke på nytt innen tolv timer
    await m.frostvakt(laster, plan)
    assert len(m.hub.varsler) == 1


@pytest.mark.asyncio
async def test_frostvakt_varsler_om_dod_termostat_i_tomt_hus_i_kulda():
    sone = {"navn": "Stue", "climate": "climate.stue", "climater": ["climate.stue"], "effekter": [], "effekt": "", "temp": "",
            "type": "panel", "prio": 3, "profil": "stue", "rom": "Stue", "temp_dag": "ki_temp_stue_dag", "temp_natt": "", "nominell": 1.0}
    m = _motor(cfg={"soner": {"stue": sone}, "hustype": "fritidsbolig"},
               on={"ki_helgemodus": True, "ki_frostvakt": True},
               num={"ki_frost_ute_grense": -10},
               states={"sensor.outdoor_meter_temperature": _state(-18)})
    laster = m.bygg_laster()
    assert not laster[0]["levende"]
    await m.frostvakt(laster, [])
    assert any("svarer ikke" in v[1] for v in m.hub.varsler)


@pytest.mark.asyncio
async def test_settpunkt_klemmes_til_termostatens_grenser():
    m = _motor(states={"climate.vp": _state("heat", temperature=21, min_temp=16, max_temp=30)})
    skrevet = await m.skriv_settpunkt("stue|climate.vp", "climate.vp", 8.0)
    assert skrevet
    assert m.hub.kall_logg[-1] == ("climate", "set_temperature", {"entity_id": "climate.vp", "temperature": 16.0})
    assert any("16–30" in l["forklaring"] for l in m.hub.minne["logg"])


# ----------------------------------------------------------------------
#  Moduser: tidshendelser som tåler et hoppet tick
# ----------------------------------------------------------------------
def test_klokka_treffer_innenfor_vinduet_en_gang_per_dag():
    mod = object.__new__(KiModuser)
    mod.hub = SimpleNamespace(lagre=lambda *a, **k: None)
    mod.m = {}
    assert not mod._klokka("x", 9 * 60 + 59, 10 * 60, "2026-10-06")
    assert mod._klokka("x", 10 * 60 + 4, 10 * 60, "2026-10-06")      # ticket kl. 10:00 ble hoppet over
    assert not mod._klokka("x", 10 * 60 + 5, 10 * 60, "2026-10-06")  # men bare én gang
    assert not mod._klokka("x", 10 * 60 + 11, 10 * 60, "2026-10-07")  # for sent
    assert mod._klokka("x", 10 * 60, 10 * 60, "2026-10-07")          # ny dag


# ----------------------------------------------------------------------
#  Nettleie: høylastvindu, timemodell, plassholder
# ----------------------------------------------------------------------
def test_i_hoylast():
    t = datetime(2026, 1, 14, 8, 0, tzinfo=OSLO)       # onsdag januar
    assert i_hoylast(t, "", "", False, "")
    assert i_hoylast(t, "07:00", "19:00", True, "11-3")
    assert not i_hoylast(t.replace(hour=20), "07:00", "19:00", True, "11-3")
    assert not i_hoylast(t + timedelta(days=3), "07:00", "19:00", True, "11-3")   # lørdag
    assert not i_hoylast(t.replace(month=6), "07:00", "19:00", True, "11-3")
    assert i_hoylast(t.replace(hour=23), "22:00", "06:00", False, "")           # over midnatt


def test_utenfor_hoylast_gjelder_bare_absolutt_grense(frys_tid):
    frys_tid(datetime(2026, 1, 14, 21, 0, tzinfo=OSLO))
    hub = FakeHub(cfg={"hoylast_fra": "07:00", "hoylast_til": "19:00", "hoylast_hverdag": True},
                  num={"ki_maks_time_kwh": 9.5, "ki_min_time_kwh": 2.5, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    _fyll_dag(n, "2026-01-12", {17: 6.0, 22: 9.0})      # kveldstimen teller ikke i døgnmaksen
    v = n.vurder(8.0)
    assert not v["i_hoylast"] and v["grense_kwh"] == 9.5 and "høylast" in v["hvorfor"]
    assert v["hoyere_fastledd"] is False
    assert v["topp_tre"][0]["kwh"] == 6.0, "timen kl. 22 skal ikke være med i grunnlaget"


def test_timemodell_tre_timer_samme_dag_teller_hver_for_seg(frys_tid):
    frys_tid(datetime(2026, 1, 14, 12, 0, tzinfo=OSLO))
    hub = FakeHub(cfg={"nettleie_modell": "topp3_timer"},
                  num={"ki_maks_time_kwh": 9.5, "ki_min_time_kwh": 2.5, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.3})
    n = KiNettleie(hub)
    _fyll_dag(n, "2026-01-12", {16: 6.0, 17: 5.5, 18: 5.0})
    _fyll_dag(n, "2026-01-13", {17: 2.0})
    v = n.vurder(3.0)
    assert v["modell"] == "topp3_timer"
    assert [t["kwh"] for t in v["topp_tre"]] == [6.0, 5.5, 5.0]       # Elvia ville gitt 6,0 og 2,0
    assert v["registrert_snitt"] == pytest.approx(5.5)
    # fri_tak = tredje høyeste time; en time på 4 kWh rører ingenting
    assert v["fri_tak_kwh"] == 5.0
    assert v["hoyere_snitt"] is False


def test_plassholder_bruker_forrige_maneds_erfaring(frys_tid):
    frys_tid(datetime(2026, 10, 2, 12, 0, tzinfo=OSLO))
    hub = FakeHub(num={"ki_maks_time_kwh": 9.5, "ki_min_time_kwh": 2.5, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.4})
    n = KiNettleie(hub)
    for d, kwh in (("2026-09-10", 6.2), ("2026-09-11", 5.8), ("2026-09-12", 6.0), ("2026-09-13", 3.0)):
        _fyll_dag(n, d, {17: kwh})
    v = n.vurder(2.0)
    assert v["forrige_maned_snitt"] == pytest.approx(6.0)
    assert v["placeholder_kwh"] == pytest.approx(6.0)     # huset pleier å toppe over målet → konservativt
    # hytta uten historikk: plassholderen er målet, ikke 9,5 — og grensen blir brukbar
    hytte = KiNettleie(FakeHub(num={"ki_maks_time_kwh": 9.5, "ki_min_time_kwh": 2.5, "ki_mal_trinn_kw": 5.0, "ki_reserve_topp_kwh": 0.4}))
    v2 = hytte.vurder(2.0)
    assert v2["placeholder_kwh"] == 5.0
    # reserve 0,4 + 0,2 for usikker historikk: 3·(5 − 0,6) − 5 − 5 = 3,2. Før: 2,5 (laveste) hele første døgnet.
    assert v2["grense_kwh"] == pytest.approx(3.2)


# ----------------------------------------------------------------------
#  Bereder i bortemodus
# ----------------------------------------------------------------------
def _vvb(**kw) -> KiVvb:
    h = _Hub(**kw)
    v = KiVvb(h)
    h.vvb = v
    return v


def test_bereder_hviler_i_bortemodus_men_ikke_for_fristen_eller_ankomst():
    naa = dt_util.now()
    v = _vvb(cfg={"vvb_bryter": "switch.vvb", "vvb_effekt": "s.vvb"},
             on={"ki_vvb_borte_sparing": True, "ki_helgemodus": True, "ki_vvb_prisstyring": True},
             num={"ki_vvb_maks_dager": 7, "ki_vvb_klar_for_ankomst_timer": 3},
             sensor={"ki_alle_borte": True},
             states={"switch.vvb": _state("off"), "s.vvb": _state(0)},
             tid={"ki_vvb_vindu_start": "22:00", "ki_vvb_klar_innen": "05:00"})
    v.hub.helpers["ki_vvb_siste_godkjente_syklus"] = SimpleNamespace(verdi=naa - timedelta(days=2))
    v.hub.dt = lambda k: {"ki_vvb_siste_godkjente_syklus": naa - timedelta(days=2)}.get(k)
    aktiv, grunn = v.borte_sparing()
    assert aktiv and "tomt" in grunn
    assert v.reservasjon()[0] == 0.0 and v.reservasjon_om(60) == 0.0
    # legionellafristen nærmer seg → varmer likevel
    v.hub.dt = lambda k: {"ki_vvb_siste_godkjente_syklus": naa - timedelta(days=6.5)}.get(k)
    assert not v.borte_sparing()[0]
    # ankomst om to timer → varmer
    v.hub.dt = lambda k: {"ki_vvb_siste_godkjente_syklus": naa - timedelta(days=2),
                          "ki_hjemkomst_planlagt": naa + timedelta(hours=2)}.get(k)
    v.hub._on["ki_hjemkomst_aktiv"] = True
    aktiv, grunn = v.borte_sparing()
    assert not aktiv and "ankomst" in grunn
    # ankomst om ti timer → hviler fortsatt
    v.hub.dt = lambda k: {"ki_vvb_siste_godkjente_syklus": naa - timedelta(days=2),
                          "ki_hjemkomst_planlagt": naa + timedelta(hours=10)}.get(k)
    assert v.borte_sparing()[0]
    # noen er hjemme → aldri
    v.hub._sensor["ki_alle_borte"] = False
    assert not v.borte_sparing()[0]


# ----------------------------------------------------------------------
#  Lading: faser, spenning, lærte trinn
# ----------------------------------------------------------------------
def test_trinn_kw_etter_faser_og_spenning():
    assert trinn_kw(16) == pytest.approx(3.68, abs=0.01)
    assert trinn_kw(16, 3, 230) == pytest.approx(6.37, abs=0.01)
    assert trinn_kw(16, 3, 400) == pytest.approx(11.08, abs=0.01)
    assert trinn_kw(16, 3, 400, {"16": 10.6}) == 10.6
    assert velg_trinn(7.0, 0, (5, 10, 16), 3, 230) == 16
    assert velg_trinn(7.0, 0, (5, 10, 16), 3, 400) == 10


def test_lader_laerer_trinnets_effekt_fra_malingen():
    h = _Hub(cfg={"lader_bryter": "switch.l", "ladestrom_knapper": ["button.bil_10a", "button.bil_16a"],
                  "lader_effekt": "s.bil", "lader_faser": "3", "lader_volt": "230"},
             states={"s.bil": _state(6.1, unit_of_measurement="kW")})
    l = KiLading(h)
    assert l.faser() == 3 and l.volt() == 230
    l.satt_trinn = 16
    l.sist_endret = dt_util.utcnow() - timedelta(minutes=5)
    l._laer_trinn(dt_util.utcnow())
    assert h.minne["lading"]["kw_malt"]["16"] == 6.1
    assert l.kw_for(16) == 6.1 and l.kw_for(10) == pytest.approx(3.98, abs=0.01)
    # bilen struper selv (nesten full): læres ikke som trinnets effekt
    h._states["s.bil"] = _state(2.0, unit_of_measurement="kW")
    l._laer_trinn(dt_util.utcnow())
    assert h.minne["lading"]["kw_malt"]["16"] == 6.1


def test_lading_bare_om_natten_med_mindre_batteriet_er_lavt(monkeypatch):
    h = _Hub(cfg={"lader_bryter": "switch.l", "ladestrom_knapper": ["button.bil_10a"], "lader_soc": "s.soc"},
             on={"ki_lading_automatikk": True, "ki_lading_kun_natt": True},
             num={"ki_lading_start_under": 70, "ki_lading_stopp_ved": 80},
             tid={"ki_elbil_fra": "22:00", "ki_elbil_til": "06:00"},
             states={"switch.l": _state("off"), "s.soc": _state(75)})
    l = KiLading(h)
    monkeypatch.setattr(dt_util, "now", lambda: datetime(2026, 10, 6, 14, 0, tzinfo=OSLO))
    v = l.vurder(5.0)
    assert v["handling"] == "av" and "natten" in v["forklaring"]
    h._states["s.soc"] = _state(40)
    assert l.vurder(5.0)["handling"] == "start"
    monkeypatch.setattr(dt_util, "now", lambda: datetime(2026, 10, 6, 23, 0, tzinfo=OSLO))
    h._states["s.soc"] = _state(75)
    assert l.vurder(5.0)["handling"] == "start"


# ----------------------------------------------------------------------
#  Hele integrasjonen i en HA-testinstans
# ----------------------------------------------------------------------
@pytest.mark.asyncio
async def test_nye_entiteter_og_tick_i_ekte_ha(hass):
    entry = await _setup(hass)
    hub = hass.data[DOMAIN][entry.entry_id]
    for eid in ("switch.ki_frostvakt", "switch.ki_vvb_borte_sparing", "switch.ki_lading_kun_natt",
                "number.ki_frost_ute_grense", "number.ki_frost_paslag", "number.ki_frost_alarm_temp",
                "number.ki_vvb_klar_for_ankomst_timer", "number.ki_forvarming_maks_timer", "binary_sensor.ki_frostfare"):
        assert hass.states.get(eid) is not None, eid
    await hub.engine.tick()
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.ki_frostfare").state == "off"
    assert hass.states.get("sensor.ki_nettleie").attributes["modell"] == "elvia"
    assert hass.states.get("sensor.ki_energi_status").state != "fallback"
    tau = hass.states.get("sensor.ki_tidskonstanter")
    assert tau is not None


@pytest.mark.asyncio
async def test_hytte_i_kulda_i_ekte_ha(hass):
    """Hytta i −22: bortetemperaturene løftes, varmepumpa klemmes til sitt minimum, stedsnavnet
    står i varselet, berederen hviler, og nettleiegrensen er brukbar første dag i måneden."""
    from unittest.mock import patch
    from custom_components.ki_energi.const import (PRESETS, DEFAULT_SONER_HYTTE, CONF_PRESET, CONF_HUSTYPE, CONF_SONER,
                                                    CONF_PERSONER, CONF_STED_NAVN, DEFAULT_CONFIG, AKSJON_HELG_NAA)
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    p = PRESETS["hytte"]
    data = dict(DEFAULT_CONFIG); data.update(p["config"])
    data[CONF_PRESET] = "hytte"; data[CONF_HUSTYPE] = "fritidsbolig"; data[CONF_STED_NAVN] = "Strömstad"
    data[CONF_SONER] = {k: dict(v) for k, v in DEFAULT_SONER_HYTTE.items()}
    data[CONF_PERSONER] = [{"key": "voksen", "navn": "Voksen", "type": "voksen", "entity": "person.voksen"}]
    hass.states.async_set("sensor.hytte_strommaler_effekt", "900", {"unit_of_measurement": "W"})
    hass.states.async_set("sensor.hytte_strommaler_imported_energy", "500")
    hass.states.async_set("sensor.hytte_utetemperatur", "-22")
    hass.states.async_set("sensor.hytte_bereder_effekt", "0")
    hass.states.async_set("person.voksen", "not_home")
    for s in DEFAULT_SONER_HYTTE.values():
        for c in s["climate"]:
            attrs = {"temperature": 20, "current_temperature": 11, "hvac_modes": ["off", "heat"]}
            if "varmepumpe" in c:
                attrs.update(min_temp=16, max_temp=30)
            hass.states.async_set(c, "heat", attrs)
        for e in s["effekt"]:
            hass.states.async_set(e, "0")
    entry = MockConfigEntry(domain=DOMAIN, data=data, options={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    hub = hass.data[DOMAIN][entry.entry_id]
    assert hub.sted() == "Strömstad"
    await hub.engine.tick(); await hass.async_block_till_done()
    hub.sett("ki_helgemodus", True); hub.sett("ki_skyggemodus", False)
    kall = []
    async def fang_kall(dom, tj, data):
        kall.append((dom, tj, data))
    hub.kall = fang_kall
    await hub.moduser.tick(); await hub.engine.tick(); await hass.async_block_till_done()

    # frostpåslag: −22 er mer enn ti under grensen (−10) → +4: panelovn 12, gulv 14, bad 16
    mal, grunn, _ = hub.engine.mal_temperatur("soverom_voksen", hub.soner()["soverom_voksen"])
    assert mal == 12.0 and "frostvakt" in grunn
    mal, _, _ = hub.engine.mal_temperatur("kjokken_gulv", hub.soner()["kjokken_gulv"])
    assert mal == 14.0
    frost = hass.states.get("binary_sensor.ki_frostfare")
    assert frost.state == "off" and frost.attributes["paslag"] == 4
    # varmepumpa kan ikke under 16: klemmes, forklares én gang i loggen
    mal, _, _ = hub.engine.mal_temperatur("stue", hub.soner()["stue"])
    assert mal == 12.0
    skrevet = {d["entity_id"]: d["temperature"] for dom, tj, d in kall if tj == "set_temperature"}
    assert skrevet["climate.hytte_stue_varmepumpe"] == 16.0, skrevet
    assert any("16–30" in l["forklaring"] for l in hub.minne["logg"])
    # andre ovner har frostpåslaget som mål (budsjettet kan senke dem noen grader, men målet står)
    rad = next(r for r in hass.states.get("sensor.ki_laster").attributes["laster"] if r["key"] == "soverom_voksen")
    assert rad["mal"] == 12.0 and skrevet["climate.hytte_soverom_voksen"] >= 10.0
    # nettleie: første dag i måneden uten historikk → plassholder = mål, ikke 9,5
    nv = hass.states.get("sensor.ki_nettleie").attributes
    assert nv["placeholder_kwh"] == 5.0 and nv["grense_kwh"] >= 3.0
    assert nv["modell"] == "elvia"
    # berederen hviler i bortemodus (måles bare, men statusen skal si det)
    assert hub.vvb.overvakes()
    # fredagsvarselet bruker stedsnavnet
    varsler = []
    async def fang(tittel, melding, **kw):
        varsler.append(tittel)
    hub.varsle = fang
    with patch("homeassistant.util.dt.now", return_value=dt_util.now().replace(hour=12)):
        await hub.moduser._handling(AKSJON_HELG_NAA)
    assert hub.on("ki_hjemkomst_aktiv")
    # tilstedeværelsesprofilen: ingen hjemme → «b»
    assert hub.engine.tilstede_nokkel() == "b"
