"""Berederen skal ikke slås av midt i en oppvarming.

Effekten leses én gang i minuttet (TICK_SEK), men «aktiv» hadde bare 20 s delay_off. Ett
enkelt tick med lav effekt — en måler som rapporterer 0 et øyeblikk, eller en sensor som er
`unavailable` i noen sekunder — gjorde berederen «ikke aktiv». Var vinduet stengt (eller
timen ikke lenger blant de billigste), slo KI av bryteren i samme tick, før termostaten
hadde koblet ut. Vannet ble aldri ferdig oppvarmet.
"""
from datetime import datetime, timedelta

import pytest
from homeassistant.util import dt as dt_util

from custom_components.ki_energi import vvb as vvb_mod
from custom_components.ki_energi.const import CONF_VVB_BRYTER, CONF_VVB_EFFEKT
from custom_components.ki_energi.vvb import KiVvb


class Hub:
    def __init__(self, klokke):
        self.klokke = klokke
        self.minne = {}
        self.lagret = {"ki_vvb_siste_godkjente_syklus": klokke[0] - timedelta(days=1)}
        self.bryter = "off"
        self.effekt = 0.0
        self.kall_logg = []
        self.engine = None

    def cfg(self, n, std=None):
        return {CONF_VVB_BRYTER: "switch.vvb", CONF_VVB_EFFEKT: "sensor.vvb_effekt"}.get(n, std)

    def st(self, e):
        return self.bryter if e == "switch.vvb" else None

    def f(self, e):
        return self.effekt if e == "sensor.vvb_effekt" else None

    def on(self, n, std=False):
        return bool(self.lagret.get(n, std))

    def num(self, n, std=0):
        return float(self.lagret.get(n, std))

    def pa(self, e):
        return False

    def sett(self, n, v):
        self.lagret[n] = v

    def dt(self, n):
        return self.lagret.get(n)

    def sett_sensor(self, *a, **k):
        pass

    def sensor_state(self, n):
        return None

    def attr(self, e, n, std=None):
        return std

    def tid_min(self, n, std):
        t, m = std.split(":")
        return int(t) * 60 + int(m)

    def tid_str(self, n, std):
        return std

    def naa_min(self):
        n = self.klokke[0]
        return n.hour * 60 + n.minute

    def mellom(self, start, slutt, naa=None):
        naa = self.naa_min() if naa is None else naa
        return (start <= naa < slutt) if start <= slutt else (naa >= start or naa < slutt)

    async def kall(self, domene, tjeneste, data):
        self.kall_logg.append(tjeneste)
        self.bryter = "on" if tjeneste == "turn_on" else "off"

    async def logbook(self, *a):
        pass

    async def varsle(self, *a, **k):
        pass


@pytest.fixture
def oppsett(monkeypatch):
    klokke = [datetime(2026, 10, 19, 4, 40, tzinfo=dt_util.get_default_time_zone())]
    monkeypatch.setattr(vvb_mod.dt_util, "now", lambda: klokke[0])
    h = Hub(klokke)
    return KiVvb(h), h, klokke


async def _minutter(v, klokke, n):
    for _ in range(n):
        klokke[0] += timedelta(minutes=1)
        await v.tick()


async def _start_oppvarming(v, h, klokke):
    """Vinduet er åpent (22–05). KI slår på, elementet trekker 2 kW."""
    await v.tick()
    assert h.bryter == "on"
    h.effekt = 2000.0
    await _minutter(v, klokke, 3)
    assert v.var_aktiv


@pytest.mark.parametrize("glipp", [0.0, None], ids=["maaler-viser-0", "sensor-unavailable"])
async def test_ett_tick_med_lav_effekt_slaar_ikke_av_etter_vinduet(oppsett, glipp):
    v, h, klokke = oppsett
    await _start_oppvarming(v, h, klokke)
    # Forbi kl. 05:00 — vinduet er stengt, men termostaten har ikke koblet ut ennå.
    await _minutter(v, klokke, 25)
    assert klokke[0].hour == 5 and h.bryter == "on"

    h.effekt = glipp                 # ett minutt med glipp i målingen
    await _minutter(v, klokke, 1)
    h.effekt = 2000.0                # elementet varmet hele tiden
    await _minutter(v, klokke, 1)

    assert h.kall_logg.count("turn_off") == 0, "KI slo av berederen midt i oppvarmingen"
    assert h.bryter == "on"


