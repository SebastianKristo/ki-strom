"""Sparing — hva KI Energi sparer, og hva som kunne vært spart.

Alt her er anslag uten kontrollgruppe, og merkes slik. Tallene akkumuleres per dag og måned i
minnet og publiseres som `sensor.ki_sparing`.

Poster:
  motor      — flyttet energi til billigere nettleie, unngåtte topper, litt spart kWh (fra engine.besparelse)
  gardiner   — redusert varmetap gjennom glass mens gardinene er lukket om natten
               (og «kunne spart» når de står åpne i timer de burde vært lukket)
  hanklevarmer — mot å la den stå på hele døgnet (fra modes)
  bereder    — energi flyttet til nattariff (prisstyring)
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .const import (
    CONF_ENERGILEDD_DAG, CONF_ENERGILEDD_NATT, CONF_GARDINER, CONF_GLASS_M2, CONF_STROMPRIS, CONF_UTE_TEMP,
    CONF_VVB_EFFEKT,
)

U_GLASS = 1.2          # W/m²K — typisk 2-lags vindu
GARDIN_REDUKSJON = 0.30  # andel av varmetapet gjennom glasset en tett gardin/persienne stopper om natten


class KiSparing:
    def __init__(self, hub) -> None:
        self.hub = hub
        self.m: dict = hub.minne.setdefault("sparing", {})
        self.m.setdefault("dag", {})
        self.m.setdefault("maned", {})
        self._sist: datetime | None = None

    # ------------------------------------------------------------------
    def _rull(self, naa: datetime) -> None:
        """Ny dag → legg dagens tall inn i måneden. Ny måned → start på nytt."""
        d = self.m["dag"]
        mnd = self.m["maned"]
        dag_id = naa.strftime("%Y-%m-%d")
        mnd_id = naa.strftime("%Y-%m")
        if mnd.get("id") != mnd_id:
            mnd.clear()
            mnd["id"] = mnd_id
        if d.get("id") != dag_id:
            if d.get("id") and d["id"][:7] == mnd_id:
                for k, v in d.items():
                    if k != "id" and isinstance(v, (int, float)):
                        mnd[k] = mnd.get(k, 0.0) + v
            d.clear()
            d["id"] = dag_id

    def _legg(self, nokkel: str, kwh: float) -> None:
        if kwh > 0:
            self.m["dag"][nokkel] = self.m["dag"].get(nokkel, 0.0) + kwh

    # ------------------------------------------------------------------
    def tick(self) -> dict[str, Any]:
        """Kalles hvert motor-tick. Akkumulerer og publiserer."""
        h = self.hub
        naa = dt_util.now()
        self._rull(naa)
        dt_h = 0.0
        if self._sist is not None:
            dt_h = min((naa - self._sist).total_seconds() / 3600.0, 0.25)   # aldri mer enn et kvarter per tick
        self._sist = naa

        pris = h.f(h.cfg(CONF_STROMPRIS), 1.5) or 1.5
        dag_nett = h.f(h.cfg(CONF_ENERGILEDD_DAG), 0.0) or 0.0
        natt_nett = h.f(h.cfg(CONF_ENERGILEDD_NATT), 0.0) or 0.0
        diff_nett = max(dag_nett - natt_nett, 0.0)

        # --- gardiner: varmetap gjennom glass = U × A × ΔT. Lukket gardin sparer en andel av det.
        gard = h.hass.states.get("sensor.ki_gardiner") if h.cfg(CONF_GARDINER) else None
        if gard is not None and dt_h > 0:
            glass = float(h.cfg(CONF_GLASS_M2, 20) or 20)
            ute = h.f(h.cfg(CONF_UTE_TEMP))
            inne = None
            for konf in h.aktive_soner().values():
                if konf.get("profil") == "stue":
                    inne = h.engine.romtemperatur(konf) if h.engine is not None else None
                    if inne is not None:
                        break
            inne = inne if inne is not None else 21.0
            if ute is not None and inne > ute:
                tap_kw = U_GLASS * glass * (inne - ute) / 1000.0
                spart_kw = tap_kw * GARDIN_REDUKSJON
                lukket = gard.attributes.get("faktisk") == "closed"
                sol_oppe = bool(gard.attributes.get("sol_oppe", True))
                if lukket and not sol_oppe:
                    self._legg("gardin_kwh", spart_kw * dt_h)
                elif not lukket and not sol_oppe and bool(gard.attributes.get("i_sesong", False)):
                    self._legg("gardin_potensial_kwh", spart_kw * dt_h)

        # --- bereder: energi som går i nattvinduet (prisstyring) → nettleie-differanse
        vvb_eff = h.f(h.cfg(CONF_VVB_EFFEKT))
        if vvb_eff and vvb_eff > 50 and dt_h > 0:
            i_vindu = h.hass.states.get("binary_sensor.ki_vvb_i_vindu")
            if i_vindu is not None and i_vindu.state == "on":
                self._legg("vvb_natt_kwh", vvb_eff / 1000.0 * dt_h)

        # --- samle
        d, mnd = self.m["dag"], self.m["maned"]
        def sum_(k): return d.get(k, 0.0) + mnd.get(k, 0.0)
        besp = h.hass.states.get("sensor.ki_besparelse")
        motor_kr = float(besp.state) if besp is not None and besp.state not in ("unknown", "unavailable", "") else 0.0
        motor_kwh = float(besp.attributes.get("spart_kwh_estimert", 0) or 0) if besp is not None else 0.0
        hank = h.hass.states.get("sensor.ki_hanklevarmer")
        hank_kr = float(hank.attributes.get("spart_kr_maned", 0) or 0) if hank is not None else 0.0
        hank_kwh = float(hank.attributes.get("spart_kwh_maned", 0) or 0) if hank is not None else 0.0
        gard_kwh = sum_("gardin_kwh"); gard_pot = sum_("gardin_potensial_kwh")
        vvb_kwh = sum_("vvb_natt_kwh")
        lys = h.hass.states.get("sensor.ki_lys")
        lys_kwh = float(lys.attributes.get("spart_kwh_maned", 0) or 0) if lys is not None else 0.0
        poster = {
            "motor": {"kwh": round(motor_kwh, 2), "kr": round(motor_kr, 1), "tekst": "Flyttet varme til billigere timer, unngått topper"},
            "gardiner": {"kwh": round(gard_kwh, 2), "kr": round(gard_kwh * pris, 1),
                         "potensial_kwh": round(gard_pot, 2), "potensial_kr": round(gard_pot * pris, 1),
                         "tekst": "Mindre varmetap gjennom vinduene om natten"},
            "hanklevarmer": {"kwh": round(hank_kwh, 2), "kr": round(hank_kr, 1), "tekst": "Av utenom dusjvinduene"},
            "bereder": {"kwh": round(vvb_kwh, 2), "kr": round(vvb_kwh * diff_nett, 1),
                        "tekst": "Varmet i nattariff i stedet for dagtariff"},
            "lys": {"kwh": round(lys_kwh, 2), "kr": round(lys_kwh * pris, 1), "tekst": "Glemte lys slått av, nattdemping"},
        }
        total_kr = sum(p["kr"] for p in poster.values())
        total_kwh = sum(p["kwh"] for p in poster.values())
        ut = {
            "poster": poster, "total_kr_maned": round(total_kr, 1), "total_kwh_maned": round(total_kwh, 2),
            "gardin_kunne_spart_kr": poster["gardiner"]["potensial_kr"],
            "maned": mnd.get("id"), "pris_kr_kwh": pris, "nettleie_diff_kr": diff_nett,
            "forklaring": (f"KI Energi har spart ca. {total_kr:.0f} kr ({total_kwh:.1f} kWh) denne måneden. "
                           + (f"Gardinene kunne spart {gard_pot * pris:.0f} kr til om de var lukket om natten." if gard_pot > 0.05 else "")).strip(),
            "merknad": "Anslag uten kontrollgruppe: gardiner regnes som 30 % mindre varmetap gjennom glasset "
                       f"({U_GLASS} W/m²K) om natten; motorens tall er fra dens egen statistikk.",
        }
        h.sett_sensor("ki_sparing", round(total_kr, 1), ut)
        return ut
