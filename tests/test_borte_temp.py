"""Fraværstemperatur på hytta, og at ankomst avslutter bortemodus."""
import re
from pathlib import Path

KILDE = Path("custom_components/ki_energi")


def _tallgrenser():
    s = (KILDE / "const.py").read_text()
    ut = {}
    for m in re.finditer(
            r'\("(ki_[a-z0-9_]+)", "([^"]*)", ([\d.]+), ([\d.]+), [\d.]+, "[^"]*", ([\d.]+),',
            s):
        ut[m.group(1)] = {"navn": m.group(2), "min": float(m.group(3)),
                          "maks": float(m.group(4)), "std": float(m.group(5))}
    return ut


def _presetverdier():
    s = (KILDE / "const.py").read_text()
    ut = {}
    for blokk in re.finditer(r'"verdier": \{(.*?)\n        \},', s, re.S):
        for m in re.finditer(r'"(ki_[a-z0-9_]+)":\s*(-?[\d.]+)', blokk.group(1)):
            ut.setdefault(m.group(1), []).append(float(m.group(2)))
    return ut


def test_alle_presetverdier_er_innenfor_grensene():
    """Hytteoppsettet satte frostsikringen til 8 °C mens tallet hadde minimum 10.
    En verdi under minimum kan ikke settes, så hyttas egen standard ble avvist."""
    grenser = _tallgrenser()
    feil = []
    for navn, verdier in _presetverdier().items():
        if navn not in grenser:
            continue
        g = grenser[navn]
        for v in verdier:
            if not (g["min"] <= v <= g["maks"]):
                feil.append(f"{navn}={v} utenfor {g['min']}–{g['maks']}")
    assert not feil, "forhåndsvalgte verdier utenfor grensene: " + ", ".join(feil)


def test_frostsikring_kan_settes_lavt():
    """Bortetemperaturene må kunne settes ned til frostsikring. 10 °C er ikke
    frostsikring på en hytte som står tom i januar."""
    g = _tallgrenser()
    for navn in ("ki_temp_helg", "ki_temp_helg_gulvvarme", "ki_temp_helg_bad"):
        assert g[navn]["min"] <= 8, f"{navn} kan ikke settes lavere enn {g[navn]['min']}"


def test_bortetemperaturene_heter_borte_ikke_helg():
    """«Helgemodus» er misvisende på en hytte: den står tom på ukedagene. Navnet er
    grunnen til at innstillingen ikke er å finne når man leter etter fravær."""
    g = _tallgrenser()
    for navn in ("ki_temp_helg", "ki_temp_helg_gulvvarme", "ki_temp_helg_bad"):
        assert "Borte" in g[navn]["navn"], f"{navn} heter «{g[navn]['navn']}»"


def test_ankomst_avslutter_bortemodus_uten_svar_pa_varsel():
    """Kommer noen til hytta mens bortemodus står på, skal den avsluttes med én gang —
    uten at et varsel må godtas. Ellers ville hytta stått på 8 °C mens man er der."""
    s = (KILDE / "modes.py").read_text()
    # Selve betingelsen: noen er hjemme + bortemodus står på -> avslutt
    linjer = [l.strip() for l in s.splitlines()]
    i = next((n for n, l in enumerate(linjer)
              if l.startswith("if borte is False and") and "ki_helgemodus" in l), None)
    assert i is not None, "fant ikke ankomstbetingelsen"
    assert "hjemkomst_ferdig" in linjer[i + 1], f"neste linje er «{linjer[i + 1]}»"
    ferdig = s[s.index("async def hjemkomst_ferdig"):]
    ferdig = ferdig[:ferdig.index("\n    @callback")]
    assert 'h.sett("ki_helgemodus", False)' in ferdig
    assert "await h.engine.tick()" in ferdig, "programmet regnes ikke om etter ankomst"
