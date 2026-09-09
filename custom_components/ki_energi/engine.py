"""KI energimotor.

Lag 1  budsjett     kWh igjen av klokketimen mot dynamisk grense (Elvia: snitt av tre topper)
Lag 2  prognose     innlært lastprofil + kjente hendelser + varmtvann, 15/30/60/120 min
Lag 3  laster       måltemperatur per sone ut fra profil, modus, tilstedeværelse og forvarming
Lag 4  fordeling    prioritetsmotor som fordeler budsjettet og senker det som må vike
Lag 5  aktuator     eneste som skriver til climate.*  (aldri i skyggemodus)
Lag 6  forklaring   norsk setning per beslutning + beslutningslogg

All logikk er rene metoder som leser via hub og skriver via hub. Ingen
tilstand utenom hub.minne, som lagres i .storage.
"""
from __future__ import annotations

import logging
import math
import traceback
from datetime import datetime, timedelta, timezone

from homeassistant.core import callback
from homeassistant.util import dt as dt_util

from .const import (
    CONF_VVB_BRYTER, CONF_HANKLEVARMER, CONF_HAR_ELBIL,
    CONF_GARDINER,
    CONF_ENERGILEDD_DAG, CONF_ENERGILEDD_NATT, CONF_GLASS_M2, CONF_HANKLEVARMER_EFFEKT,
    CONF_HVITEVARER, CONF_IMPORTERT_ENERGI, CONF_PRESET, PRESETS, PROFIL_LEGACY, CONF_STROMPRIS,
    CONF_TOPP1, CONF_TOPP2, CONF_TOPP3, CONF_TOTAL_EFFEKT, CONF_UTE_TEMP,
    CONF_VAER, CONF_VVB_EFFEKT, MAKS_LOGG_LINJER, PRIO_VEKT, TICK_SEK, Z_PROFIL, Z_TEMP_BORTE,
    Z_TEMP_DAG, Z_TEMP_NATT,
)
from .hub import KiHub

_LOGGER = logging.getLogger(__name__)


