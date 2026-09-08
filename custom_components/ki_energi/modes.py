"""Moduser og småstyring: helg/hytte, hjemkomst, sommer, gardiner, håndklevarmer.

Alt her kjøres fra samme minutt-tick som energimotoren, pluss hendelser fra
varselknappene på mobilen. Ingenting her skriver til climate.* — det gjør
bare aktuatoren i engine.py. Modusene endrer i stedet bryterne motoren
leser måltemperaturene fra.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from homeassistant.core import Event, callback
from homeassistant.util import dt as dt_util

from .const import (
    AKSJON_HELG_JA, AKSJON_HELG_NEI, AKSJON_HJEM_FORLENG, AKSJON_HJEM_JA, AKSJON_HJEM_NAA,
    AKSJON_HJEM_NEI, AKSJON_HJEM_SENERE, CONF_GARDINER, CONF_HANKLEVARMER, CONF_TILSTEDE_CYBELE,
    CONF_TILSTEDE_RUNE, CONF_TILSTEDE_SEBASTIAN, CONF_UTE_TEMP, CONF_VAER,
)
from .hub import KiHub

_LOGGER = logging.getLogger(__name__)


class KiModuser:
    def __init__(self, hub: KiHub) -> None:
        self.hub = hub
        self.m = hub.minne.setdefault("moduser", {})
        self.siste_minutt: int | None = None
        self.siste_dag: str | None = None
        self.hank_pa_siden: datetime | None = None
        self.gardin_sist: str | None = None

    # ------------------------------------------------------------------
    #  Tilstedeværelse
    # ------------------------------------------------------------------
    def alle_borte(self) -> bool | None:
        h = self.hub
        kjent = []
        for k in (CONF_TILSTEDE_CYBELE, CONF_TILSTEDE_SEBASTIAN, CONF_TILSTEDE_RUNE):
            v = h.hjemme(h.cfg(k))
            if v is not None:
                kjent.append(v)
        if not kjent:
            return None
        return not any(kjent)

    # ------------------------------------------------------------------
    #  Tick
    # ------------------------------------------------------------------
    async def tick(self) -> None:
        h = self.hub
        naa = dt_util.now()
        minutt = naa.hour * 60 + naa.minute
        forste_i_minuttet = minutt != self.siste_minutt
        self.siste_minutt = minutt
        dag = naa.strftime("%Y-%m-%d")
        ny_dag = dag != self.siste_dag
        self.siste_dag = dag

        borte = self.alle_borte()
        h.sett_sensor("ki_alle_borte", borte)

        # --- fraværssporing ---
        if borte:
            self.m.setdefault("borte_siden", naa.isoformat())
        else:
            if self.m.get("borte_siden"):
                self.m.pop("borte_siden", None)
                h.lagre()
            # noen kom hjem → avslutt helg/hjemkomst
            if borte is False and (h.on("ki_helgemodus") or h.on("ki_hjemkomst_aktiv")):
                await self.hjemkomst_ferdig("Noen kom hjem")

        # --- helg: automatisk aktivering torsdag/fredag ved langt fravær ---
        if (borte and h.on("ki_helg_auto", True) and not h.on("ki_helgemodus")
                and not h.on("ki_sommermodus") and naa.weekday() in (3, 4)):
            siden = dt_util.parse_datetime(self.m.get("borte_siden", "")) if self.m.get("borte_siden") else None
            timer = h.num("ki_helg_auto_timer", 6)
            if siden and (naa - siden) >= timedelta(hours=timer) and self.m.get("helg_auto_dag") != dag:
                self.m["helg_auto_dag"] = dag
                h.sett("ki_helgemodus", True)
                await h.varsle("Helgemodus aktivert",
                               f"Alle har vært borte i {int(timer)} timer — huset er satt i sparemodus. "
                               "Slå av helgemodus i klimakortet hvis dette var feil.")
                if h.engine is not None:
                    h.engine.logg_hendelse(f"Helgemodus aktivert automatisk etter {int(timer)} t fravær.")
                h.lagre()

        if forste_i_minuttet:
            await self._tidshendelser(naa, minutt)
            await self.hanklevarmer(naa)
            await self.gardiner_tick(naa)
            await self.sommer_auto(naa, ny_dag)

        # --- hjemkomst: avslutt automatisk en stund etter planlagt tid ---
        if h.on("ki_hjemkomst_aktiv"):
            plan = h.dt("ki_hjemkomst_planlagt")
            if plan and naa > plan + timedelta(hours=3):
                await self.hjemkomst_ferdig("Planlagt hjemkomst er passert med god margin")

    async def _tidshendelser(self, naa: datetime, minutt: int) -> None:
        h = self.hub
        ukedag = naa.weekday()
        # Fredag: spørsmål om helgemodus
        if (ukedag == 4 and minutt == h.tid_min("ki_helg_varsel_tid", "10:00")
                and not h.on("ki_helgemodus") and not h.on("ki_sommermodus")):
            await h.varsle("Helgemodus?", "Skal huset settes i helgemodus (sparetemperatur) i helgen?",
                           aksjoner=[{"action": AKSJON_HELG_JA, "title": "Ja, aktiver"},
                                     {"action": AKSJON_HELG_NEI, "title": "Nei, vi er hjemme"}],
                           tag="ki_helg")
        # Søndag: spørsmål om hjemkomst
        if ukedag == 6 and h.on("ki_helgemodus") and not h.on("ki_hjemkomst_aktiv"):
            spor = h.tid_min("ki_helg_sporsmal_tid", "08:00")
            utsatt = self.m.get("sporsmal_utsatt_til")
            if minutt == spor or (utsatt and naa >= dt_util.parse_datetime(utsatt) and minutt == (dt_util.parse_datetime(utsatt).hour * 60 + dt_util.parse_datetime(utsatt).minute)):
                self.m.pop("sporsmal_utsatt_til", None)
                if self.m.get("forlenget_dag") != naa.strftime("%Y-%m-%d"):
                    await self.still_hjemkomstsporsmal()
            frist = h.tid_min("ki_helg_frist_tid", "10:00")
            if minutt == frist and h.on("ki_helg_venter_svar"):
                h.sett("ki_helg_venter_svar", False)
                await self.start_hjemkomst(None, "Ingen svar innen fristen — huset forberedes på hjemkomst")
                await h.varsle("Hjemkomst forberedes",
                               f"Ingen svar innen fristen. Huset varmes opp til kl. {h.tid_str('ki_hjemkomst_tid', '13:00')}.")

    # ------------------------------------------------------------------
    #  Helg og hjemkomst
    # ------------------------------------------------------------------
    async def still_hjemkomstsporsmal(self) -> None:
        h = self.hub
        h.sett("ki_helg_venter_svar", True)
        await h.varsle(
            "Skal dere hjem i dag?",
            f"Helgemodus er aktiv. Svar innen kl. {h.tid_str('ki_helg_frist_tid', '10:00')}, ellers "
            f"starter oppvarmingen slik at huset er klart rundt kl. {h.tid_str('ki_hjemkomst_tid', '13:00')}.",
            aksjoner=[{"action": AKSJON_HJEM_JA, "title": "Ja – start oppvarming"},
                      {"action": AKSJON_HJEM_SENERE, "title": "Spør igjen om 2 t"},
                      {"action": AKSJON_HJEM_FORLENG, "title": "Forleng helgen"},
                      {"action": AKSJON_HJEM_NAA, "title": "Vi kommer hjem nå"}],
            tag="ki_hjemkomst", alltid=True)

    async def start_hjemkomst(self, planlagt: datetime | None, grunn: str) -> None:
        """Prediktiv oppvarmingssekvens. Motoren forvarmer sonevis ut fra målt oppvarmingsrate."""
        h = self.hub
        naa = dt_util.now()
        if planlagt is None:
            m = h.tid_min("ki_hjemkomst_tid", "13:00")
            planlagt = naa.replace(hour=m // 60, minute=m % 60, second=0, microsecond=0)
            if planlagt < naa:
                planlagt = naa + timedelta(minutes=30)
        h.sett("ki_hjemkomst_planlagt", planlagt)
        h.sett("ki_helg_venter_svar", False)
        h.sett("ki_helgemodus", False)
        h.sett("ki_hjemkomst_aktiv", True)
        if h.engine is not None:
            h.engine.logg_hendelse(f"Hjemkomst startet: {grunn}. Mål kl. {planlagt:%H:%M}. "
                                   "Sonene forvarmes så sent som mulig innenfor budsjettet.")
            await h.engine.tick()

    async def hjemkomst_ferdig(self, grunn: str) -> None:
        h = self.hub
        h.sett("ki_hjemkomst_aktiv", False)
        h.sett("ki_helgemodus", False)
        h.sett("ki_helg_venter_svar", False)
        self.m.pop("forlenget_dag", None)
        if h.engine is not None:
            h.engine.logg_hendelse(f"{grunn} — tilbake til normal ukeplan.")
            await h.engine.tick()

    @callback
    def handling(self, event: Event) -> None:
        aksjon = event.data.get("action")
        if not aksjon or not str(aksjon).startswith("KI_"):
            return
        self.hub.hass.async_create_task(self._handling(aksjon))

    async def _handling(self, aksjon: str) -> None:
        h = self.hub
        naa = dt_util.now()
        if aksjon == AKSJON_HELG_JA:
            h.sett("ki_helgemodus", True)
            await h.logbook("KI Klima", "Helgemodus aktivert fra varsel.")
        elif aksjon == AKSJON_HELG_NEI:
            await h.logbook("KI Klima", "Helgemodus avslått fra varsel.")
        elif aksjon == AKSJON_HJEM_JA:
            await self.start_hjemkomst(None, "Svar: ja")
        elif aksjon == AKSJON_HJEM_NAA:
            await self.start_hjemkomst(naa + timedelta(minutes=20), "Svar: kommer hjem nå")
        elif aksjon == AKSJON_HJEM_SENERE:
            h.sett("ki_helg_venter_svar", False)
            self.m["sporsmal_utsatt_til"] = (naa + timedelta(hours=2)).replace(second=0, microsecond=0).isoformat()
            h.lagre()
            await h.varsle("Greit", "Spør igjen om to timer.")
        elif aksjon == AKSJON_HJEM_FORLENG:
            h.sett("ki_helg_venter_svar", False)
            self.m["forlenget_dag"] = naa.strftime("%Y-%m-%d")
            h.lagre()
            await h.varsle("Helgen er forlenget", "Huset holder sparetemperatur til noen kommer hjem, eller til du starter hjemkomst i kortet.")
        elif aksjon == AKSJON_HJEM_NEI:
            h.sett("ki_helg_venter_svar", False)
            self.m["forlenget_dag"] = naa.strftime("%Y-%m-%d")
            h.lagre()
            await h.varsle("Helgemodus fortsetter", "Greit — huset holder sparetemperatur til noen kommer hjem.")
        if h.engine is not None:
            await h.engine.tick()

    async def bryter_endret(self, key: str, verdi: bool) -> None:
        """Kalles når brukeren vipper en av våre brytere."""
        h = self.hub
        if key == "ki_helgemodus":
            if verdi:
                h.sett("ki_hjemkomst_aktiv", False)
            else:
                h.sett("ki_helg_venter_svar", False)
                if h.engine is not None:
                    h.engine.logg_hendelse("Helgemodus slått av — gjenoppvarming budsjetteres sonevis.")
        elif key == "ki_hjemkomst_aktiv" and verdi and h.dt("ki_hjemkomst_planlagt") is None:
            await self.start_hjemkomst(None, "Startet manuelt")
            return
        elif key == "ki_sommermodus":
            if h.engine is not None:
                h.engine.logg_hendelse("Sommermodus " + ("på" if verdi else "av") + ".")
        elif key == "ki_styr_hanklevarmer" and not verdi:
            hk = h.cfg(CONF_HANKLEVARMER)
            if hk:
                await h.kall("switch", "turn_on", {"entity_id": hk})
        if h.engine is not None:
            await h.engine.tick()

    # ------------------------------------------------------------------
    #  Sommermodus automatisk
    # ------------------------------------------------------------------
    async def sommer_auto(self, naa: datetime, ny_dag: bool) -> None:
        h = self.hub
        if not h.on("ki_sommer_auto"):
            return
        if not (naa.hour == 12 and naa.minute == 0):
            return
        i_vindu = h.i_manedsvindu(int(h.num("ki_sommer_start_maned", 6)), int(h.num("ki_sommer_slutt_maned", 8)))
        ute = h.f(h.cfg(CONF_UTE_TEMP))
        grense = h.num("ki_sommer_ute_grense", 15)
        varmt = ute is not None and ute >= grense
        kaldt = ute is not None and ute < grense - 4
        onsket = i_vindu or (varmt and not kaldt)
        if kaldt and not i_vindu:
            onsket = False
        if onsket != h.on("ki_sommermodus"):
            h.sett("ki_sommermodus", onsket)
            if h.engine is not None:
                h.engine.logg_hendelse("Sommermodus " + ("aktivert" if onsket else "deaktivert")
                                       + f" automatisk (måned {naa.month}, ute {ute if ute is not None else '?'} °C).")
            await h.varsle("Sommermodus " + ("på" if onsket else "av"),
                           "Satt automatisk ut fra dato og utetemperatur.")

    # ------------------------------------------------------------------
    #  Håndklevarmer
    # ------------------------------------------------------------------
    async def hanklevarmer(self, naa: datetime) -> None:
        h = self.hub
        ent = h.cfg(CONF_HANKLEVARMER)
        if not ent or not h.finnes(ent):
            return
        pa = h.st(ent) == "on"
        if pa:
            self.hank_pa_siden = self.hank_pa_siden or naa
        else:
            self.hank_pa_siden = None

        if not h.on("ki_styr_hanklevarmer", True):
            if not pa:
                await h.kall("switch", "turn_on", {"entity_id": ent})
            return

        minutt = naa.hour * 60 + naa.minute
        i_vindu = (h.mellom(h.tid_min("ki_hanklevarmer_morgen_start", "05:30"), h.tid_min("ki_hanklevarmer_morgen_slutt", "08:30"), minutt)
                   or h.mellom(h.tid_min("ki_hanklevarmer_kveld_start", "19:00"), h.tid_min("ki_hanklevarmer_kveld_slutt", "22:00"), minutt))
        maks = h.num("ki_hanklevarmer_maks_pa_tid", 240)
        if pa and self.hank_pa_siden and (naa - self.hank_pa_siden).total_seconds() / 60 > maks:
            await h.kall("switch", "turn_off", {"entity_id": ent})
            await h.logbook("KI Håndklevarmer", f"Slått av automatisk — har stått på lenger enn {int(maks)} min.")
            await h.varsle("Håndklevarmer slått av", f"Sto på lenger enn {int(maks)} min — slått av automatisk (sikkerhet).")
            return
        # Vinduskantene: slå på/av bare ved selve overgangen, så manuell bruk innimellom respekteres
        starter = minutt in (h.tid_min("ki_hanklevarmer_morgen_start", "05:30"), h.tid_min("ki_hanklevarmer_kveld_start", "19:00"))
        slutter = minutt in (h.tid_min("ki_hanklevarmer_morgen_slutt", "08:30"), h.tid_min("ki_hanklevarmer_kveld_slutt", "22:00"))
        if starter and not pa and i_vindu:
            # Effektvakt: utsett noen minutter i rød sone (45 W er lite, men prinsippet er likt)
            if h.sensor_state("ki_energi_status") in ("rod", "kritisk"):
                self.m["hank_utsatt"] = True
                return
            await h.kall("switch", "turn_on", {"entity_id": ent})
        elif self.m.get("hank_utsatt") and i_vindu and not pa and h.sensor_state("ki_energi_status") not in ("rod", "kritisk"):
            self.m.pop("hank_utsatt", None)
            await h.kall("switch", "turn_on", {"entity_id": ent})
        elif slutter and pa:
            self.m.pop("hank_utsatt", None)
            await h.kall("switch", "turn_off", {"entity_id": ent})

    # ------------------------------------------------------------------
    #  Gardiner
    # ------------------------------------------------------------------
    async def gardiner_tick(self, naa: datetime) -> None:
        h = self.hub
        cover = h.cfg(CONF_GARDINER)
        if not cover or not h.on("ki_styr_gardiner") or not h.finnes(cover):
            return
        i_sesong = h.i_manedsvindu(int(h.num("ki_gardin_start_maned", 10)), int(h.num("ki_gardin_slutt_maned", 4)))
        sol_oppe = h.st("sun.sun") == "above_horizon"
        ute = h.f(h.cfg(CONF_UTE_TEMP))
        onsket: str | None = None
        if i_sesong:
            # Lukket når sola er nede (varmetap gjennom 8 m glass), åpent på dagen for solvarme.
            # Er det bitende kaldt, holdes de lukket også på dagen.
            if not sol_oppe:
                onsket = "lukket"
            elif ute is not None and ute < h.num("ki_gardin_ute_grense", -10):
                onsket = "lukket"
            else:
                onsket = "apen"
        elif h.on("ki_sommermodus"):
            # Sommer: skjerm mot sol midt på dagen når det er varmt ute
            try:
                hoyde = float(h.attr("sun.sun", "elevation", 0))
            except (TypeError, ValueError):
                hoyde = 0.0
            vaer_temp = h.f(h.cfg(CONF_UTE_TEMP)) or h.attr(h.cfg(CONF_VAER), "temperature", None)
            if hoyde > 30 and vaer_temp is not None and float(vaer_temp) >= 22:
                onsket = "lukket"
            elif not sol_oppe or hoyde < 15:
                onsket = "apen"
        if onsket and onsket != self.gardin_sist:
            self.gardin_sist = onsket
            await h.kall("cover", "close_cover" if onsket == "lukket" else "open_cover", {"entity_id": cover})
            if h.engine is not None:
                h.engine.logg_hendelse(f"Gardiner {'lukkes' if onsket == 'lukket' else 'åpnes'} "
                                       f"({'sola er nede' if not sol_oppe else 'dag'}, ute {ute if ute is not None else '?'} °C).")
