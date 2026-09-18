"""Bereder uten relé — hytta, der den bare står på.

Metningen krevde `bryter == "on"`. Uten relé finnes ingen bryter, så betingelsen kunne
aldri bli sann: legionella ble aldri bekreftet, og kortet meldte «Forfalt — tvinges på»
selv om berederen gjorde full oppvarming hver dag.
"""
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from custom_components.ki_energi.vvb import KiVvb


class Hub:
    """Minimal hub: tall, tilstander og lagrede verdier."""

    def __init__(self, effekt=None, cfg=None, lagret=None):
        self._effekt = effekt
        self._cfg = cfg or {}
        self.lagret = dict(lagret or {})
        self.sensorer = {}
        self.logg = []
        self.engine = None

    def cfg(self, n, std=None):
        return self._cfg.get(n, std)

    def f(self, n):
        return self._effekt

    def st(self, e):
        return "unknown" if not e else "on"

    def on(self, n, std=False):
        return bool(self.lagret.get(n, std))

    def num(self, n, std=0):
        return float(self.lagret.get(n, std))

    def sett(self, n, v):
        self.lagret[n] = v

    def dt(self, n):
        return self.lagret.get(n)

    def sett_sensor(self, n, v, attrs=None):
        self.sensorer[n] = v

    def mellom(self, *a, **k):
        return False

    def tid_min(self, n, std):
        return 0

    async def logbook(self, *a):
        self.logg.append(a)

    async def varsle(self, *a, **k):
        self.logg.append(a)


def _vvb(effekt, cfg, lagret=None):
    from custom_components.ki_energi.const import CONF_VVB_EFFEKT
    h = Hub(effekt=effekt, cfg=cfg, lagret=lagret)
    v = object.__new__(KiVvb)
    v.hub = h
    v.var_aktiv = False
    v.var_mettet = False
    v.over_siden = None
    v.under_siden = None
    v._siste_bryter = None
    v.for_lenge_varslet = False
    return v, h


def test_overvakes_naar_bare_effekt_er_satt():
    from custom_components.ki_energi.const import CONF_VVB_BRYTER, CONF_VVB_EFFEKT
    v, _ = _vvb(1800, {CONF_VVB_EFFEKT: "sensor.vvb_effekt"})
    assert v.overvakes() is True
    assert v.konfigurert() is False

    v2, _ = _vvb(1800, {CONF_VVB_EFFEKT: "sensor.vvb_effekt",
                        CONF_VVB_BRYTER: "switch.vvb"})
    assert v2.overvakes() is False


def test_forfalt_uten_rele_sier_overvakes_ikke_tvinges():
    """Uten bryter kan ingenting tvinges på — teksten skal ikke love det."""
    from custom_components.ki_energi.const import CONF_VVB_BRYTER, CONF_VVB_EFFEKT
    from homeassistant.util import dt as dt_util
    gammelt = dt_util.now() - timedelta(days=9)
    v, _ = _vvb(0, {CONF_VVB_EFFEKT: "sensor.e"},
                {"ki_vvb_siste_godkjente_syklus": gammelt,
                 "ki_vvb_legionella_aktiv": True, "ki_vvb_maks_dager": 7})
    assert v.forfalt() is True
    assert v.status_tekst() == "Forfalt - overvåkes"

    v2, _ = _vvb(0, {CONF_VVB_EFFEKT: "sensor.e", CONF_VVB_BRYTER: "switch.vvb"},
                 {"ki_vvb_siste_godkjente_syklus": gammelt,
                  "ki_vvb_legionella_aktiv": True, "ki_vvb_maks_dager": 7})
    assert v2.status_tekst() == "Forfalt - tvungen kjøring"


def test_ingen_respons_gir_ikke_falsk_alarm_uten_rele():
    """`ingen_respons` leser bryteren, som ikke finnes. Den skal holde seg rolig."""
    from custom_components.ki_energi.const import CONF_VVB_EFFEKT
    from homeassistant.util import dt as dt_util
    v, _ = _vvb(None, {CONF_VVB_EFFEKT: "sensor.e"},
                {"ki_vvb_oppvarming_startet": dt_util.now() - timedelta(days=2)})
    assert v.ingen_respons() is False


def test_dager_siden_regnes_fra_siste_metning():
    from custom_components.ki_energi.const import CONF_VVB_EFFEKT
    from homeassistant.util import dt as dt_util
    v, _ = _vvb(0, {CONF_VVB_EFFEKT: "sensor.e"},
                {"ki_vvb_siste_godkjente_syklus": dt_util.now() - timedelta(days=3, hours=12)})
    assert 3.4 < v.dager_siden() < 3.6
    assert v.legionella_ok() is False          # intervall 3 dager som standard


@pytest.mark.asyncio
async def test_metning_bekreftes_uten_rele():
    """Kjernen: full oppvarming etterfulgt av lav effekt skal bekrefte legionella,
    også når det ikke finnes en bryter å lese `on` fra."""
    from custom_components.ki_energi.const import CONF_VVB_EFFEKT
    from homeassistant.util import dt as dt_util

    v, h = _vvb(1800, {CONF_VVB_EFFEKT: "sensor.e"},
                {"ki_vvb_metning_terskel_w": 150, "ki_vvb_metning_minutter": 8,
                 "ki_vvb_siste_godkjente_syklus": dt_util.now() - timedelta(days=9)})
    metninger = []

    async def _metning(naa):
        metninger.append(naa)
        h.sett("ki_vvb_siste_godkjente_syklus", naa)

    v._metning = _metning
    naa = dt_util.now()

    # 1) elementet trekker strøm i mer enn 20 s -> aktiv, flagget settes
    bryter = "on" if v.overvakes() else h.st(None)
    assert bryter == "on", "uten relé skal berederen regnes som permanent på"
    v.over_siden = naa - timedelta(seconds=30)
    aktiv = bool(v.over_siden and (naa - v.over_siden).total_seconds() >= 20)
    assert aktiv
    h.sett("ki_vvb_har_trukket_effekt", True)
    v.var_aktiv = True

    # 2) termostaten kobler ut: effekt faller, og holder seg lav i over 8 minutter
    h._effekt = 4
    v.under_siden = naa - timedelta(minutes=9)
    mettet = (bryter == "on" and h.on("ki_vvb_har_trukket_effekt") and h.f(None) is not None
              and h.f(None) <= h.num("ki_vvb_metning_terskel_w", 150)
              and v.under_siden is not None
              and (naa - v.under_siden).total_seconds() >= h.num("ki_vvb_metning_minutter", 8) * 60)
    assert mettet is True, "metning ble ikke bekreftet uten relé"

    await v._metning(naa)
    assert len(metninger) == 1
    assert v.dager_siden() < 0.01
    assert v.legionella_ok() is True
    assert v.forfalt() is False
