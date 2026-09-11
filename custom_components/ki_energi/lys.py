"""Lys — glemte lys og nattdemping, uten å slå av lys noen faktisk bruker.

Regler (config `lysregler`: liste av dict):
  key, navn, light (entity), type: "glemt" | "demp"
  glemt:  presence (binary_sensor, valgfri), fravaer_min (min uten bevegelse før av; med sensor),
          maks_pa_min (min sammenhengende på før av; uten sensor), fra/til (HH:MM-vindu)
  demp:   natt_prosent, dag_prosent, fra/til (natt-vindu; standard husets natt)
  effekt_w: anslått effekt (til besparelsen)

Prinsipper:
* Har rommet en bevegelses-/nærværssensor, slås lyset av bare etter `fravaer_min` uten bevegelse.
  Ingen sensor → bare etter `maks_pa_min` sammenhengende på, og bare i vinduet. Aldri av utenfor.
* Demping setter lysstyrken én gang ved inngang til natt (og tilbake ved dag). Endrer noen
  lysstyrken manuelt etterpå, lar vi den stå til neste overgang — vi slåss ikke med folk.
* Hver regel har egen bryter `switch.ki_lys_<key>`; av = regelen gjør ingenting.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

CONF_LYSREGLER = "lysregler"


def _min(hhmm: str, std: int) -> int:
    try:
        h, m = str(hhmm).split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return std


class KiLys:
    def __init__(self, hub) -> None:
        self.hub = hub
        self.m: dict = hub.minne.setdefault("lys", {})
        self.m.setdefault("pa_siden", {})       # key → iso når lyset sist gikk på
        self.m.setdefault("dempet", {})         # key → {"fase": "natt"/"dag", "satt": prosent}
        self.m.setdefault("sparing", {})        # dag/maned kWh
        self._status: dict[str, dict] = {}

    def regler(self) -> list[dict]:
        liste = self.hub.cfg(CONF_LYSREGLER) or []
        return [r for r in liste if isinstance(r, dict) and r.get("key") and r.get("light")]

    def _vindu(self, r: dict, naa: datetime) -> bool:
        h = self.hub
        if r.get("type") == "demp":
            fra = _min(r.get("fra"), h.tid_min("ki_tid_natt_start", "22:30"))
            til = _min(r.get("til"), h.tid_min("ki_tid_dag_start", "06:30"))
        else:
            fra = _min(r.get("fra"), 8 * 60)
            til = _min(r.get("til"), 22 * 60)
        return h.mellom(fra, til, naa.hour * 60 + naa.minute)

    def _spar(self, kwh: float, naa: datetime) -> None:
        sp = self.m["sparing"]
        dag, mnd = naa.strftime("%Y-%m-%d"), naa.strftime("%Y-%m")
        if sp.get("dag_id") != dag:
            if sp.get("dag_id") and sp["dag_id"][:7] == mnd:
                sp["maned_kwh"] = sp.get("maned_kwh", 0.0) + sp.get("dag_kwh", 0.0)
            if sp.get("maned_id") != mnd:
                sp["maned_id"] = mnd; sp["maned_kwh"] = 0.0
            sp["dag_id"] = dag; sp["dag_kwh"] = 0.0
        sp["dag_kwh"] = sp.get("dag_kwh", 0.0) + kwh

    async def tick(self) -> None:
        h = self.hub
        naa = dt_util.now()
        self._spar(0.0, naa)
        for r in self.regler():
            key = r["key"]
            st = self._status.setdefault(key, {"navn": r.get("navn") or key, "type": r.get("type", "glemt"), "light": r["light"]})
            aktiv = h.on(f"ki_lys_{key}", True)
            lys = h.hass.states.get(r["light"])
            if lys is None:
                st.update(status="mangler", tekst="Lyset finnes ikke")
                continue
            pa = lys.state == "on"
            # spor når det gikk på
            if pa and key not in self.m["pa_siden"]:
                self.m["pa_siden"][key] = naa.isoformat()
            if not pa:
                self.m["pa_siden"].pop(key, None)
            pa_min = 0.0
            if pa:
                siden = dt_util.parse_datetime(self.m["pa_siden"][key])
                pa_min = (naa - siden).total_seconds() / 60 if siden else 0.0
            st.update(pa=pa, pa_min=round(pa_min), aktiv=aktiv, i_vindu=self._vindu(r, naa))
            effekt_w = float(r.get("effekt_w", 10) or 10)
            if not aktiv:
                st.update(status="av", tekst="Regelen er slått av")
                continue
            if r.get("type", "glemt") == "glemt":
                await self._glemt(r, st, pa, pa_min, naa, effekt_w)
            else:
                await self._demp(r, st, lys, pa, naa, effekt_w)
        sp = self.m["sparing"]
        pris = h.f(h.cfg("strompris"), 1.5) or 1.5
        kwh_mnd = sp.get("maned_kwh", 0.0) + sp.get("dag_kwh", 0.0)
        h.sett_sensor("ki_lys", len([s for s in self._status.values() if s.get("aktiv")]), {
            "regler": [dict(key=k, **v) for k, v in self._status.items()],
            "spart_kwh_i_dag": round(sp.get("dag_kwh", 0.0), 3), "spart_kwh_maned": round(kwh_mnd, 2),
            "spart_kr_maned": round(kwh_mnd * pris, 1),
        })

    async def _glemt(self, r: dict, st: dict, pa: bool, pa_min: float, naa: datetime, effekt_w: float) -> None:
        h = self.hub
        presence = r.get("presence") or ""
        if not pa:
            st.update(status="av_lys", tekst="Lyset er av")
            return
        if not self._vindu(r, naa):
            st.update(status="utenfor", tekst="Utenfor tidsvinduet — rører ikke lyset")
            return
        if presence:
            ps = h.hass.states.get(presence)
            if ps is None:
                st.update(status="mangler", tekst="Nærværssensoren finnes ikke — slår ikke av")
                return
            if ps.state == "on":
                st.update(status="i_bruk", tekst="Noen er i rommet — lyset får stå")
                return
            borte_min = (naa - ps.last_changed).total_seconds() / 60
            grense = float(r.get("fravaer_min", 5) or 5)
            if borte_min < grense:
                st.update(status="venter", tekst=f"Ingen bevegelse på {borte_min:.0f} min — slår av etter {grense:.0f}")
                return
            grunn = f"ingen bevegelse på {borte_min:.0f} min"
        else:
            grense = float(r.get("maks_pa_min", 30) or 30)
            if pa_min < grense:
                st.update(status="venter", tekst=f"På i {pa_min:.0f} min — slår av etter {grense:.0f} (ingen sensor i rommet)")
                return
            grunn = f"stått på i {pa_min:.0f} min uten sensor i rommet"
        await h.kall("light", "turn_off", {"entity_id": r["light"]})
        # anslag: ville stått på til vinduet stengte, maks 2 t
        til = _min(r.get("til"), 22 * 60)
        rest_min = min(120, max(0, (til - (naa.hour * 60 + naa.minute)) % 1440))
        self._spar(effekt_w / 1000 * rest_min / 60, naa)
        st.update(status="slatt_av", tekst=f"Slått av — {grunn}", sist_av=naa.strftime("%H:%M"))
        if h.engine is not None:
            h.engine.logg_hendelse(f"Lys: {st['navn']} slått av ({grunn}).")

    async def _demp(self, r: dict, st: dict, lys, pa: bool, naa: datetime, effekt_w: float) -> None:
        h = self.hub
        natt = int(r.get("natt_prosent", 25) or 25)
        dag = int(r.get("dag_prosent", 80) or 80)
        i_natt = self._vindu(r, naa)
        fase = "natt" if i_natt else "dag"
        mal = natt if i_natt else dag
        d = self.m["dempet"].setdefault(r["key"], {})
        if not pa:
            st.update(status="av_lys", tekst=f"Lyset er av ({fase})")
            d.pop("satt", None); d["fase"] = fase
            return
        naa_pct = round((lys.attributes.get("brightness") or 0) / 255 * 100)
        if d.get("fase") != fase or d.get("satt") is None:
            # overgang → sett målnivå én gang
            if abs(naa_pct - mal) > 3:
                await h.kall("light", "turn_on", {"entity_id": r["light"], "brightness_pct": mal})
                if h.engine is not None:
                    h.engine.logg_hendelse(f"Lys: {st['navn']} satt til {mal} % ({fase}).")
            d["fase"] = fase; d["satt"] = mal
            st.update(status="satt", tekst=f"Satt til {mal} % ved {fase}")
        elif abs(naa_pct - d["satt"]) > 3:
            st.update(status="manuell", tekst=f"Endret manuelt til {naa_pct} % — lar det stå til {'dag' if i_natt else 'natt'}")
        else:
            st.update(status="holder", tekst=f"{fase.capitalize()}: {naa_pct} %")
        if i_natt and naa_pct <= natt + 3 and dag > natt:
            # spart i forhold til dagnivå, per tick (1 min)
            self._spar(effekt_w / 1000 * (dag - natt) / 100 / 60, naa)
        st.update(prosent=naa_pct, natt=natt, dag=dag)
