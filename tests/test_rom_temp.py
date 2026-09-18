"""Ett temperaturpunkt per rom, uansett antall varmekilder."""
from unittest.mock import MagicMock

from custom_components.ki_energi.number import rom_med_soner, rom_slug


def _hub(soner):
    h = MagicMock()
    h.soner.return_value = soner
    return h


SONER = {
    "stue": {"navn": "Stue", "rom": "Stue", "type": "panel", "aktiv": True,
             "climate": ["climate.stue_panelovn", "climate.stue_oljefyr"]},
    "kjokken_panelovn": {"navn": "Kjøkken panelovn", "rom": "Kjøkken", "type": "panel",
                         "aktiv": True, "climate": "climate.kjokken_panelovn"},
    "kjokken_gulv": {"navn": "Kjøkken gulvvarme", "rom": "Kjøkken", "type": "gulv",
                     "aktiv": True, "climate": "climate.kjokken_gulvvarme"},
    "bod": {"navn": "Bod", "rom": "Bod", "type": "panel", "aktiv": False,
            "climate": "climate.bod"},
}


def test_grupperer_paa_rom():
    r = rom_med_soner(_hub(SONER))
    assert set(r) == {"Stue", "Kjøkken"}          # bod er ikke aktiv
    assert len(r["Kjøkken"]) == 2
    assert {k for k, _ in r["Kjøkken"]} == {"kjokken_panelovn", "kjokken_gulv"}


def test_rom_uten_rom_faller_tilbake_paa_navnet():
    r = rom_med_soner(_hub({"x": {"navn": "Loft", "type": "panel", "aktiv": True}}))
    assert "Loft" in r


def test_slug_taaler_norske_tegn():
    assert rom_slug("Kjøkken") == "kjokken"
    assert rom_slug("Soverom barn") == "soverom_barn"
    assert rom_slug("Stue") == "stue"
    assert rom_slug("Bod / vaskerom") == "bod_vaskerom"


def test_alle_klimaenheter_i_rommet_samles():
    from custom_components.ki_energi.number import KiRomTemp
    k = object.__new__(KiRomTemp)
    k.hub = _hub(SONER)
    k.rom = "Kjøkken"
    k._soner = rom_med_soner(k.hub)["Kjøkken"]
    assert set(k._klima()) == {"climate.kjokken_panelovn", "climate.kjokken_gulvvarme"}

    k.rom = "Stue"
    k._soner = rom_med_soner(k.hub)["Stue"]
    assert set(k._klima()) == {"climate.stue_panelovn", "climate.stue_oljefyr"}