async def test_slaar_av_naar_termostaten_kobler_ut(oppsett):
    """Kontroll: ekte metning etter vinduet slår fortsatt av."""
    v, h, klokke = oppsett
    await _start_oppvarming(v, h, klokke)
    await _minutter(v, klokke, 25)
    h.effekt = 3.0
    await _minutter(v, klokke, 10)
    assert h.bryter == "off"
    assert v._dt("ki_vvb_siste_godkjente_syklus") > klokke[0] - timedelta(minutes=5)


async def test_utenfor_vinduet_uten_oppvarming_slaas_av(oppsett):
    """Kontroll: står bryteren på utenfor vinduet uten at elementet varmer, slås den av."""
    v, h, klokke = oppsett
    klokke[0] = klokke[0].replace(hour=12)
    h.bryter = "on"
    await _minutter(v, klokke, 2)
    assert h.bryter == "off"


# ----------------------------------------------------------------------
#  Gjennomgang 1–4
# ----------------------------------------------------------------------
async def test_tvungen_syklus_fra_tjenesten_slaas_ikke_av(oppsett):
    """Tjenesten «tving syklus» midt på dagen (vinduet ferdig, legionella ok)."""
    v, h, klokke = oppsett
    klokke[0] = klokke[0].replace(hour=13)
    h.lagret["ki_vvb_siste_godkjente_syklus"] = klokke[0] - timedelta(hours=10)
    await v.tving_syklus()
    assert h.bryter == "on"
    h.effekt = 2000.0
    await _minutter(v, klokke, 5)
    assert "turn_off" not in h.kall_logg
    h.effekt = 3.0
    await _minutter(v, klokke, 10)
    assert h.bryter == "off"
    assert not h.on("ki_vvb_tvungen_syklus_aktiv")


async def test_spotpris_uten_priser_faller_tilbake_paa_vinduet(oppsett, monkeypatch):
    v, h, klokke = oppsett
    from custom_components.ki_energi.const import CONF_NORDPOOL
    cfg = Hub.cfg
    monkeypatch.setattr(Hub, "cfg", lambda self, n, std=None: "sensor.nordpool" if n == CONF_NORDPOOL else cfg(self, n, std))
    h.lagret["ki_vvb_folg_spotpris"] = True
    klokke[0] = klokke[0].replace(hour=23)
    await v.tick()                       # attr gir [] → ingen billige timer
    assert v.billige_timer == []
    assert h.bryter == "on", "uten priser skal vinduet gjelde"


async def test_egen_avslaaing_varsles_ikke_som_ekstern(oppsett):
    """KI slår på 04:59, vinduet stenger 05:00 før elementet er registrert, KI slår av.
    Det er ikke «noe annet» som styrer berederen."""
    v, h, klokke = oppsett
    klokke[0] = klokke[0].replace(hour=4, minute=59)
    await v.tick()
    assert h.bryter == "on"
    await _minutter(v, klokke, 1)
    assert h.bryter == "off"
    await _minutter(v, klokke, 3)
    assert v._ekstern_teller == 0
    assert v._ekstern_av_til is None


async def test_relé_unavailable_er_ikke_ekstern_avslaaing(oppsett):
    v, h, klokke = oppsett
    await v.tick()
    assert h.bryter == "on"
    h.bryter = "unavailable"
    await _minutter(v, klokke, 1)
    assert v._ekstern_teller == 0


async def test_boost_avsluttes_ved_metning_og_releet_klikker_ikke(oppsett):
    v, h, klokke = oppsett
    klokke[0] = klokke[0].replace(hour=13)
    h.lagret["ki_vvb_siste_godkjente_syklus"] = klokke[0] - timedelta(hours=10)
    await v.boost(120)
    h.effekt = 2000.0
    await _minutter(v, klokke, 20)
    h.effekt = 3.0
    await _minutter(v, klokke, 60)
    assert h.bryter == "off"
    assert h.kall_logg.count("turn_on") == 1, h.kall_logg
    assert not v.boost_aktiv()
