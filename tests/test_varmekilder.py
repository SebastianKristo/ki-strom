"""Flere varmekilder i samme rom, og hvordan typen styrer motoren."""
from custom_components.ki_energi.const import (
    TREGE_TYPER, TYPE_GULV, TYPE_PANEL, TYPE_VANNBAAREN, TYPE_VARMEPUMPE, er_tregt,
)
from custom_components.ki_energi.number import rom_med_soner
from unittest.mock import MagicMock


def test_vannbaaren_regnes_som_treg():
    """Oljefyr og radiatorer må startes tidlig, akkurat som gulvvarme."""
    assert er_tregt(TYPE_VANNBAAREN)
    assert er_tregt(TYPE_GULV)
    assert not er_tregt(TYPE_PANEL)
    assert not er_tregt(TYPE_VARMEPUMPE)
    assert set(TREGE_TYPER) == {TYPE_GULV, TYPE_VANNBAAREN}


def test_ukjent_type_er_ikke_treg():
    assert not er_tregt(None)
    assert not er_tregt("")
    assert not er_tregt("noe_annet")


def test_stue_med_oljefyr_og_panelovn():
    """To soner, én per varmekilde, samme rom – og ett felles temperaturpunkt."""
    hub = MagicMock()
    hub.soner.return_value = {
        "stue_panel": {"navn": "Stue panelovn", "rom": "Stue", "type": TYPE_PANEL,
                       "aktiv": True, "climate": "climate.stue_panelovn"},
        "stue_olje": {"navn": "Stue oljefyr", "rom": "Stue", "type": TYPE_VANNBAAREN,
                      "aktiv": True, "climate": "climate.stue_oljefyr"},
        "kjokken_panel": {"navn": "Kjøkken panelovn", "rom": "Kjøkken", "type": TYPE_PANEL,
                          "aktiv": True, "climate": "climate.kjokken_panelovn"},
        "kjokken_gulv": {"navn": "Kjøkken gulvvarme", "rom": "Kjøkken", "type": TYPE_GULV,
                         "aktiv": True, "climate": "climate.kjokken_gulvvarme"},
    }
    rom = rom_med_soner(hub)
    assert len(rom["Stue"]) == 2
    assert len(rom["Kjøkken"]) == 2
    typer = {k: v["type"] for k, v in rom["Stue"]}
    assert typer == {"stue_panel": TYPE_PANEL, "stue_olje": TYPE_VANNBAAREN}
    # den trege kilden i hvert rom skal behandles som treg
    assert any(er_tregt(v["type"]) for _, v in rom["Stue"])
    assert any(er_tregt(v["type"]) for _, v in rom["Kjøkken"])