class KiEngine:
    def __init__(self, hub: KiHub) -> None:
        self.hub = hub
        self.sist_skrevet: dict[str, float] = {}
        self.sist_skrevet_tid: dict[str, datetime] = {}
        self.logg_signatur = ""
        self.temp_forrige: dict[str, tuple[float, float]] = {}
        self.endret = False
        self.siste_tick: datetime | None = None
        self.hjemkomst_forklaring = ""
        self.vindu_apent_siden: dict[str, datetime] = {}
        self.nettleie_vurdering: dict | None = None

    # ------------------------------------------------------------------
    #  Små hjelpere
    # ------------------------------------------------------------------
    @callback
    def marker_endring(self, key: str) -> None:
        self.endret = True

    @property
    def st(self):
        return self.hub.minne["state"]

    def _tau(self, key: str) -> tuple[float, float, int]:
        t = self.hub.minne["tau"].get(key, {})
        return t.get("k", 0.08), t.get("varme_rate", 1.2), t.get("n", 0)

    # ------------------------------------------------------------------
    #  Måling: styrt, hvitevarer, uregulert, denne timen
    # ------------------------------------------------------------------
    def styrt_effekt_w(self) -> float | None:
        h = self.hub
        if h.f(h.cfg(CONF_TOTAL_EFFEKT)) is None:
            return None
        s = 0.0
        for konf in h.aktive_soner().values():
            for ent in konf.get("effekter") or [konf.get("effekt")]:
                v = h.f(ent)
                if v is not None and v >= 0:
                    s += v
        # bereder som bare måles (ingen bryter) er uregulert last og læres inn i profilen
        styrbare = [h.cfg(CONF_HANKLEVARMER_EFFEKT)]
        if h.vvb is not None and h.vvb.konfigurert():
            styrbare.append(h.cfg(CONF_VVB_EFFEKT))
        for ent in styrbare:
            v = h.f(ent)
            if v is not None and v >= 0:
                s += v
        return round(s, 0)

    def hvitevarer_w(self) -> float:
        s = 0.0
        for ent in self.hub.cfg(CONF_HVITEVARER, []) or []:
            v = self.hub.f(ent)
            if v is not None and v >= 0:
                s += v
        return round(s, 0)

    @callback
    def oppdater_effektsensorer(self) -> None:
        """Kjøres når totaleffekten endrer seg — gir fine kurver i kortet."""
        h = self.hub
        total = h.f(h.cfg(CONF_TOTAL_EFFEKT))
        styrt = self.styrt_effekt_w()
        hv = self.hvitevarer_w()
        h.sett_sensor("ki_hvitevarer_effekt", hv)
        if total is None or styrt is None:
            h.sett_sensor("ki_styrt_effekt", None)
            h.sett_sensor("ki_uregulert_effekt", None)
            return
        h.sett_sensor("ki_styrt_effekt", styrt)
        h.sett_sensor("ki_uregulert_effekt", max(total - styrt, 0.0))

    def forbrukt_denne_timen(self) -> tuple[float | None, str]:
        """kWh brukt hittil i klokketimen, fra timemåleren (tidsstemplet nullpunkt ved hele timen)."""
        h = self.hub
        if h.nettleie is None:
            return None, ""
        kwh, kv = h.nettleie.forelopig_time()
        if kwh is None:
            return None, ""
        # Registre som oppdaterer seg sjelden: legg til øyeblikkseffekt × tid siden siste prøve,
        # ellers står «brukt» på 0 til neste oppdatering.
        tillegg = ""
        siste = h.nettleie.siste_prove_ts()
        if siste is not None:
            alder_s = dt_util.utcnow().timestamp() - siste
            if alder_s > 120:
                total_kw = (h.f(h.cfg(CONF_TOTAL_EFFEKT), 0.0) or 0.0) / 1000.0
                kwh += total_kw * alder_s / 3600.0
                tillegg = f" + anslag for {int(alder_s // 60)} min siden registeret sist oppdaterte seg"
        if kv == "forelopig_estimert":
            return kwh, "timesmåling mot energiregisteret — nullpunktet ved timeskiftet er interpolert (estimert)" + tillegg
        if kv == "forelopig_delvis":
            return kwh, "timesmåling fra første prøve etter oppstart — forbruket før den er ikke med (delvis)" + tillegg
        return kwh, "timesmåling mot energiregisteret (nullpunkt målt ved timeskiftet)" + tillegg

    # ------------------------------------------------------------------
    #  Budsjett
    # ------------------------------------------------------------------
    def dynamisk_grense(self) -> tuple[float, str]:
        """Økonomisk timegrense fra nettleiemodellen (døgnmaks per dato, topp tre, tarifftrinn).
        Den absolutte grensen ki_maks_time_kwh gjelder alltid i tillegg."""
        h = self.hub
        hard = h.num("ki_maks_time_kwh", 4.9)
        if not h.on("ki_dynamisk_grense", True) or h.nettleie is None:
            return hard, "Fast grense"
        v = h.nettleie.vurder()
        self.nettleie_vurdering = v
        return v["grense_kwh"], v["hvorfor"]

    def budsjett(self) -> dict:
        h = self.hub
        grense, grense_grunn = self.dynamisk_grense()
        forbrukt, kilde = self.forbrukt_denne_timen()
        n = dt_util.now()
        minutter_igjen = 60 - n.minute - n.second / 60.0
        timer_igjen = max(minutter_igjen / 60.0, 0.02)
        usikker = False
        if forbrukt is None:
            effekt = (h.f(h.cfg(CONF_TOTAL_EFFEKT), 0.0) or 0.0) / 1000.0
            forbrukt = effekt * (n.minute / 60.0)
            kilde = "anslag fra øyeblikkseffekt — energiregisteret svarer ikke"
            usikker = True
        igjen = grense - forbrukt
        timer_effektiv = max(timer_igjen, 0.25)
        tillatt = min(igjen / timer_effektiv, grense)
        return dict(grense=grense, grense_grunn=grense_grunn, kilde=kilde,
                    forbrukt=round(forbrukt, 3), igjen=round(igjen, 3),
                    timer_igjen=round(timer_igjen, 3), minutter_igjen=int(minutter_igjen),
                    tillatt_snitt=round(tillatt, 3), usikker=usikker,
                    tak_aktivt=bool(igjen / timer_effektiv > grense))

    def sone_farge(self, bruk_kw: float, tillatt_kw: float) -> str:
        h = self.hub
        if tillatt_kw <= 0:
            return "kritisk"
        andel = 100.0 * bruk_kw / max(tillatt_kw, 0.05)
        if andel >= 110:
            return "kritisk"
        if andel >= h.num("ki_sone_rod", 97):
            return "rod"
        if andel >= h.num("ki_sone_oransje", 88):
            return "oransje"
        if andel >= h.num("ki_sone_gul", 75):
            return "gul"
        return "gronn"

    # ------------------------------------------------------------------
    #  Prognose
    # ------------------------------------------------------------------
    @staticmethod
    def profilnokkel(t: datetime | None = None) -> str:
        t = t or dt_util.now()
        return f"{t.weekday()}-{t.hour}"

    def profil_hent(self, nokkel: str, standard: float = 0.4) -> tuple[float, int]:
        rad = self.hub.minne["profil"].get(nokkel)
        if not rad:
            return standard, 0
        return rad.get("kw", standard), rad.get("n", 0)

    def prognose_uregulert(self, minutter_frem: int = 0) -> float:
        naa = (self.hub.sensor_state("ki_uregulert_effekt") or 0.0) / 1000.0
        profil, antall = self.profil_hent(self.profilnokkel(dt_util.now() + timedelta(minutes=minutter_frem)))
        if antall < 3:
            return max(naa, 0.25)
        vekt = min(1.0, minutter_frem / 45.0)
        return max(0.15, naa * (1 - vekt) + profil * vekt)

    @staticmethod
    def hvitevare_type(entity_id: str) -> str:
        """Hva slags hvitevare er dette? Bestemmer hvor lenge lasten forventes å vare.
        lang: komfyr/stekeovn/oppvask/vask/tørk (≈ time). kort: mikro/vannkoker/kaffe (minutter).
        base: kjøleskap/fryser (jevnt hele døgnet — inngår i grunnlasten, ikke som hendelse)."""
        n = entity_id.lower()
        if any(o in n for o in ("kjol", "kjøl", "fridge", "frys", "freez")):
            return "base"
        if any(o in n for o in ("mikro", "micro", "vannkok", "kettle", "kaffe", "coffee", "brod", "toast")):
            return "kort"
        return "lang"

    def hvitevarer_naa(self) -> dict[str, float]:
        """Effekt (kW) per hvitevaretype akkurat nå."""
        h = self.hub
        ut = {"lang": 0.0, "kort": 0.0, "base": 0.0}
        for e in (h.cfg(CONF_HVITEVARER, []) or []):
            v = h.f(e)
            if v is not None and v > 0:
                ut[self.hvitevare_type(e)] += v / 1000.0
        return ut

    def kjente_hendelser(self, minutter_frem: int = 0) -> tuple[float, list[str]]:
        """Laster vi vet om som profilen ikke nødvendigvis har fanget opp."""
        h = self.hub
        ekstra, grunner = 0.0, []
        hv = self.hvitevarer_naa()
        if hv["lang"] > 0.3 and minutter_frem <= 30:
            ekstra += hv["lang"] * 0.6
            grunner.append(f"hvitevarer går ({hv['lang']:.1f} kW)")
        if hv["kort"] > 0.3 and minutter_frem <= 5:
            ekstra += hv["kort"] * 0.2   # mikro/vannkoker: er borte om få minutter
            grunner.append(f"kortvarig last ({hv['kort']:.1f} kW)")
        t = (h.naa_min() + minutter_frem) % (24 * 60)
        if h.mellom(h.tid_min("ki_frokost_start", "06:30"), h.tid_min("ki_frokost_slutt", "08:30"), t):
            r = h.num("ki_reserve_frokost_kwh", 0.7)
            _p, n = self.profil_hent(self.profilnokkel(dt_util.now() + timedelta(minutes=minutter_frem)))
            if n < 10 and r > 0:
                ekstra += r * 0.5
                grunner.append("frokostvinduet")
        if h.cfg(CONF_HAR_ELBIL, False) and h.on("ki_elbil_natt") and h.num("ki_elbil_effekt_kw", 0) > 0 \
                and h.mellom(h.tid_min("ki_elbil_fra", "22:00"), h.tid_min("ki_elbil_til", "06:00"), t):
            kw = h.num("ki_elbil_effekt_kw", 0)
            _p, n = self.profil_hent(self.profilnokkel(dt_util.now() + timedelta(minutes=minutter_frem)))
            ekstra += kw if n < 10 else kw * 0.5
            grunner.append(f"elbillading ({kw:.1f} kW)")
        if h.mellom(h.tid_min("ki_middag_start", "15:30"), h.tid_min("ki_middag_slutt", "19:00"), t):
            r = h.num("ki_reserve_middag_kwh", 1.0)
            _p, n = self.profil_hent(self.profilnokkel(dt_util.now() + timedelta(minutes=minutter_frem)))
            if n < 10 and r > 0:
                ekstra += r * 0.5
                grunner.append("middagsvinduet")
        return ekstra, grunner

    # ------------------------------------------------------------------
    #  Sol og nattsenking
    # ------------------------------------------------------------------
    def solfaktor(self) -> float:
        h = self.hub
        if not h.on("ki_solkompensasjon", True):
            return 0.0
        try:
            hoyde = float(h.attr("sun.sun", "elevation", -90))
        except (TypeError, ValueError):
            return 0.0
        if hoyde <= 3:
            return 0.0
        try:
            skyer = float(h.attr(h.cfg(CONF_VAER), "cloud_coverage", 50))
        except (TypeError, ValueError):
            skyer = 50.0
        klarhet = max(0.0, 1.0 - skyer / 100.0)
        return round(min(1.0, math.sin(math.radians(hoyde)) * 1.6) * klarhet, 2)

    def vindu_apent(self, key: str, konf: dict) -> tuple[bool, str]:
        """Er et vindu/dør i sonen åpent lenger enn forsinkelsen? Returnerer (åpent, hvilket)."""
        h = self.hub
        apne = [e for e in (konf.get("vindu") or []) if h.pa(e)]
        if not apne or not h.on("ki_vindu_stopp", True):
            self.vindu_apent_siden.pop(key, None)
            return False, ""
        naa = dt_util.now()
        siden = self.vindu_apent_siden.setdefault(key, naa)
        if (naa - siden) < timedelta(minutes=h.num("ki_vindu_forsinkelse_min", 3)):
            return False, ""
        st = h.hass.states.get(apne[0])
        navn = st.attributes.get("friendly_name", apne[0]) if st else apne[0]
        return True, navn + (f" (+{len(apne) - 1})" if len(apne) > 1 else "")

    def sol_trekk(self, konf: dict) -> float:
        if not konf.get("sol"):
            return 0.0
        sf = self.solfaktor()
        if sf <= 0.15:
            return 0.0
        glass = float(self.hub.cfg(CONF_GLASS_M2, 20) or 20)
        return round(sf * 1.5 * min(2.0, glass / 20.0), 2)

    def nattsenk_lonnsomt(self, key: str) -> tuple[bool, str]:
        """Spart energi ~ C*k*dybde*timer, gjenoppvarming ~ C*dybde. k*timer mot prisforhold."""
        h = self.hub
        if not h.on("ki_nattsenk_aktiv", True):
            return False, "Nattsenking er slått av"
        if not h.on("ki_nattsenk_okonomi", True):
            return True, "Økonomivurdering er slått av"
        ute = h.f(h.cfg(CONF_UTE_TEMP))
        grense = h.num("ki_natt_senk_ute_grense", 12)
        if ute is not None and ute >= grense:
            return False, f"Mildt ute ({ute:.0f} °C) — ovnene står nesten stille uansett"
        k, _rate, antall = self._tau(key)
        natt = h.tid_min("ki_tid_natt_start", "22:30")
        dag = h.tid_min("ki_tid_dag_start", "06:30")
        timer = ((dag - natt) % (24 * 60)) / 60.0
        gevinst = k * timer
        pris_natt = h.f(h.cfg(CONF_ENERGILEDD_NATT))
        pris_dag = h.f(h.cfg(CONF_ENERGILEDD_DAG))
        if pris_natt and pris_dag and pris_natt > 0:
            energi = h.f(h.cfg(CONF_STROMPRIS), 1.0) or 1.0
            forhold = (energi + pris_dag) / (energi + pris_natt)
        else:
            forhold = 1.0
        if antall < 5:
            return True, "Lærer fortsatt tidskonstanten for denne sonen"
        if gevinst > forhold:
            return True, f"Sparer ca. {gevinst / forhold:.1f}× gjenoppvarmingen"
        return False, (f"Lønner seg ikke — {timer:.0f} t senking gir {gevinst:.2f} "
                       f"mot {forhold:.2f} i gjenoppvarming til dagpris")

    # ------------------------------------------------------------------
    #  Måltemperatur per sone
    # ------------------------------------------------------------------
    def leggetid_aktiv(self, key: str) -> datetime | None:
        """Er «leggetid» trykket for sonen, og gjelder den ennå? Returnerer sluttidspunkt."""
        lt = self.st.get("leggetid", {}).get(key)
        if not lt:
            return None
        til = dt_util.parse_datetime(lt)
        if til is None or dt_util.now() >= til:
            self.st["leggetid"].pop(key, None)
            self.hub.lagre()
            return None
        return til

    def vekketid(self, key: str, konf: dict) -> int:
        """Når sonen normalt skal være varm igjen (minutter siden midnatt)."""
        h = self.hub
        p = self.person_for(konf)
        if p and p["type"] == "barn":
            return h.tid_min(f"ki_{p['key']}_dag", "05:30")
        if p and p["type"] == "ungdom":
            helg = (dt_util.now() + timedelta(hours=8)).weekday() >= 5 or h.on(f"ki_{p['key']}_ferie")
            return h.tid_min(f"ki_{p['key']}_vekking_helg" if helg else f"ki_{p['key']}_vekking", "07:00")
        return h.tid_min("ki_tid_dag_start", "06:30")

    def person_for(self, konf: dict) -> dict | None:
        """Personen en sone er knyttet til via profil «person:<key>» (eller gamle navn)."""
        profil = PROFIL_LEGACY.get(konf.get(Z_PROFIL, ""), konf.get(Z_PROFIL, ""))
        if not str(profil).startswith("person:"):
            return None
        return self.hub.person(profil.split(":", 1)[1])

    async def leggetid(self, sone: str, avbryt: bool = False) -> None:
        """Start kveldssenking i sonen nå — varer til sonens vekketid."""
        soner = self.hub.aktive_soner()
        if sone not in soner:
            _LOGGER.error("leggetid: ukjent sone %s", sone)
            return
        lt = self.st.setdefault("leggetid", {})
        if avbryt:
            lt.pop(sone, None)
            self.logg_hendelse(f"Leggetid avbrutt for {soner[sone]['navn']}.")
        else:
            vekk = self.vekketid(sone, soner[sone])
            naa = dt_util.now()
            til = naa.replace(hour=vekk // 60, minute=vekk % 60, second=0, microsecond=0)
            if til <= naa:
                til += timedelta(days=1)
            lt[sone] = til.isoformat(timespec="seconds")
            self.logg_hendelse(f"Leggetid: {soner[sone]['navn']} senkes nå, varmes til kl. {til:%H:%M}.")
        self.hub.lagre()
        await self.tick()

    async def sett_prio(self, sone: str, prio: int) -> None:
        """Flytt en sone i prioritetsrekkefølgen (1 = viktigst)."""
        if sone not in self.hub.soner():
            _LOGGER.error("sett_prio: ukjent sone %s", sone)
            return
        self.st.setdefault("prio_overstyring", {})[sone] = max(1, min(5, int(prio)))
        self.hub.lagre()
        self.logg_hendelse(f"Prioritet for {self.hub.soner()[sone]['navn']} satt til {int(prio)}.")
        await self.tick()

    def overstyring(self, key: str) -> dict | None:
        o = self.st.get("overstyringer", {}).get(key)
        if not o:
            return None
        try:
            if dt_util.now() >= dt_util.parse_datetime(o["til"]):
                self.st["overstyringer"].pop(key, None)
                self.hub.lagre()
                return None
        except Exception:  # noqa: BLE001
            return None
        return o

    def dagmal(self, key: str, konf: dict) -> float:
        """Måltemperaturen som gjelder etter neste frist — brukes til forvarming."""
        return self.hub.num(konf.get(Z_TEMP_DAG) or "", 21.0)

    def hjemkomst_frist(self) -> int | None:
        """Minutter siden midnatt for planlagt hjemkomst, eller None."""
        h = self.hub
        if not h.on("ki_hjemkomst_aktiv"):
            return None
        plan = h.dt("ki_hjemkomst_planlagt")
        if plan is None:
            return h.tid_min("ki_hjemkomst_tid", "13:00")
        if plan - dt_util.now() > timedelta(hours=20):
            return None   # for langt fram — forvarming starter først når fristen er innen rekkevidde
        return plan.hour * 60 + plan.minute

    def mal_temperatur(self, key: str, konf: dict) -> tuple[float, str, int | None]:
        """Returnerer (mål, grunn, frist i minutter siden midnatt eller None)."""
        h = self.hub
        o = self.overstyring(key)
        if o:
            til = dt_util.parse_datetime(o["til"]).strftime("%H:%M")
            return float(o["temp"]), f"Manuell overstyring til kl. {til}", None
        lt = self.leggetid_aktiv(key)
        if lt:
            t_natt_lt = h.num(konf.get(Z_TEMP_NATT) or "", h.num(konf.get(Z_TEMP_DAG) or "", 21.0) - 2.0)
            return t_natt_lt, f"Leggetid — senket fram til kl. {lt:%H:%M}", lt.hour * 60 + lt.minute

        profil = konf.get(Z_PROFIL, "fellesrom")
        er_gulv = konf.get("type") == "gulv"
        helg = h.on("ki_helgemodus")
        sommer = h.on("ki_sommermodus")
        hjemkomst = self.hjemkomst_frist()
        if h.fritidsbolig() and h.on("ki_hjemkomst_aktiv") and hjemkomst is None:
            helg = True   # hytta: planlagt ankomst langt fram = fortsatt frostsikring
        gulv_senk = helg and h.on("ki_helg_senk_gulvvarme")
        t_helg = h.num("ki_temp_helg", 16.0)
        t_sommer = h.num("ki_temp_sommer", 17.0)
        dag_start = h.tid_min("ki_tid_dag_start", "06:30")
        natt_start = h.tid_min("ki_tid_natt_start", "22:30")
        er_dag = h.mellom(dag_start, natt_start)
        t_dag = h.num(konf.get(Z_TEMP_DAG) or "", 21.0)
        t_natt = h.num(konf.get(Z_TEMP_NATT) or "", t_dag - 2.0) if konf.get(Z_TEMP_NATT) else t_dag - 2.0

        # --- Hjemkomst: hold hvilenivå, men med frist så forvarmingen slår inn ---
        if hjemkomst is not None:
            hvile = h.num("ki_temp_helg_gulvvarme", 18.0) if er_gulv else t_helg
            if profil == "konstant":
                hvile = h.num("ki_temp_helg_bad", 22.0)
            return hvile, "Hjemkomst planlagt — forvarmes så huset er klart", hjemkomst

        # --- Gulvvarme ---
        if er_gulv:
            if profil == "konstant":
                if gulv_senk:
                    return h.num("ki_temp_helg_bad", 22.0), "Helgesenking av bad", None
                return t_dag, "Holdes varmt hele døgnet", None
            if gulv_senk:
                return h.num("ki_temp_helg_gulvvarme", 18.0), "Helgesenking av gulvvarme", None
            if profil == "sjelden":
                if not er_dag:
                    return t_dag - 2.0, "Sjelden brukt — sparestrategi om natten", dag_start
                return t_dag, "Normal", None
            # gulv_natt og fellesrom-gulv
            if not er_dag:
                ok, grunn = self.nattsenk_lonnsomt(key)
                if ok:
                    return t_dag - 2.0, f"Nattsenking: {grunn}", dag_start
                return t_dag, f"Ingen nattsenking: {grunn}", None
            return t_dag, "Normal dagtemperatur", None

        # --- Panelovner ---
        if sommer:
            return t_sommer, "Sommermodus", None
        if helg:
            return t_helg, "Helgemodus", None

        person = self.person_for(konf)
        # Automatisk soveromsmodus: søvnsensor overstyrer klokkeslettet. Sover → natt-temperatur nå
        # (forvarming mot vekking gjelder fortsatt). Våken i sengetiden → dag-temperatur til hen sovner.
        sover = h.sover(person) if person and person["type"] in ("barn", "ungdom") else None
        if person and person["type"] == "barn":
            k = person["key"]
            vekk = h.tid_min(f"ki_{k}_dag", "05:30")
            legg = h.tid_min(f"ki_{k}_natt", "19:00")
            if sover is True:
                return t_natt, f"{person['navn']} sover (registrert)", vekk
            if sover is False and h.mellom(legg, vekk):
                return t_dag, f"{person['navn']} er våken", None
            if h.mellom(legg, vekk):
                return t_natt, "Sover", vekk
            hjemme = h.hjemme(person["entity"])
            if hjemme is None:
                hjemme = not h.mellom(h.tid_min(f"ki_{k}_borte_fra", "08:00"), h.tid_min(f"ki_{k}_borte_til", "15:00"))
            if not hjemme:
                t_borte = h.num(konf.get(Z_TEMP_BORTE) or "", t_dag - 2.0)
                return t_borte, f"{person['navn']} er borte på dagtid", h.tid_min(f"ki_{k}_borte_til", "15:00")
            return t_dag, f"{person['navn']} er hjemme", None

        if person and person["type"] == "ungdom":
            k = person["key"]
            helgevekking = dt_util.now().weekday() >= 5 or h.on(f"ki_{k}_ferie")
            vekking = h.tid_min(f"ki_{k}_vekking_helg" if helgevekking else f"ki_{k}_vekking", "07:00")
            legg = h.tid_min(f"ki_{k}_natt", "23:00")
            if sover is True:
                return t_natt, f"{person['navn']} sover (registrert)", vekking
            if sover is False and h.mellom(legg, vekking):
                return t_dag, f"{person['navn']} er våken", None
            if h.mellom(legg, vekking):
                return t_natt, "Sover", vekking
            return t_dag, f"{person['navn']} — rommet brukes på dagtid", None

        if person and person["type"] == "voksen":
            hjemme = h.hjemme(person["entity"])
            if hjemme is False and er_dag:
                t_borte = h.num(konf.get(Z_TEMP_BORTE) or "", t_dag - 2.0)
                return t_borte, f"{person['navn']} er borte", None
            if not er_dag:
                return t_natt, "Natt", dag_start
            return t_dag, "Dag", None

        if profil == "stue":
            if not er_dag:
                ok, grunn = self.nattsenk_lonnsomt(key)
                if ok:
                    return t_natt, f"Nattsenking: {grunn}", dag_start
                return t_dag - 0.5, f"Begrenset nattsenking: {grunn}", dag_start
            red_fra = h.tid_min("ki_stue_reduksjon_fra", "12:00")
            voksne = h.voksne_hjemme()
            if h.naa_min() >= red_fra and voksne is False:
                return t_dag - h.num("ki_stue_reduksjon", 1.5), "Stua lite brukt etter formiddagen", None
            return t_dag, "Stua i bruk", None

        # fellesrom (trappegang, kjøkken panelovn, nye soner)
        if er_dag:
            return t_dag, "Dag", None
        ok, grunn = self.nattsenk_lonnsomt(key)
        if ok:
            return t_natt, f"Natt: {grunn}", dag_start
        return t_dag, f"Ingen nattsenking: {grunn}", None

    # ------------------------------------------------------------------
    #  Lastmodell
    # ------------------------------------------------------------------
    def forventet_effekt(self, konf: dict, trenger: bool) -> float:
        h = self.hub
        if not trenger:
            return 0.0
        if konf.get("duty"):
            d = h.f(konf["duty"])
            if d is not None:
                return float(konf["nominell"]) * max(0.05, min(1.0, d / 100.0))
        w = self.sone_effekt_w(konf)
        if w is not None and w > 50:
            return w / 1000.0
        return float(konf["nominell"]) * 0.5

    def sone_effekt_w(self, konf: dict) -> float | None:
        """Summen av sonens effektsensorer (flere ovner i samme rom), eller None hvis ingen svarer."""
        h = self.hub
        verdier = [h.f(e) for e in (konf.get("effekter") or [konf.get("effekt")]) if e]
        verdier = [v for v in verdier if v is not None]
        return sum(verdier) if verdier else None

    def romtemperatur(self, konf: dict) -> float | None:
        h = self.hub
        if konf.get("temp"):
            v = h.f(konf["temp"])
            if v is not None:
                return v
        try:
            return float(h.attr(konf["climate"], "current_temperature", None))
        except (TypeError, ValueError):
            return None

    def bygg_laster(self) -> list[dict]:
        h = self.hub
        laster = []
        forvarming_pa = h.on("ki_prediktiv_forvarming", True)
        for key, konf in h.aktive_soner().items():
            levende = any(h.st(c) is not None for c in (konf.get("climater") or [konf["climate"]]))
            styrt = h.on(f"ki_styr_{key}", True)
            mal, grunn, frist = self.mal_temperatur(key, konf)
            naa = self.romtemperatur(konf)
            avvik = (mal - naa) if naa is not None else 0.3

            forvarm, forvarm_grunn, forvarm_start = False, "", None
            if frist is not None and naa is not None and forvarming_pa:
                _k, rate, _n = self._tau(key)
                dagmal = self.dagmal(key, konf)
                mangler = dagmal - naa
                if mangler > 0.2:
                    # Lært rate, men aldri under 0,3 °C/t (ellers blir «behov» absurd) og aldri
                    # mer enn 10 t forvarming. Mangler læring brukes 1,2 °C/t.
                    rate = max(0.3, rate if rate and rate > 0 else 1.2)
                    if any(h.pa(e) for e in (konf.get("vindu") or [])):
                        rate *= 0.6   # åpent vindu: regn med tregere oppvarming, start tidligere
                    behov = min((mangler / rate) * 60.0, 10 * 60.0)
                    if konf.get("type") == "gulv":
                        behov = max(behov, 45.0)      # gulv er tregt — start uansett tidlig
                    til_frist = (frist - h.naa_min()) % (24 * 60)
                    start_min = (frist - int(behov) - 10) % (24 * 60)
                    forvarm_start = f"{start_min // 60:02d}:{start_min % 60:02d}"
                    if til_frist <= behov + 10:
                        forvarm = True
                        forvarm_grunn = (f"Trenger ca. {int(behov)} min for å nå {dagmal:.1f} °C "
                                         f"til kl. {frist // 60:02d}:{frist % 60:02d}")
                        mal = dagmal
                        avvik = mal - naa
                        grunn = "Forvarming før fristen"

            sol = self.sol_trekk(konf)
            if sol:
                avvik -= sol

            vindu, vindu_navn = self.vindu_apent(key, konf)
            pers = self.person_for(konf)
            if vindu and forvarm:
                # Vindu åpent, men forvarmingen mot vekking/hjemkomst har startet: varm opp likevel,
                # så rommet er riktig når det skal brukes. (Vinduet får heller stå og lufte.)
                vindu = False
                forvarm_grunn += " — vinduet er åpent, varmer likevel fram mot fristen"
            elif vindu and pers and not ("sover" in grunn.lower() or "natt" in grunn.lower()):
                # Soverom: åpent vindu senker bare mens personen sover. Er hen våken (eller det er
                # dag), skal rommet holde måltemperaturen — vinduet er da et valg, ikke en lekkasje.
                vindu = False
                grunn += f" — {vindu_navn} er åpent, holder likevel varmen"
            trenger = levende and styrt and avvik > 0.1 and not vindu
            laster.append(dict(
                vindu=vindu, vindu_navn=vindu_navn, profil=konf.get(Z_PROFIL),
                person=pers["navn"] if pers else None, person_type=pers["type"] if pers else None,
                key=key, navn=konf["navn"], rom=konf["rom"], type=konf["type"],
                prio=int(konf["prio"]), climate=konf["climate"], levende=levende, styrt=styrt,
                mal=round(mal, 1), naa=round(naa, 1) if naa is not None else None,
                avvik=round(avvik, 2), grunn=grunn, frist=frist, forvarm=forvarm, forvarm_start=forvarm_start,
                forvarm_grunn=forvarm_grunn, sol_trekk=sol, trenger=trenger,
                effekt=round(self.forventet_effekt(konf, trenger), 3),
                helpere=[[konf.get(f), navn] for f, navn in ((Z_TEMP_DAG, "Dag"), (Z_TEMP_NATT, "Natt"), (Z_TEMP_BORTE, "Borte")) if konf.get(f)],
                styr=f"switch.ki_styr_{key}",
                entiteter=[e for e in (list(konf.get("climater") or [konf.get("climate")]) + list(konf.get("effekter") or [konf.get("effekt")])
                                       + [konf.get("duty"), konf.get("temp")]) if e],
                climater=list(konf.get("climater") or [konf["climate"]])))
        return laster

    # ------------------------------------------------------------------
    #  Prioriteringsmotor
    # ------------------------------------------------------------------
    def score(self, last: dict, rotasjon: int) -> float:
        s = PRIO_VEKT.get(last["prio"], 200)
        s += max(0.0, last["avvik"]) * self.hub.num("ki_komfort_vekt", 60)
        if last["forvarm"]:
            s += 400
        # kald morgen gjør et soverom viktigere: større avvik løfter det over prioritetsgrensen
        if last["avvik"] > 1.5 and last["prio"] >= 3:
            s += 150
        if last["type"] == "varmepumpe":
            s += 300   # billigste varme i huset — senkes sist
        s += ((sum(ord(c) for c in last["key"]) + rotasjon) % 7) * 2
        return s

    def fordel(self, laster: list[dict], budsjett: dict, prognose_uregulert: float, vvb_kw: float) -> tuple[list[dict], float]:
        h = self.hub
        tilgjengelig = (budsjett["tillatt_snitt"] - prognose_uregulert - vvb_kw
                        - h.num("ki_reserve_uregulert_kwh", 0.35))
        rotasjon = self.st.get("rotasjon", 0)
        shed_gulv = h.num("ki_shed_gulv_maks", 3.0)
        shed_panel = h.num("ki_shed_panel_maks", 2.0)
        plan = []
        rangert = sorted(((self.score(l, rotasjon), -i, l) for i, l in enumerate(laster)),
                         key=lambda x: (x[0], x[1]), reverse=True)
        for _sc, _i, last in rangert:
            p = dict(last)
            if not last["levende"]:
                p.update(handling="utilgjengelig", settpunkt=None,
                         forklaring="Entiteten svarer ikke — rører den ikke")
            elif not last["styrt"]:
                p.update(handling="manuell", settpunkt=None,
                         forklaring="Sonen står på manuell i klimakortet")
            elif last["vindu"]:
                p.update(handling="vindu", settpunkt=round(h.num("ki_vindu_temp", 12), 1),
                         forklaring=f"{last['vindu_navn']} er åpent — varmen holdes på "
                                    f"{h.num('ki_vindu_temp', 12):.0f} °C til det lukkes")
            elif not last["trenger"]:
                sol = f", solen bidrar med ca. {last['sol_trekk']} °C" if last["sol_trekk"] else ""
                start = f". Forvarming starter ca. kl. {last['forvarm_start']}" if last.get("forvarm_start") and not last["forvarm"] else ""
                p.update(handling="normal", settpunkt=last["mal"],
                         forklaring=f"{last['grunn']}. Rommet er på måltemperatur{sol}{start}")
            elif tilgjengelig >= last["effekt"] or last["prio"] == 1:
                tilgjengelig -= last["effekt"]
                p.update(handling="normal", settpunkt=last["mal"],
                         forklaring=last["forvarm_grunn"] or last["grunn"])
            else:
                maks = shed_gulv if last["type"] == "gulv" else min(shed_panel, 1.0) if last["type"] == "varmepumpe" else shed_panel
                mangel = last["effekt"] - max(tilgjengelig, 0.0)
                trinn = min(maks, round(max(0.5, mangel / max(last["effekt"], 0.1) * maks) * 2) / 2)
                p.update(handling="senket", settpunkt=round(last["mal"] - trinn, 1), senket=trinn,
                         forklaring=(f"Senket {trinn:.1f} °C — timen har "
                                     f"{max(budsjett['igjen'], 0):.2f} kWh igjen av {budsjett['grense']:.2f}"))
                tilgjengelig = max(tilgjengelig - last["effekt"] * 0.3, 0.0)
            plan.append(p)
        return plan, round(tilgjengelig, 2)

    # ------------------------------------------------------------------
    #  Aktuator
    # ------------------------------------------------------------------
    async def skriv_settpunkt(self, key: str, entity: str, verdi: float | None) -> bool:
        h = self.hub
        if verdi is None:
            return False
        try:
            naa = float(h.attr(entity, "temperature", None))
        except (TypeError, ValueError):
            naa = None
        if naa is not None and abs(naa - verdi) < 0.05:
            return False
        if naa is None and self.sist_skrevet.get(key) == verdi:
            return False
        # Samme verdi til samme entitet oftere enn hvert 5. minutt er støy (entiteten svarer ikke)
        sist = self.sist_skrevet_tid.get(key)
        if self.sist_skrevet.get(key) == verdi and sist and (dt_util.utcnow() - sist) < timedelta(minutes=5):
            return False
        if h.st(entity) == "off":
            await h.kall("climate", "set_hvac_mode", {"entity_id": entity, "hvac_mode": "heat"})
        await h.kall("climate", "set_temperature", {"entity_id": entity, "temperature": verdi})
        self.sist_skrevet[key] = verdi
        self.sist_skrevet_tid[key] = dt_util.utcnow()
        return True

    # ------------------------------------------------------------------
    #  Hovedløkke
    # ------------------------------------------------------------------
    async def tick(self) -> None:
        try:
            await self._tick_indre()
            self.siste_tick = dt_util.now()
        except Exception as e:  # noqa: BLE001
            spor = traceback.format_exc()
            _LOGGER.error("ki_energi KRASJET: %s\n%s", e, spor)
            self.hub.sett_sensor("ki_energi_status", "fallback", {
                "forklaring": f"Motoren krasjet: {e}", "feilspor": spor[-900:]})

    def _migrer_250(self) -> None:
        """v2.9.0: ki_maks_time_kwh var økonomisk grense (4,9). Nå er den absolutt, og økonomien
        regnes av nettleiemodellen. Løft gammel standardverdi én gang så det nye rommet kan brukes."""
        h = self.hub
        if self.st.get("migrert_250"):
            return
        e = h.helpers.get("ki_maks_time_kwh")
        if e is None or e.verdi is None:
            return  # vent til hjelperen er gjenopprettet
        if abs(float(e.verdi) - 4.9) < 1e-6:
            h.sett("ki_maks_time_kwh", 6.0)
            self.logg_hendelse("Oppgradering 2.9.0: absolutt timegrense løftet fra 4,90 til 6,00 kWh. "
                               "Økonomisk grense regnes nå av nettleiemodellen (topp tre per dato).")
        self.st["migrert_250"] = True
        h.lagre()

    def _bruk_preset(self) -> None:
        """Første kjøring: sett hjelperverdier fra valgt preset (frosttemperaturer, elbil, grenser)."""
        h = self.hub
        if self.st.get("preset_satt"):
            return
        preset = PRESETS.get(h.cfg(CONF_PRESET, "oslo"))
        if not preset:
            self.st["preset_satt"] = True
            return
        e = h.helpers.get("ki_maks_time_kwh")
        if e is None or e.verdi is None:
            return  # hjelperne er ikke gjenopprettet ennå
        for key, v in preset["verdier"].items():
            if key.startswith("ki_") and key in h.helpers:
                if isinstance(v, str) and ":" in v:
                    from .time import _parse  # noqa: PLC0415
                    h.sett(key, _parse(v))
                else:
                    h.sett(key, v)
        self.st["preset_satt"] = True
        self.st["migrert_250"] = True   # nyinstallasjon trenger ikke løfte grensen
        h.lagre()
        if preset["verdier"]:
            self.logg_hendelse(f"Oppsett «{preset['navn']}» lagt inn: {len(preset['verdier'])} innstillinger satt.")

    async def _tick_indre(self) -> None:
        h = self.hub
        self.endret = False
        self._bruk_preset()
        self._migrer_250()
        self.oppdater_effektsensorer()

        # Timemåler: prøv registeret, lukk ferdige timer (og rekonstruer ved hull)
        if h.nettleie is not None:
            for rad in await h.nettleie.oppdater():
                lok = dt_util.as_local(datetime.fromtimestamp(rad["start"], tz=timezone.utc))
                if rad["kwh"] is None:
                    self.logg_hendelse(f"Timen {lok:%d.%m. %H}:00–{(lok.hour + 1) % 24:02d}:00 mangler måling — telles ikke som null.")
                else:
                    self.logg_hendelse(f"Timen {lok:%d.%m. %H}:00–{(lok.hour + 1) % 24:02d}:00 endte på {rad['kwh']:.2f} kWh ({rad['kvalitet']}).")

        # Egen timesmåling og estimat — alltid, også når motoren er av
        forbrukt, _kilde = self.forbrukt_denne_timen()
        total_kw = (h.f(h.cfg(CONF_TOTAL_EFFEKT), 0.0) or 0.0) / 1000.0
        n = dt_util.now()
        estimert_time = None
        if forbrukt is not None:
            h.sett_sensor("ki_time_energi", round(forbrukt, 3))
            rest = (3600 - (n.minute * 60 + n.second)) / 3600.0
            estimert_time = round(forbrukt + total_kw * rest, 2)
            h.sett_sensor("ki_estimert_timesforbruk", estimert_time)

        self.klima_status()

        if not h.on("ki_energi_hovedbryter", True):
            h.sett_sensor("ki_energi_status", "av", {"forklaring": "Energimotoren er slått av"})
            if h.nettleie is not None:
                h.nettleie.publiser(h.nettleie.vurder(estimert_time))
            self.beredskap()
            return

        skygge = h.on("ki_skyggemodus", True)
        if h.f(h.cfg(CONF_TOTAL_EFFEKT)) is None:
            h.sett_sensor("ki_energi_status", "fallback", {
                "forklaring": "Effektmåleren svarer ikke — motoren holder seg i ro",
                "skyggemodus": skygge})
            self.beredskap()
            return

        budsjett = self.budsjett()
        ekstra, ekstra_grunner = self.kjente_hendelser(15)
        prognose = self.prognose_uregulert(15) + ekstra
        vvb_kw, vvb_grunn, vvb_ma = (0.0, "Varmtvann ikke konfigurert", False)
        if h.vvb is not None:
            vvb_kw, vvb_grunn, vvb_ma = h.vvb.reservasjon()

        laster = self.bygg_laster()
        plan, ledig = self.fordel(laster, budsjett, prognose, vvb_kw)

        styrt_kw = sum(p["effekt"] for p in plan if p.get("handling") == "normal")
        forventet = round(prognose + vvb_kw + styrt_kw, 2)
        farge = self.sone_farge(forventet, budsjett["tillatt_snitt"])
        senket = [p for p in plan if p.get("handling") == "senket"]

        # Nettleie: forventet sluttforbruk for timen etter planen → topp tre, trinn, fastledd
        nv = None
        if h.nettleie is not None:
            forventet_time = round(budsjett["forbrukt"] + forventet * budsjett["timer_igjen"], 3)
            nv = h.nettleie.vurder(forventet_time)
            self.nettleie_vurdering = nv
            h.nettleie.publiser(nv)

        endringer = []
        naa_kl = dt_util.now().strftime("%H:%M")
        for p in plan:
            # Hvorfor får (ikke) termostaten et settpunkt? Vises i kortet under sonen.
            if skygge:
                p["skriving"] = "skyggemodus — ingenting skrives"
            elif p.get("handling") == "manuell":
                p["skriving"] = "KI styrer sonen er av"
            elif p.get("handling") == "utilgjengelig":
                p["skriving"] = "termostaten svarer ikke"
            elif p.get("handling") not in ("normal", "senket", "vindu") or p.get("settpunkt") is None:
                p["skriving"] = "ingen settpunkt å skrive"
            else:
                skrevet = False
                for ent in p.get("climater") or [p["climate"]]:
                    if await self.skriv_settpunkt(f"{p['key']}|{ent}", ent, p["settpunkt"]):
                        skrevet = True
                if skrevet:
                    endringer.append(f"{p['navn']} → {p['settpunkt']} °C")
                    self.st.setdefault("sist_skrevet_kl", {})[p["key"]] = f"{naa_kl} → {p['settpunkt']} °C"
                p["skriving"] = (f"skrev {p['settpunkt']} °C kl. {naa_kl}" if skrevet
                                 else f"termostaten står alt på {p['settpunkt']} °C"
                                 + (f" (sist skrevet {self.st.get('sist_skrevet_kl', {}).get(p['key'])})" if self.st.get("sist_skrevet_kl", {}).get(p["key"]) else ""))

        if senket:
            self.st["rotasjon"] = self.st.get("rotasjon", 0) + 1
            h.lagre()
            flyttet = sum(p["effekt"] for p in senket)
            h.tell("ki_stat_flyttet_kwh", flyttet * (TICK_SEK / 3600.0))
            # komfortavvik: grader under mål, integrert over tid
            h.tell("ki_stat_komfortavvik", sum(p.get("senket", 0) for p in senket) * (TICK_SEK / 3600.0))
            if not self.st.get("var_senket"):
                h.tell("ki_stat_shed_hendelser", 1)
            self.st["var_senket"] = True
        else:
            self.st["var_senket"] = False

        # Prognose fram i tid
        prog = {}
        for m in (15, 30, 60, 120):
            e, _g = self.kjente_hendelser(m)
            vvb_m = h.vvb.reservasjon_om(m) if h.vvb is not None else 0.0
            prog[m] = round(self.prognose_uregulert(m) + e + vvb_m + styrt_kw, 2)
        h.sett_sensor("ki_prognose", prog[15], {
            "om_15_min_kw": prog[15], "om_30_min_kw": prog[30], "om_60_min_kw": prog[60],
            "om_120_min_kw": prog[120], "styrt_kw": round(styrt_kw, 2),
            "tillatt_kw": budsjett["tillatt_snitt"],
            "topp_forventet": max(prog, key=prog.get),
            "forklaring": self.prognose_tekst(prog, budsjett)})

        # Forklaring
        if vvb_ma and farge in ("rod", "kritisk"):
            hoved = f"{vvb_grunn}. Oppvarmingen viker for varmtvannet."
        elif farge in ("rod", "kritisk"):
            hoved = (f"Timen har {budsjett['igjen']:.2f} kWh igjen av {budsjett['grense']:.2f}. "
                     f"Forventet {forventet:.2f} kW mot tillatt {budsjett['tillatt_snitt']:.2f} kW.")
        elif senket:
            navn = ", ".join(p["navn"].lower() for p in senket[:3])
            hoved = f"Senker {navn} for å holde timen under {budsjett['grense']:.2f} kWh."
        else:
            hoved = f"God margin. Bruker {forventet:.2f} kW av {budsjett['tillatt_snitt']:.2f} kW tillatt."
        if ekstra_grunner:
            hoved += " Tar høyde for " + " og ".join(ekstra_grunner) + "."
        if prog[60] > budsjett["tillatt_snitt"] and not senket:
            hoved += f" Forventer {prog[60]:.1f} kW om en time — fleksible laster flyttes fram."
        if skygge:
            hoved = "SKYGGEMODUS — " + hoved

        # Tankegang — motorens resonnement i klartekst, til «utvid»-visningen i kortet
        tanker = [
            f"Modus {self.modus_tekst()}. Timegrensen er {budsjett['grense']:.2f} kWh"
            + (f" ({budsjett['grense_grunn']})." if h.nettleie is None else "."),
            f"Denne timen: {budsjett['forbrukt']:.2f} kWh brukt, {budsjett['igjen']:.2f} kWh igjen på "
            f"{int(budsjett['minutter_igjen'])} min. Tillatt snitteffekt: {budsjett['tillatt_snitt']:.2f} kW.",
            f"Forventer {forventet:.2f} kW nå ({prognose:.2f} kW uregulert + {styrt_kw:.2f} kW styrt), "
            f"{prog[15]:.1f} kW om 15 min og {prog[60]:.1f} kW om en time.",
        ]
        if nv is not None:
            if nv.get("dagens_maks_kwh") is not None:
                tanker.append(f"Nettleie: dagens døgnmaks er {nv['dagens_maks_kwh']:.2f} kWh (kl. {nv['dagens_maks_time']}); "
                              f"timer opp til det koster ingenting ekstra.")
            if nv.get("registrert_snitt") is not None:
                kr = f"{nv['registrert_trinn_kr']:.0f} kr" if nv["registrert_trinn_kr"] is not None else "ukjent trinn"
                tanker.append(f"Topp tre i måneden gir snitt {nv['registrert_snitt']:.2f} kW → {kr}/mnd. "
                              f"Timen ligger an til {nv.get('forventet_time_kwh', 0):.2f} kWh → "
                              + (f"fastleddet øker med {nv['okning_fastledd_kr']:.0f} kr." if nv.get("hoyere_fastledd")
                                 else "samme trinn, men mindre rom resten av måneden." if nv.get("redusert_margin")
                                 else "ingen endring i fastleddet."))
            tanker.append(nv["hvorfor"] + f" Reserve {nv['reserve_kwh']:.2f} kWh, datakvalitet {nv['datakvalitet']}.")
        if vvb_kw > 0 or vvb_ma:
            tanker.append(f"Varmtvann: {vvb_grunn} — reserverer {vvb_kw:.2f} kW" + (" og går foran varmen." if vvb_ma else "."))
        vinduer = [p for p in plan if p.get("handling") == "vindu"]
        if vinduer:
            tanker.append("Vindu åpent: " + ", ".join(f"{p['navn']} ({p.get('vindu_navn')})" for p in vinduer)
                          + f" — holder {h.num('ki_vindu_temp', 12):.0f} °C der til det lukkes.")
        if senket:
            tanker.append("Senker nå: " + ", ".join(
                f"{p['navn']} til {p.get('settpunkt')} °C" for p in senket) + ".")
        else:
            tanker.append("Ingen soner senkes — alle holder målet sitt.")
        ov = [p for p in plan if self.overstyring(p["key"])]
        if ov:
            tanker.append("Manuelle overstyringer: " + ", ".join(f"{p['navn']} {p.get('mal')} °C" for p in ov) + ".")
        if ekstra_grunner:
            tanker.append("Tar høyde for " + " og ".join(ekstra_grunner) + ".")
        if budsjett.get("usikker"):
            tanker.append("Grunnlaget er usikkert (lite lærte data) — holder ekstra margin.")
        if skygge:
            tanker.append("Skyggemodus: alt dette regnes og logges, men ingen termostater røres.")

        h.sett_sensor("ki_energi_status", farge, {
            "forklaring": hoved, "tankegang": tanker, "skyggemodus": skygge, "modus": self.modus_tekst(),
            "hustype": "fritidsbolig" if h.fritidsbolig() else "bolig",
            "personer": [{"key": p["key"], "navn": p["navn"], "type": p["type"], "hjemme": h.hjemme(p["entity"]) if p["entity"] else None}
                         for p in h.personer()],
            "gardiner": bool(h.cfg(CONF_GARDINER)), "hanklevarmer": bool(h.cfg(CONF_HANKLEVARMER)), "elbil": bool(h.cfg(CONF_HAR_ELBIL, False)),
            "entiteter": {"total_effekt": h.cfg(CONF_TOTAL_EFFEKT) or "", "importert_energi": h.cfg(CONF_IMPORTERT_ENERGI) or "",
                          "ute_temp": h.cfg(CONF_UTE_TEMP) or "", "vaer": h.cfg(CONF_VAER) or "",
                          "topp1": h.cfg(CONF_TOPP1) or "", "topp2": h.cfg(CONF_TOPP2) or "", "topp3": h.cfg(CONF_TOPP3) or ""},
            "vvb_bryter": bool(h.cfg(CONF_VVB_BRYTER)), "vvb_effekt": bool(h.cfg(CONF_VVB_EFFEKT)),
            "grense_kwh": budsjett["grense"], "grense_grunn": budsjett["grense_grunn"],
            "forbrukt_kwh": budsjett["forbrukt"], "igjen_kwh": budsjett["igjen"],
            "minutter_igjen": budsjett["minutter_igjen"],
            "tillatt_effekt_kw": budsjett["tillatt_snitt"], "forventet_effekt_kw": forventet,
            "uregulert_kw": round(prognose, 2), "uregulert_60_kw": round(self.prognose_uregulert(60), 2),
            "prognose_15_kw": prog[15], "prognose_30_kw": prog[30],
            "prognose_60_kw": prog[60], "prognose_120_kw": prog[120],
            "vvb_reservert_kw": round(vvb_kw, 2), "vvb_grunn": vvb_grunn,
            "ledig_kw": ledig, "solfaktor": self.solfaktor(), "malekilde": budsjett["kilde"],
            "tak_aktivt": budsjett["tak_aktivt"],
            "lagring": ".storage (integrasjon)", "lagring_ok": True,
            "profil_oppforinger": len(h.minne["profil"]), "tau_soner": len(h.minne["tau"]),
            "endringer": endringer, "usikkert_grunnlag": budsjett["usikker"]})

        lastliste = [dict(
            navn=p["navn"], rom=p["rom"], key=p["key"], type=p["type"], prio=p["prio"],
            handling=p.get("handling"), mal=p.get("mal"), settpunkt=p.get("settpunkt"),
            naa=p.get("naa"), effekt=p.get("effekt"), forklaring=p.get("forklaring"),
            overstyrt=bool(self.overstyring(p["key"])), helpere=p.get("helpere"), styr=p.get("styr"),
            entiteter=p.get("entiteter"), vindu=p.get("vindu", False), vindu_navn=p.get("vindu_navn", ""),
            leggetid=bool(self.leggetid_aktiv(p["key"])), profil=p.get("profil"),
            person=p.get("person"), person_type=p.get("person_type"), forvarm_start=p.get("forvarm_start"),
            forvarm=p.get("forvarm", False), skriving=p.get("skriving"))
            for p in plan]
        if h.vvb is not None:
            lastliste.append(dict(
                navn="Varmtvannsbereder", rom="Varmtvann", key="vvb", type="bryter",
                prio=1 if vvb_ma else 2, handling="på" if h.vvb.varmer() else "av",
                mal=None, settpunkt=None, naa=None, effekt=round(vvb_kw, 2),
                forklaring=f"{vvb_grunn}. Styres av varmtvannsdelen, motoren reserverer effekt.",
                overstyrt=False, helpere=[], styr=None))
        h.sett_sensor("ki_laster", str(len(senket)), {"laster": lastliste})

        self.beredskap()
        self.besparelse()

        signatur = farge + "|" + hoved + "|" + ",".join(p["key"] + str(p.get("settpunkt")) for p in senket)
        if endringer or ((senket or farge in ("rod", "kritisk")) and signatur != self.logg_signatur):
            self.logg_signatur = signatur
            self.logg(farge, budsjett, forventet, hoved, plan, skygge)

    def prognose_tekst(self, prog: dict, budsjett: dict) -> str:
        verste = max(prog, key=prog.get)
        if prog[verste] <= budsjett["tillatt_snitt"]:
            return f"Ingen topp i sikte de neste to timene (maks {prog[verste]:.1f} kW)."
        return (f"Forventer {prog[verste]:.1f} kW om {verste} min mot tillatt "
                f"{budsjett['tillatt_snitt']:.1f} kW — fleksible laster bør ta unna nå.")

    def modus_tekst(self) -> str:
        h = self.hub
        if not h.on("ki_energi_hovedbryter", True):
            return "AV"
        if h.on("ki_hjemkomst_aktiv"):
            return "HJEMKOMST"
        if h.on("ki_helgemodus"):
            return "HELG"
        if h.on("ki_sommermodus"):
            return "SOMMER"
        if h.sensor_state("ki_energi_status") in ("rod", "kritisk", "oransje"):
            return "EFFEKTBEGRENSNING"
        if self.st.get("overstyringer"):
            return "MANUELL"
        if h.on("ki_skyggemodus", True):
            return "SKYGGE"
        return "AUTO"

    def klima_status(self) -> None:
        h = self.hub
        m = self.modus_tekst()
        tekst = {"AV": "Av", "HJEMKOMST": "Hjemkomst pågår", "HELG": "Helgemodus",
                 "SOMMER": "Sommermodus", "EFFEKTBEGRENSNING": "Effektbegrensning",
                 "MANUELL": "Manuell overstyring", "SKYGGE": "Skyggemodus", "AUTO": "Normal"}.get(m, m)
        h.sett_sensor("ki_klima_status", tekst, {
            "modus": m, "helgemodus": h.on("ki_helgemodus"), "sommermodus": h.on("ki_sommermodus"),
            "hjemkomst": h.on("ki_hjemkomst_aktiv"), "skyggemodus": h.on("ki_skyggemodus", True),
            "overstyringer": list(self.st.get("overstyringer", {}).keys())})

    def beredskap(self) -> None:
        h = self.hub
        hindringer = []
        status = h.sensor_state("ki_energi_status")
        if status in ("av", None):
            hindringer.append("Motoren rapporterer ikke status")
        elif status == "fallback":
            hindringer.append("Motoren står i fallback: " + str(h.sensor_attr("ki_energi_status", "forklaring", "")))
        if h.sensor_attr("ki_energi_status", "usikkert_grunnlag"):
            hindringer.append("Energiregisteret svarer ikke — budsjettet er et anslag")
        tau = h.minne["tau"]
        soner = h.aktive_soner()
        lite = [konf["navn"] for k, konf in soner.items() if tau.get(k, {}).get("n", 0) < 20]
        if not tau:
            hindringer.append("Ingen tidskonstanter lært ennå")
        elif lite:
            hindringer.append("Få målinger for: " + ", ".join(lite))
        av = [konf["navn"] for konf in soner.values() if any(h.st(c) == "off" for c in konf.get("climater") or [konf["climate"]])]
        if av:
            hindringer.append("Står avslått (settes til heat ved styring): " + ", ".join(av))
        mangler = [c for konf in soner.values() for c in (konf.get("climater") or [konf["climate"]]) if not h.finnes(c)]
        if mangler:
            hindringer.append("Climate-entiteter som ikke finnes: " + ", ".join(mangler))
        if status in ("av", "fallback", None):
            state = "Ikke klar"
        elif lite or not tau:
            state = "Lærer fortsatt"
        else:
            state = "Klar"
        h.sett_sensor("ki_overgang_klar", state, {"hindringer": hindringer, "antall_hindringer": len(hindringer)})

    def besparelse(self) -> None:
        """Estimert besparelse. Uten kontrollgruppe er dette et anslag og merkes slik."""
        h = self.hub
        flyttet = h.num("ki_stat_flyttet_kwh", 0.0)
        topper = h.num("ki_stat_unngatte_topper", 0.0)
        pris_dag = h.f(h.cfg(CONF_ENERGILEDD_DAG), 0.0) or 0.0
        pris_natt = h.f(h.cfg(CONF_ENERGILEDD_NATT), 0.0) or 0.0
        diff_nettleie = max(pris_dag - pris_natt, 0.0)
        # flyttet energi til billigere tariff + spart kWh (ca. 10 % av flyttet energi forsvinner
        # fordi rommet står lavere en stund) + unngåtte topper priset som 1/3 av trinnkostnad
        spart_kwh = round(flyttet * 0.10, 2)
        energi = h.f(h.cfg(CONF_STROMPRIS), 1.0) or 1.0
        trinn_diff = self.trinn_diff_kr()
        spart_kr = round(flyttet * diff_nettleie + spart_kwh * energi + topper * trinn_diff / 3.0, 2)
        h.sett("ki_stat_spart_kr", spart_kr)
        h.sett_sensor("ki_besparelse", spart_kr, {
            "estimat": True,
            "merknad": "Estimat uten kontrollgruppe. Unngåtte topper = timer motoren holdt innenfor 90–100 % av grensen.",
            "spart_kwh_estimert": spart_kwh, "flyttet_kwh": round(flyttet, 2),
            "unngatte_topper": int(topper), "utkoblinger": int(h.num("ki_stat_shed_hendelser", 0)),
            "komfortavvik_gradtimer": round(h.num("ki_stat_komfortavvik", 0.0), 2),
            "spart_nettleie_kr": round(flyttet * diff_nettleie, 2),
            "trinn_diff_kr": trinn_diff,
            "spart_effektledd_kr": round(topper * trinn_diff / 3.0, 2)})

    def trinn_diff_kr(self) -> float:
        """Forskjellen i fastledd mellom registrert trinn og neste, fra tarifftabellen.
        Faller tilbake på hjelperen ki_trinn_kostnad_diff hvis tabellen ikke dekker."""
        h = self.hub
        v = self.nettleie_vurdering
        if v and v.get("registrert_trinn_kr") is not None and v.get("registrert_trinn_til") is not None:
            from .nettleie import trinn as _trinn  # noqa: PLC0415
            neste = _trinn(v["registrert_trinn_til"], [tuple(t) for t in v["tabell"]])
            if neste["kr"] is not None:
                return float(neste["kr"] - v["registrert_trinn_kr"])
        return h.num("ki_trinn_kostnad_diff", 170.0)

    # ------------------------------------------------------------------
    #  Logg
    # ------------------------------------------------------------------
    def logg(self, farge, budsjett, forventet, hoved, plan, skygge) -> None:
        h = self.hub
        tiltak = [f"{p['navn']}: {p.get('handling')} → {p.get('settpunkt')} °C ({p.get('forklaring')})"
                  for p in plan if p.get("handling") == "senket"]
        linje = {
            "tid": dt_util.now().strftime("%Y-%m-%d %H:%M:%S"),
            "sone": farge, "skygge": skygge, "forbrukt": budsjett["forbrukt"],
            "grense": budsjett["grense"], "forventet_kw": forventet,
            "forklaring": hoved, "tiltak": tiltak}
        h.minne["logg"].insert(0, linje)
        del h.minne["logg"][MAKS_LOGG_LINJER:]
        h.sett_sensor("ki_beslutningslogg", linje["tid"], {"linjer": h.minne["logg"][:40]})
        h.lagre()

    def logg_hendelse(self, tekst: str, tiltak: list[str] | None = None) -> None:
        h = self.hub
        linje = {"tid": dt_util.now().strftime("%Y-%m-%d %H:%M:%S"), "sone": "info", "skygge": h.on("ki_skyggemodus", True),
                 "forbrukt": None, "grense": None, "forventet_kw": None, "forklaring": tekst, "tiltak": tiltak or []}
        h.minne["logg"].insert(0, linje)
        del h.minne["logg"][MAKS_LOGG_LINJER:]
        h.sett_sensor("ki_beslutningslogg", linje["tid"], {"linjer": h.minne["logg"][:40]})
        h.lagre()

    # ------------------------------------------------------------------
    #  Læring (hvert 5. minutt)
    # ------------------------------------------------------------------
    async def laering(self) -> None:
        try:
            self._laering_indre()
        except Exception as e:  # noqa: BLE001
            _LOGGER.error("ki_energi læring KRASJET: %s\n%s", e, traceback.format_exc())

    def _laering_indre(self) -> None:
        h = self.hub
        if not h.on("ki_energi_hovedbryter", True):
            return
        kw = h.sensor_state("ki_uregulert_effekt")
        if kw is not None:
            kw = kw / 1000.0
            nokkel = self.profilnokkel()
            rad = h.minne["profil"].get(nokkel, {"kw": kw, "n": 0})
            n = rad["n"] + 1
            alfa = max(0.05, 1.0 / min(n, 20))
            rad["kw"] = round(rad["kw"] * (1 - alfa) + kw * alfa, 3)
            rad["n"] = n
            h.minne["profil"][nokkel] = rad

        if h.on("ki_laering_tau", True):
            ute = h.f(h.cfg(CONF_UTE_TEMP))
            if ute is not None:
                naa_tid = dt_util.utcnow().timestamp()
                ny = {}
                for key, konf in h.aktive_soner().items():
                    t = self.romtemperatur(konf)
                    if t is None:
                        continue
                    ny[key] = (t, naa_tid)
                    gammel = self.temp_forrige.get(key)
                    if not gammel:
                        continue
                    t0, tid0 = gammel
                    dt_timer = (naa_tid - tid0) / 3600.0
                    if dt_timer <= 0 or dt_timer > 0.5:
                        continue
                    endring = (t - t0) / dt_timer
                    diff = t - ute
                    effekt = self.sone_effekt_w(konf) or 0.0
                    if any(h.pa(e) for e in (konf.get("vindu") or [])):
                        continue   # åpent vindu forgifter både k og oppvarmingsrate — lær ikke nå
                    rad = h.minne["tau"].get(key, {"k": 0.08, "varme_rate": 1.2, "n": 0})
                    if effekt < 30 and diff > 3 and endring < -0.05:
                        k = min(0.5, max(0.005, -endring / diff))
                        alfa = max(0.05, 1.0 / min(rad["n"] + 1, 30))
                        rad["k"] = round(rad["k"] * (1 - alfa) + k * alfa, 4)
                    elif effekt > 100 and endring > 0.1:
                        forrige = rad.get("varme_rate", 1.2)
                        if forrige <= 0:
                            forrige = 1.2
                        rad["varme_rate"] = round(max(0.05, forrige * 0.85 + endring * 0.15), 3)
                    else:
                        continue
                    rad["n"] = rad.get("n", 0) + 1
                    h.minne["tau"][key] = rad
                self.temp_forrige = ny

        soner = h.aktive_soner()
        ut = {}
        for k, v in h.minne["tau"].items():
            if k not in soner:
                continue
            ut[soner[k]["navn"]] = {"tau_timer": round(1.0 / v["k"], 1) if v.get("k") else None,
                                    "grader_per_time": v.get("varme_rate"), "malinger": v.get("n", 0)}
        h.sett_sensor("ki_tidskonstanter", str(len(ut)), {"soner": ut})
        h.lagre()

    # ------------------------------------------------------------------
    #  Timeslutt og månedsskifte
    # ------------------------------------------------------------------
    async def timeslutt(self) -> None:
        """Kjøres like etter hel time. Lukker timen i timemåleren og varsler hvis den passerte grensen."""
        h = self.hub
        if h.nettleie is None:
            return
        lukket = await h.nettleie.oppdater()
        if not h.on("ki_energi_hovedbryter", True):
            return
        siste = [r for r in lukket if r.get("kwh") is not None]
        if not siste:
            return
        forbrukt = siste[-1]["kwh"]
        grense = float((self.nettleie_vurdering or {}).get("grense_kwh") or h.num("ki_maks_time_kwh", 4.9))
        if forbrukt > grense:
            await h.varsle("Effektgrense passert",
                           f"Timen endte på {forbrukt:.2f} kWh, over grensen på {grense:.2f} kWh.", kategori="effekt")
            self.logg_hendelse(f"Timen endte på {forbrukt:.2f} kWh — over grensen på {grense:.2f} kWh.")
        elif forbrukt > grense * 0.9:
            h.tell("ki_stat_unngatte_topper", 1)
            self.logg_hendelse(f"Timen endte på {forbrukt:.2f} kWh — innenfor grensen på {grense:.2f} kWh med liten margin.")
        _LOGGER.info("ki_energi: time avsluttet på %.2f kWh (grense %.2f)", forbrukt, grense)

    async def manedsskifte(self) -> None:
        h = self.hub
        for k in ("ki_stat_unngatte_topper", "ki_stat_shed_hendelser", "ki_stat_flyttet_kwh",
                  "ki_stat_spart_kr", "ki_stat_komfortavvik"):
            h.sett(k, 0.0)
        self.logg_hendelse("Ny måned — statistikken er nullstilt.")

    # ------------------------------------------------------------------
    #  Tjenester
    # ------------------------------------------------------------------
    async def overstyr(self, sone: str, temp: float, minutter: float = 120) -> None:
        if sone not in self.hub.aktive_soner():
            _LOGGER.error("overstyr: ukjent sone %s", sone)
            return
        til = dt_util.now() + timedelta(minutes=float(minutter))
        self.st.setdefault("overstyringer", {})[sone] = {"temp": float(temp), "til": til.isoformat(timespec="seconds")}
        self.hub.lagre()
        self.logg_hendelse(f"Manuell overstyring: {sone} → {temp} °C til kl. {til:%H:%M}.")
        await self.tick()

    async def fjern_overstyring(self, sone: str | None = None) -> None:
        o = self.st.setdefault("overstyringer", {})
        if sone:
            o.pop(sone, None)
        else:
            o.clear()
        self.hub.lagre()
        await self.tick()

    async def nullstill_laering(self, hva: str = "alt") -> None:
        if hva in ("alt", "profil"):
            self.hub.minne["profil"] = {}
        if hva in ("alt", "tau"):
            self.hub.minne["tau"] = {}
        await self.hub.lagre_naa()
        self.logg_hendelse(f"Nullstilte læring ({hva}).")
