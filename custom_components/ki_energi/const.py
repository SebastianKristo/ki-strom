"""Konstanter, standardverdier og hjelperdefinisjoner for KI Energi."""
from __future__ import annotations

DOMAIN = "ki_energi"
VERSION = "2.0.0"
DEVICE_NAME = "KI Energi"

PLATFORMS = ["sensor", "binary_sensor", "switch", "number", "time", "datetime", "text"]

TICK_SEK = 60
LAERING_MIN = 5
MAKS_LOGG_LINJER = 200
PRIO_VEKT = {1: 10000, 2: 600, 3: 300, 4: 150, 5: 60}

# ---------------------------------------------------------------------------
#  Konfigurasjonsnøkler (config entry data / options)
# ---------------------------------------------------------------------------
CONF_TOTAL_EFFEKT = "total_effekt"
CONF_IMPORTERT_ENERGI = "importert_energi"
CONF_UTE_TEMP = "ute_temp"
CONF_VAER = "vaer"
CONF_VVB_BRYTER = "vvb_bryter"
CONF_VVB_EFFEKT = "vvb_effekt"
CONF_HANKLEVARMER = "hanklevarmer"
CONF_HANKLEVARMER_EFFEKT = "hanklevarmer_effekt"
CONF_GARDINER = "gardiner"
CONF_TILSTEDE_CYBELE = "tilstede_cybele"
CONF_TILSTEDE_SEBASTIAN = "tilstede_sebastian"
CONF_TILSTEDE_RUNE = "tilstede_rune"
CONF_TOPP1 = "topp1"
CONF_TOPP2 = "topp2"
CONF_TOPP3 = "topp3"
CONF_ENERGILEDD_DAG = "energiledd_dag"
CONF_ENERGILEDD_NATT = "energiledd_natt"
CONF_STROMPRIS = "strompris"
CONF_KAPASITETSTRINN = "kapasitetstrinn"
CONF_NORGESPRIS_AKTIV = "norgespris_aktiv"
CONF_NORDPOOL = "nordpool"
CONF_HVITEVARER = "hvitevarer"
CONF_VARSEL_MOTTAKERE = "varsel_mottakere"
CONF_AREAL = "areal_m2"
CONF_BYGGEAR = "byggear"
CONF_GLASS_M2 = "glass_m2"
CONF_STUE_AREAL = "stue_areal_m2"
CONF_SONER = "soner"
CONF_HUSTYPE = "hustype"      # bolig | fritidsbolig
CONF_HAR_ELBIL = "har_elbil"  # vis/bruk elbil-innstillingene
CONF_PERSONER = "personer"
CONF_LYSREGLER = "lysregler"  # liste av lysregler (glemt lys / nattdemping)    # liste av {key, navn, entity, type}; type: barn | ungdom | voksen
PERSONTYPER = {
    "barn": "Barn — fast opp/legg og borte på dagtid (barnehage/skole)",
    "ungdom": "Ungdom/student — vekking hverdag og helg, egen leggetid, feriebryter",
    "voksen": "Voksen — bare tilstedeværelse",
}
# Standardpersoner for nye oppsett — generiske; navn og entiteter fylles inn i veiviseren.
DEFAULT_PERSONER = [
    {"key": "barn", "navn": "Barn", "type": "barn", "entity": ""},
    {"key": "ungdom", "navn": "Ungdom", "type": "ungdom", "entity": ""},
    {"key": "voksen", "navn": "Voksen", "type": "voksen", "entity": ""},
]
# Eldre oppsett (før personlisten) hadde tre faste tilstedeværelsesfelt. Nøklene beholdes så
# entitets-ID-ene deres ikke endres; navnet utledes av nøkkelen.
LEGACY_PERSONER = [
    {"key": "cybele", "type": "barn"}, {"key": "sebastian", "type": "ungdom"}, {"key": "rune", "type": "voksen"},
]
# Hjelpere som lages per person, etter type: (suffiks, navn, standard, ikon)
PERSON_TIDER = {
    "barn": [("dag", "Dag Starter", "05:30", "mdi:alarm"), ("natt", "Natt Starter", "19:00", "mdi:bed"),
             ("borte_fra", "Normalt Borte Fra", "08:00", "mdi:home-export-outline"),
             ("borte_til", "Normalt Hjemme Igjen", "15:00", "mdi:home-import-outline")],
    "ungdom": [("natt", "Natt Starter", "23:00", "mdi:bed"), ("vekking", "Vekking Hverdag", "07:00", "mdi:alarm"),
               ("vekking_helg", "Vekking Helg/Ferie", "09:30", "mdi:alarm")],
    "voksen": [],
}
PERSON_BRYTERE = {"barn": [], "ungdom": [("ferie", "Ferie", False, "mdi:school-outline")], "voksen": []}
CONF_PRESET = "preset"        # oslo | toten | tom

# Sonefelt
Z_NAVN = "navn"
Z_ROM = "rom"
Z_CLIMATE = "climate"
Z_EFFEKT = "effekt"
Z_DUTY = "duty"
Z_TEMP = "temp"
Z_VINDU = "vindu"        # liste av binary_sensor (vindu/dør) — åpent = varmen settes ned
Z_TYPE = "type"          # panel | gulv
Z_PRIO = "prio"
Z_NOMINELL = "nominell"  # kW
Z_SOL = "sol"
Z_PROFIL = "profil"
Z_AKTIV = "aktiv"
Z_TEMP_DAG = "temp_dag"      # hjelper-nøkkel (number.<key>)
Z_TEMP_NATT = "temp_natt"
Z_TEMP_BORTE = "temp_borte"

PROFILER = ["fellesrom", "stue", "konstant", "gulv_natt", "sjelden"]
# Gamle profilnavn → personprofil
PROFIL_LEGACY = {"cybele": "person:cybele", "sebastian": "person:sebastian"}
PROFIL_TEKST = {
    "fellesrom": "Fellesrom (dag/natt med økonomisk nattsenking)",
    "stue": "Stue (som fellesrom, pluss reduksjon etter formiddag og solkompensasjon)",
    "konstant": "Konstant (holdes på settpunkt hele døgnet, f.eks. bad)",
    "gulv_natt": "Gulvvarme med nattsenking hvis lønnsomt (f.eks. kjøkken)",
    "sjelden": "Sjelden brukt (aggressiv sparestrategi, f.eks. do og vaskegang)",
    "cybele": "Barn (eldre profilnavn)",
    "sebastian": "Ungdom (eldre profilnavn)",
}

DEFAULT_SONER: dict[str, dict] = {
    "stue": dict(
        navn="Stue", rom="Stue", climate=["climate.stue_panelovn", "climate.stue_oljefyr"],
        effekt=["sensor.stue_panelovn_current_power", "sensor.stue_oljefyr_current_power"],
        duty="sensor.stue_panelovn_control_signal",
        temp="", type="panel", prio=3, nominell=3.0, sol=True, profil="stue", aktiv=True,
        temp_dag="ki_temp_stue_dag", temp_natt="ki_temp_stue_natt", temp_borte=""),
    "trappegang": dict(
        navn="Trappegang", rom="Trappegang", climate="climate.trappegang_panelovn",
        effekt="sensor.trappegang_panelovn_current_power",
        duty="sensor.trappegang_panelovn_control_signal",
        temp="", type="panel", prio=3, nominell=0.8, sol=False, profil="fellesrom", aktiv=True,
        temp_dag="ki_temp_trappegang_dag", temp_natt="ki_temp_trappegang_natt", temp_borte=""),
    "kjokken_panelovn": dict(
        navn="Kjøkken panelovn", rom="Kjøkken", climate="climate.kjokken_panelovn",
        effekt="sensor.kjokken_panelovn_current_power",
        duty="sensor.kjokken_panelovn_control_signal",
        temp="", type="panel", prio=3, nominell=1.0, sol=False, profil="fellesrom", aktiv=True,
        temp_dag="ki_temp_kjokken_panelovn_dag", temp_natt="ki_temp_kjokken_panelovn_natt",
        temp_borte=""),
    "soverom_barn": dict(
        navn="Soverom barn", rom="Soverom barn", climate="climate.soverom_barn",
        effekt="sensor.soverom_barn_effekt",
        duty="",
        temp="", type="panel", prio=3, nominell=1.0, sol=False, profil="person:barn", aktiv=True,
        temp_dag="ki_temp_soverom_barn_dag", temp_natt="ki_temp_soverom_barn_natt",
        temp_borte="ki_temp_soverom_barn_borte"),
    "soverom_ungdom": dict(
        navn="Soverom ungdom", rom="Soverom ungdom", climate="climate.soverom_ungdom",
        effekt="sensor.soverom_ungdom_effekt", duty="",
        temp="sensor.panelovn_temperature", type="panel", prio=3, nominell=0.8, sol=False,
        profil="person:ungdom", aktiv=True,
        temp_dag="ki_temp_soverom_ungdom_dag", temp_natt="ki_temp_soverom_ungdom_natt", temp_borte=""),
    "kjokken_gulv": dict(
        navn="Kjøkken gulvvarme", rom="Kjøkken", climate="climate.kjokken_gulvvarme",
        effekt="sensor.kjokken_gulvvarme_power", duty="",
        temp="sensor.kjokken_gulvvarme_air_temperature", type="gulv", prio=3, nominell=0.8,
        sol=False, profil="gulv_natt", aktiv=True,
        temp_dag="ki_temp_kjokken", temp_natt="", temp_borte=""),
    "bad_gulv": dict(
        navn="Bad gulvvarme", rom="Bad", climate="climate.bad_gulvvarme",
        effekt="sensor.bad_gulvvarme_power", duty="", temp="sensor.bad_gulvvarme_temperature",
        type="gulv", prio=2, nominell=0.7, sol=False, profil="konstant", aktiv=True,
        temp_dag="ki_temp_bad", temp_natt="", temp_borte=""),
    "vaskegang_gulv": dict(
        navn="Vaskegang gulvvarme", rom="Vaskegang", climate="climate.vaskegang_gulvvarme",
        effekt="sensor.vaskegang_gulvvarme_power", duty="",
        temp="sensor.vaskegang_gulvvarme_air_temperature", type="gulv", prio=4, nominell=0.5,
        sol=False, profil="sjelden", aktiv=True,
        temp_dag="ki_temp_vaskegang", temp_natt="", temp_borte=""),
    "do_gulv": dict(
        navn="Do gulvvarme", rom="Do", climate="climate.do_gulvvarme",
        effekt="sensor.do_gulvvarme_power", duty="", temp="sensor.do_gulvvarme_room_temperature",
        type="gulv", prio=4, nominell=0.4, sol=False, profil="sjelden", aktiv=True,
        temp_dag="ki_temp_do", temp_natt="", temp_borte=""),
}

DEFAULT_CONFIG = {
    CONF_TOTAL_EFFEKT: "sensor.strommaler_effekt",
    CONF_IMPORTERT_ENERGI: "sensor.strommaler_imported_energy",
    CONF_UTE_TEMP: "sensor.outdoor_meter_temperature",
    CONF_VAER: "weather.forecast_home",
    CONF_VVB_BRYTER: "switch.varmtvannsbereder",
    CONF_VVB_EFFEKT: "sensor.varmtvannsbereder_power",
    CONF_HANKLEVARMER: "switch.hanklevarmer",
    CONF_HANKLEVARMER_EFFEKT: "sensor.hanklevarmer_power",
    CONF_GARDINER: "",
    CONF_TILSTEDE_CYBELE: "", CONF_TILSTEDE_SEBASTIAN: "", CONF_TILSTEDE_RUNE: "",
    CONF_TOPP1: "sensor.nettleie_elvia_toppforbruk",
    CONF_TOPP2: "sensor.nettleie_elvia_toppforbruk_2",
    CONF_TOPP3: "sensor.nettleie_elvia_toppforbruk_3",
    CONF_ENERGILEDD_DAG: "sensor.nettleie_elvia_energiledd_dag",
    CONF_ENERGILEDD_NATT: "sensor.nettleie_elvia_energiledd_natt_helg",
    CONF_STROMPRIS: "sensor.norgespris_total_strompris_norgespris",
    CONF_KAPASITETSTRINN: "sensor.nettleie_elvia_kapasitetstrinn",
    CONF_NORGESPRIS_AKTIV: "binary_sensor.norgespris_norgespris_aktiv_na",
    CONF_NORDPOOL: "",
    CONF_HVITEVARER: [],
    CONF_VARSEL_MOTTAKERE: [],
    CONF_AREAL: 120,
    CONF_BYGGEAR: 1990,
    CONF_GLASS_M2: 20,
    CONF_STUE_AREAL: 40,
}

# ---------------------------------------------------------------------------
#  Presets: ferdige oppsett for et hus. Entitets-ID-ene er forslag som redigeres i oppsettet.
# ---------------------------------------------------------------------------
DEFAULT_SONER_HYTTE: dict[str, dict] = {
    "stue": dict(
        navn="Stue", rom="Stue", climate=["climate.hytte_stue_varmepumpe"], effekt=["sensor.hytte_stue_varmepumpe_effekt"],
        duty="", temp="", type="varmepumpe", prio=1, nominell=1.2, sol=False, profil="stue", aktiv=True,
        temp_dag="ki_temp_stue_dag", temp_natt="ki_temp_stue_natt", temp_borte=""),
    "kjokken_gulv": dict(
        navn="Kjøkken", rom="Kjøkken", climate=["climate.hytte_kjokken_gulv"], effekt=["sensor.hytte_kjokken_gulv_effekt"],
        duty="", temp="", type="gulv", prio=3, nominell=0.8, sol=False, profil="gulv_natt", aktiv=True,
        temp_dag="ki_temp_kjokken_gulv_dag", temp_natt="ki_temp_kjokken_gulv_natt", temp_borte=""),
    "bad_gulv": dict(
        navn="Bad", rom="Bad", climate=["climate.hytte_bad_gulv"], effekt=["sensor.hytte_bad_gulv_effekt"],
        duty="", temp="", type="gulv", prio=2, nominell=0.6, sol=False, profil="konstant", aktiv=True,
        temp_dag="ki_temp_bad_gulv_dag", temp_natt="ki_temp_bad_gulv_natt", temp_borte=""),
    "inngang": dict(
        navn="Inngang", rom="Inngang", climate=["climate.hytte_inngang_gulv", "climate.hytte_inngang_oljefyr"],
        effekt=["sensor.hytte_inngang_gulv_effekt", "sensor.hytte_inngang_oljefyr_effekt"],
        duty="", temp="", type="gulv", prio=4, nominell=1.6, sol=False, profil="sjelden", aktiv=True,
        temp_dag="ki_temp_trappegang_dag", temp_natt="ki_temp_trappegang_natt", temp_borte=""),
    "soverom_barn": dict(
        navn="Soverom barn", rom="Soverom barn", climate=["climate.hytte_soverom_barn"], effekt=["sensor.hytte_soverom_barn_effekt"],
        duty="", temp="", type="panel", prio=2, nominell=1.0, sol=False, profil="person:barn", aktiv=True,
        temp_dag="ki_temp_soverom_barn_dag", temp_natt="ki_temp_soverom_barn_natt", temp_borte="ki_temp_soverom_barn_borte"),
    "soverom_ungdom": dict(
        navn="Soverom ungdom", rom="Soverom ungdom", climate=["climate.hytte_soverom_ungdom"], effekt=["sensor.hytte_soverom_ungdom_effekt"],
        duty="", temp="", type="panel", prio=3, nominell=1.0, sol=False, profil="person:ungdom", aktiv=True,
        temp_dag="ki_temp_soverom_ungdom_dag", temp_natt="ki_temp_soverom_ungdom_natt", temp_borte=""),
    "soverom_voksen": dict(
        navn="Soverom voksen", rom="Soverom voksen", climate=["climate.hytte_soverom_voksen"], effekt=["sensor.hytte_soverom_voksen_effekt"],
        duty="", temp="", type="panel", prio=4, nominell=1.0, sol=False, profil="fellesrom", aktiv=True,
        temp_dag="ki_temp_stue_dag", temp_natt="ki_temp_stue_natt", temp_borte=""),
}

# (nøkkel → {navn, hustype, beskrivelse, config-overstyringer, soner, hjelperverdier satt én gang})
PRESETS: dict[str, dict] = {
    "bolig": {
        "navn": "Bolig (standard)", "hustype": "bolig",
        "beskrivelse": "Panelovner og gulvvarme, bereder med relé, håndklevarmer, helg og hjemkomst.",
        "config": {}, "soner": DEFAULT_SONER, "verdier": {}, "personer": DEFAULT_PERSONER,
    },
    "hytte": {
        "navn": "Fritidsbolig", "hustype": "fritidsbolig",
        "beskrivelse": "Frostsikring når ingen er der, oppvarming før ankomst, varmepumpe i stua, gulvvarme, "
                       "panelovner på soverom, bereder som bare måles, elbillader om natten.",
        "config": {
            CONF_AREAL: 100, CONF_BYGGEAR: 1970, CONF_GLASS_M2: 12, CONF_STUE_AREAL: 30,
            CONF_VVB_BRYTER: "", CONF_VVB_EFFEKT: "sensor.hytte_bereder_effekt",
            CONF_HANKLEVARMER: "", CONF_HANKLEVARMER_EFFEKT: "", CONF_GARDINER: "",
            CONF_TOTAL_EFFEKT: "sensor.hytte_strommaler_effekt", CONF_IMPORTERT_ENERGI: "sensor.hytte_strommaler_imported_energy",
            CONF_UTE_TEMP: "sensor.hytte_utetemperatur", CONF_VAER: "weather.forecast_home",
            CONF_HAR_ELBIL: True,
        },
        "soner": DEFAULT_SONER_HYTTE,
        "personer": DEFAULT_PERSONER,
        "verdier": {
            # tom hytte = frostsikring, ikke 16 °C
            "ki_temp_helg": 8.0, "ki_temp_helg_gulvvarme": 10.0, "ki_temp_helg_bad": 12.0, "ki_helg_senk_gulvvarme": True,
            "ki_helg_auto_timer": 3, "ki_helg_auto": True, "ki_hjemkomst_tid": "17:00",
            # spør fredag (ikke torsdag), søndag kl. 10 med frist 12
            "ki_helg_spor_torsdag": False, "ki_helg_spor_fredag": True, "ki_helg_varsel_tid": "10:00",
            "ki_helg_sporsmal_tid": "10:00", "ki_helg_frist_tid": "12:00",
            # kapasitet: under 5 kW om mulig, aldri over 10 (absolutt grense 9,5)
            "ki_mal_trinn_kw": 5.0, "ki_maks_time_kwh": 9.5, "ki_min_time_kwh": 2.5, "ki_reserve_topp_kwh": 0.4,
            # elbil 5 A om natten (3-fas ≈ 3,5 kW; 1-fas ≈ 1,2 — juster)
            "ki_elbil_natt": True, "ki_elbil_effekt_kw": 3.5,
            "ki_sommer_auto": True, "ki_styr_gardiner": False, "ki_styr_hanklevarmer": False,
        },
    },
    "tom": {"navn": "Tomt oppsett (velg alt selv)", "hustype": "bolig", "beskrivelse": "", "config": {}, "soner": {}, "verdier": {}, "personer": []},
}

# ---------------------------------------------------------------------------
#  Hjelperentiteter. Nøkkelen er object_id; entiteten heter <domene>.<nøkkel>.
#  Verdiene overlever restart (RestoreEntity). Standardverdi brukes første gang.
# ---------------------------------------------------------------------------

# (nøkkel, navn, standard, ikon)
SWITCHES = [
    ("ki_energi_hovedbryter", "KI Energimotor", True, "mdi:brain"),
    ("ki_skyggemodus", "KI Skyggemodus", True, "mdi:ghost-outline"),
    ("ki_helgemodus", "KI Helgemodus", False, "mdi:bag-suitcase"),
    ("ki_helg_auto", "KI Helg Auto-aktivering Ved Fravær", True, "mdi:home-export-outline"),
    ("ki_helg_venter_svar", "KI Helg Venter På Svar", False, "mdi:help-circle-outline"),
    ("ki_helg_senk_gulvvarme", "KI Helg Senk Gulvvarme", False, "mdi:heating-coil"),
    ("ki_hjemkomst_aktiv", "KI Hjemkomst Pågår", False, "mdi:home-import-outline"),
    ("ki_sommermodus", "KI Sommermodus", False, "mdi:white-balance-sunny"),
    ("ki_sommer_auto", "KI Sommermodus Automatisk", False, "mdi:calendar-sync"),
    ("ki_styr_gardiner", "KI Styr Gardiner", False, "mdi:curtains"),
    ("ki_gardin_folg_sol", "KI Gardiner Følg Sola", True, "mdi:weather-sunset"),
    ("ki_styr_hanklevarmer", "KI Styr Håndklevarmer", True, "mdi:radiator"),
    ("ki_vvb_prisstyring", "KI VVB Prisstyring", True, "mdi:cash-clock"),
    ("ki_vvb_alltid_pa", "KI VVB Alltid På", False, "mdi:power"),
    ("ki_vvb_folg_spotpris", "KI VVB Følg Spotpris", False, "mdi:chart-line"),
    ("ki_vvb_legionella_aktiv", "KI VVB Legionellasikring Aktiv", True, "mdi:bacteria-outline"),
    ("ki_vvb_har_trukket_effekt", "KI VVB Har Trukket Effekt", False, "mdi:flash"),
    ("ki_vvb_tvungen_syklus_aktiv", "KI VVB Tvungen Syklus Aktiv", False, "mdi:alert-decagram"),
    ("ki_vvb_kritisk_varslet", "KI VVB Kritisk Varslet", False, "mdi:alert-octagon"),
    ("ki_dynamisk_grense", "KI Dynamisk Grense", True, "mdi:target"),
    ("ki_prediktiv_forvarming", "KI Prediktiv Forvarming", True, "mdi:thermometer-chevron-up"),
    ("ki_laering_tau", "KI Lær Tidskonstanter", True, "mdi:school"),
    ("ki_solkompensasjon", "KI Solkompensasjon", True, "mdi:weather-sunny"),
    ("ki_vindu_stopp", "KI Vindu Åpent Stopper Varme", True, "mdi:window-open-variant"),
    ("ki_tillat_dyrere_trinn", "KI Tillat Dyrere Kapasitetstrinn", False, "mdi:cash-lock-open"),
    ("ki_elbil_natt", "KI Elbil Lader Om Natten", False, "mdi:ev-station"),
    ("ki_auto_soveromsmodus", "KI Automatisk Soveromsmodus", True, "mdi:sleep"),
    ("ki_adaptiv_reserve", "KI Adaptiv Reserve", True, "mdi:school-outline"),
    ("ki_gradvis_gjenoppvarming", "KI Gradvis Gjenoppvarming", True, "mdi:stairs-up"),
    ("ki_nattsenk_aktiv", "KI Nattsenking Aktiv", True, "mdi:weather-night"),
    ("ki_nattsenk_okonomi", "KI Økonomisk Nattsenking", True, "mdi:cash-check"),
    ("ki_energi_varsler", "KI Energivarsler", True, "mdi:bell-outline"),
    ("ki_varsel_effekt", "KI Varsel Effektgrense", True, "mdi:flash-alert"),
    ("ki_helg_spor_torsdag", "KI Helg Spør Torsdag", True, "mdi:calendar-question"),
    ("ki_helg_spor_fredag", "KI Helg Spør Fredag", True, "mdi:calendar-question"),
    ("ki_varsel_helg", "KI Varsel Helg", True, "mdi:bag-suitcase"),
    ("ki_varsel_hjemkomst", "KI Varsel Hjemkomst", True, "mdi:home-import-outline"),
    ("ki_varsel_sommer", "KI Varsel Sommermodus", True, "mdi:white-balance-sunny"),
    ("ki_varsel_vvb", "KI Varsel Varmtvann", True, "mdi:water-boiler"),
    ("ki_varsel_hanklevarmer", "KI Varsel Håndklevarmer", True, "mdi:radiator"),
]

# (nøkkel, navn, min, maks, steg, enhet, standard, ikon)
NUMBERS = [
    ("ki_temp_stue_dag", "KI Temp Stue Dag", 15, 26, 0.5, "°C", 22, "mdi:sofa"),
    ("ki_temp_stue_natt", "KI Temp Stue Natt", 12, 24, 0.5, "°C", 19, "mdi:weather-night"),
    ("ki_temp_trappegang_dag", "KI Temp Trappegang Dag", 12, 24, 0.5, "°C", 20, "mdi:stairs"),
    ("ki_temp_trappegang_natt", "KI Temp Trappegang Natt", 10, 22, 0.5, "°C", 17, "mdi:stairs"),
    ("ki_temp_kjokken", "KI Temp Kjøkken Gulvvarme", 18, 27, 0.5, "°C", 24, "mdi:countertop"),
    ("ki_temp_kjokken_panelovn_dag", "KI Temp Kjøkken Panelovn Dag", 15, 26, 0.5, "°C", 22, "mdi:countertop"),
    ("ki_temp_kjokken_panelovn_natt", "KI Temp Kjøkken Panelovn Natt", 12, 24, 0.5, "°C", 19, "mdi:countertop"),
    ("ki_temp_bad", "KI Temp Bad Gulvvarme", 18, 28, 0.5, "°C", 24, "mdi:shower"),
    ("ki_temp_do", "KI Temp Do Gulvvarme", 12, 25, 0.5, "°C", 20, "mdi:toilet"),
    ("ki_temp_vaskegang", "KI Temp Vaskegang Gulvvarme", 5, 28, 0.5, "°C", 20, "mdi:washing-machine"),
    ("ki_temp_helg", "KI Temp Helgemodus Panelovner", 10, 20, 0.5, "°C", 16, "mdi:bag-suitcase"),
    ("ki_temp_helg_gulvvarme", "KI Temp Helg Gulvvarme", 12, 24, 0.5, "°C", 18, "mdi:heating-coil"),
    ("ki_temp_helg_bad", "KI Temp Helg Bad", 12, 26, 0.5, "°C", 22, "mdi:shower"),
    ("ki_temp_sommer", "KI Temp Sommer Grunnvarme", 10, 20, 0.5, "°C", 17, "mdi:white-balance-sunny"),
    ("ki_natt_senk_ute_grense", "KI Nattsenk Kun Når Utetemp Under", 0, 20, 1, "°C", 12, "mdi:thermometer-low"),
    ("ki_stue_reduksjon", "KI Stue Reduksjon Etter Formiddag", 0, 4, 0.5, "°C", 1.5, "mdi:sofa-outline"),
    ("ki_gardin_start_maned", "KI Gardiner Fra Måned", 1, 12, 1, "", 10, "mdi:calendar-start"),
    ("ki_gardin_slutt_maned", "KI Gardiner Til Og Med Måned", 1, 12, 1, "", 4, "mdi:calendar-end"),
    ("ki_gardin_ute_grense", "KI Gardiner Lukk Også På Dagen Under", -30, 10, 1, "°C", -10, "mdi:snowflake"),
    ("ki_sommer_start_maned", "KI Sommer Fra Måned", 1, 12, 1, "", 6, "mdi:calendar-start"),
    ("ki_sommer_slutt_maned", "KI Sommer Til Og Med Måned", 1, 12, 1, "", 8, "mdi:calendar-end"),
    ("ki_sommer_ute_grense", "KI Sommer Når Døgnsnitt Ute Over", 5, 25, 1, "°C", 15, "mdi:thermometer-high"),
    ("ki_helg_auto_timer", "KI Helg Auto Etter Timer Borte", 1, 24, 1, "t", 6, "mdi:timer-sand"),
    ("ki_hanklevarmer_maks_pa_tid", "KI Håndklevarmer Maks På-Tid", 30, 480, 15, "min", 240, "mdi:timer-alert-outline"),
    ("ki_vvb_metning_terskel_w", "KI VVB Effektgrense Utkoblet Termostat", 20, 500, 10, "W", 150, "mdi:flash-off"),
    ("ki_vvb_metning_minutter", "KI VVB Minutter Null Effekt Før Mettet", 2, 30, 1, "min", 8, "mdi:timer-check"),
    ("ki_vvb_min_syklus_min", "KI VVB Minste Oppvarming For Godkjent Metning", 5, 240, 5, "min", 25, "mdi:timer-sand"),
    ("ki_vvb_maks_min_uten_effekt", "KI VVB Maks Minutter Uten Effekt Etter Start", 3, 60, 1, "min", 10, "mdi:timer-alert"),
    ("ki_vvb_maks_oppvarming_min", "KI VVB Maks Sammenhengende Oppvarming", 60, 600, 15, "min", 300, "mdi:clock-alert-outline"),
    ("ki_vvb_intervall_dager", "KI VVB Ønsket Intervall Mellom Metninger", 1, 14, 1, "d", 3, "mdi:calendar-refresh"),
    ("ki_vvb_maks_dager", "KI VVB Hard Legionellafrist", 2, 21, 1, "d", 7, "mdi:calendar-alert"),
    ("ki_vvb_effekt_kw", "KI VVB Effekt", 0.5, 4, 0.1, "kW", 2.0, "mdi:flash"),
    ("ki_vvb_boost_minutter", "KI VVB Boost Varighet", 15, 240, 15, "min", 60, "mdi:rocket-launch"),
    ("vvb_billigste_timer_dogn", "VVB Antall Billige Timer", 1, 14, 1, "t", 6, "mdi:clock-check"),
    ("ki_maks_time_kwh", "KI Absolutt Timegrense", 2, 15, 0.05, "kWh", 6.0, "mdi:flash-alert"),
    ("ki_mal_snitt_kwh", "KI Mål For Snitt Av Tre Topper", 2, 5, 0.05, "kWh", 4.7, "mdi:target"),
    ("ki_min_time_kwh", "KI Laveste Timegrense", 1, 5, 0.1, "kWh", 3.0, "mdi:arrow-collapse-down"),
    ("ki_reserve_uregulert_kwh", "KI Reserve For Uregulert Last", 0, 2, 0.05, "kWh", 0.35, "mdi:shield-outline"),
    ("ki_reserve_frokost_kwh", "KI Effektreserve Frokost", 0, 3, 0.1, "kW", 0.7, "mdi:toaster"),
    ("ki_reserve_middag_kwh", "KI Effektreserve Middag", 0, 3, 0.1, "kW", 1.0, "mdi:stove"),
    ("ki_sone_gul", "KI Sonegrense Gul", 50, 95, 1, "%", 75, "mdi:circle"),
    ("ki_sone_oransje", "KI Sonegrense Oransje", 60, 100, 1, "%", 88, "mdi:circle"),
    ("ki_sone_rod", "KI Sonegrense Rød", 70, 110, 1, "%", 97, "mdi:circle"),
    ("ki_shed_gulv_maks", "KI Maks Senking Gulvvarme", 0, 6, 0.5, "°C", 3.0, "mdi:heating-coil"),
    ("ki_shed_panel_maks", "KI Maks Senking Panelovn", 0, 6, 0.5, "°C", 2.0, "mdi:radiator"),
    ("ki_vindu_forsinkelse_min", "KI Vindu Forsinkelse", 0, 30, 1, "min", 3, "mdi:timer-outline"),
    ("ki_vindu_temp", "KI Vindu Åpent Temperatur", 5, 18, 0.5, "°C", 12, "mdi:snowflake-thermometer"),
    ("ki_komfort_vekt", "KI Komfortvekt", 10, 200, 5, "", 60, "mdi:sofa"),
    ("ki_trinn_kostnad_diff", "KI Kostnad Neste Kapasitetstrinn", 0, 500, 5, "kr", 170, "mdi:cash"),
    ("ki_mal_trinn_kw", "KI Ønsket Kapasitetstrinn Under", 2, 20, 0.5, "kW", 5.0, "mdi:target"),
    ("ki_reserve_topp_kwh", "KI Reserve Mot Neste Trinn", 0, 1.5, 0.05, "kWh", 0.3, "mdi:shield-half-full"),
    ("ki_elbil_effekt_kw", "KI Elbil Ladeeffekt", 0, 22, 0.1, "kW", 0, "mdi:ev-station"),
    ("ki_hanklevarmer_effekt_w", "KI Håndklevarmer Effekt", 10, 500, 1, "W", 46, "mdi:radiator"),
    ("ki_prognose_margin_min", "KI Prognosemargin Minimum", 0, 1, 0.05, "kWh", 0.0, "mdi:arrow-collapse-down"),
    ("ki_prognose_margin_maks", "KI Prognosemargin Maksimum", 0.2, 3, 0.05, "kWh", 1.5, "mdi:arrow-collapse-up"),
    ("ki_prognose_min_obs", "KI Prognose Minste Grunnlag", 4, 60, 1, "", 8, "mdi:counter"),
    ("ki_gjenoppvarming_intervall_min", "KI Gjenoppvarming Intervall", 1, 15, 1, "min", 3, "mdi:timer-outline"),
    ("ki_stat_unngatte_topper", "KI Unngåtte Topper", 0, 9999, 1, "", 0, "mdi:shield-check"),
    ("ki_stat_shed_hendelser", "KI Utkoblinger", 0, 99999, 1, "", 0, "mdi:stairs-down"),
    ("ki_stat_flyttet_kwh", "KI Flyttet Energi", 0, 9999, 0.01, "kWh", 0, "mdi:swap-horizontal"),
    ("ki_stat_spart_kr", "KI Estimert Spart", 0, 99999, 0.01, "kr", 0, "mdi:piggy-bank"),
    ("ki_stat_komfortavvik", "KI Komfortavvik Akkumulert", 0, 99999, 0.01, "°C·t", 0, "mdi:emoticon-neutral-outline"),
]

# (nøkkel, navn, standard "HH:MM", ikon)
TIMES = [
    ("ki_tid_dag_start", "KI Fellesrom Dag Starter", "06:30", "mdi:weather-sunset-up"),
    ("ki_tid_natt_start", "KI Fellesrom Natt Starter", "22:30", "mdi:weather-night"),
    ("ki_helg_varsel_tid", "KI Helg Spørsmål Fredag", "10:00", "mdi:bell"),
    ("ki_helg_sporsmal_tid", "KI Helg Spørsmål Søndag", "08:00", "mdi:bell"),
    ("ki_helg_varsel_tid_torsdag", "KI Helg Spørsmål Torsdag", "16:00", "mdi:bell-outline"),
    ("ki_helg_frist_tid", "KI Helg Svarfrist Søndag", "10:00", "mdi:bell-alert"),
    ("ki_hjemkomst_tid", "KI Forventet Hjemkomst Søndag", "13:00", "mdi:home-clock"),
    ("ki_frokost_start", "KI Frokostvindu Start", "06:30", "mdi:toaster"),
    ("ki_frokost_slutt", "KI Frokostvindu Slutt", "08:30", "mdi:toaster"),
    ("ki_middag_start", "KI Middagsvindu Start", "15:30", "mdi:stove"),
    ("ki_middag_slutt", "KI Middagsvindu Slutt", "19:00", "mdi:stove"),
    ("ki_gardin_apne_tidligst", "KI Gardiner Åpne Tidligst", "07:00", "mdi:curtains"),
    ("ki_elbil_fra", "KI Elbil Lader Fra", "22:00", "mdi:ev-station"),
    ("ki_elbil_til", "KI Elbil Lader Til", "06:00", "mdi:ev-station"),
    ("ki_gardin_lukk_senest", "KI Gardiner Lukk Senest", "22:00", "mdi:curtains-closed"),
    ("ki_hanklevarmer_morgen_start", "KI Håndklevarmer Morgen Start", "05:30", "mdi:radiator"),
    ("ki_hanklevarmer_morgen_slutt", "KI Håndklevarmer Morgen Slutt", "08:30", "mdi:radiator"),
    ("ki_hanklevarmer_kveld_start", "KI Håndklevarmer Kveld Start", "19:00", "mdi:radiator"),
    ("ki_hanklevarmer_kveld_slutt", "KI Håndklevarmer Kveld Slutt", "22:00", "mdi:radiator"),
    ("ki_vvb_vindu_start", "KI VVB Vindu Start", "22:00", "mdi:water-boiler"),
    ("ki_vvb_klar_innen", "KI VVB Ferdig Innen", "05:00", "mdi:water-boiler"),
    ("ki_stue_reduksjon_fra", "KI Stue Reduksjon Fra", "12:00", "mdi:sofa-outline"),
]

# (nøkkel, navn, ikon)
DATETIMES = [
    ("ki_vvb_siste_godkjente_syklus", "KI VVB Siste Bekreftede Metning", "mdi:calendar-check"),
    ("ki_vvb_oppvarming_startet", "KI VVB Denne Oppvarmingen Startet", "mdi:calendar-clock"),
    ("ki_vvb_boost_til", "KI VVB Boost Til", "mdi:rocket-launch"),
    ("ki_hjemkomst_planlagt", "KI Hjemkomst Planlagt", "mdi:home-clock"),
]

TEXTS = [
    ("ki_tariff_tabell", "KI Tarifftabell", "mdi:table"),
]
# Standardverdi for tarifftabellen: øvre grense kW → kr/mnd (inkl. avgifter). Snitt ≥ 20 = ukjent.
TARIFF_TABELL_STANDARD = "2:150,5:250,10:420,15:585,20:755"

# Sensorer motoren skriver. (nøkkel, navn, ikon, enhet, device_class, state_class)
SENSORS = [
    ("ki_energi_status", "KI Energistatus", "mdi:brain", None, None, None),
    ("ki_laster", "KI Laster", "mdi:format-list-bulleted", None, None, None),
    ("ki_bereder", "KI Varmtvann", "mdi:water-boiler", None, None, None),
    ("ki_hanklevarmer", "KI Håndklevarmer", "mdi:radiator", None, None, None),
    ("ki_gardiner", "KI Gardiner", "mdi:curtains", None, None, None),
    ("ki_beslutningslogg", "KI Beslutningslogg", "mdi:script-text", None, None, None),
    ("ki_tidskonstanter", "KI Tidskonstanter", "mdi:school", None, None, None),
    ("ki_klima_status", "KI Klima Status", "mdi:home-thermometer-outline", None, None, None),
    ("ki_prognose", "KI Effektprognose", "mdi:chart-timeline-variant", "kW", None, None),
    ("ki_besparelse", "KI Besparelse", "mdi:piggy-bank-outline", "kr", None, None),
    ("ki_overgang_klar", "KI Beredskap", "mdi:clipboard-check-outline", None, None, None),
    ("ki_styrt_effekt", "KI Styrt Effekt", "mdi:radiator", "W", "power", "measurement"),
    ("ki_uregulert_effekt", "KI Uregulert Effekt", "mdi:help-circle-outline", "W", "power", "measurement"),
    ("ki_hvitevarer_effekt", "KI Hvitevarer Effekt", "mdi:stove", "W", "power", "measurement"),
    ("ki_time_energi", "KI Energi Denne Timen", "mdi:counter", "kWh", "energy", "total"),
    ("ki_nettleie", "KI Nettleie", "mdi:transmission-tower", None, None, None),
    ("ki_sparing", "KI Sparing", "mdi:piggy-bank-outline", "kr", None, None),
    ("ki_prognoselaering", "KI Prognoselæring", "mdi:school-outline", None, None, None),
    ("ki_lys", "KI Lys", "mdi:lightbulb-group-outline", None, None, None),
    ("ki_estimert_timesforbruk", "KI Estimert Timesforbruk", "mdi:chart-line", "kWh", None, "measurement"),
    ("ki_vvb_legionella_status", "KI VVB Legionella Status", "mdi:water-boiler", None, None, None),
    ("ki_vvb_forklaring", "KI VVB Forklaring", "mdi:text-long", None, None, None),
    ("ki_vvb_dager_siden_siste_syklus", "KI VVB Dager Siden Siste Syklus", "mdi:calendar-clock", "d", None, None),
    ("ki_vvb_oppvarming_minutter", "KI VVB Oppvarming Minutter", "mdi:timer-outline", "min", None, None),
    ("ki_vvb_billige_timer", "KI VVB Billige Timer", "mdi:clock-check-outline", None, None, None),
]

# (nøkkel, navn, ikon, device_class)
BINARY_SENSORS = [
    ("ki_alle_borte", "KI Alle Borte", "mdi:home-export-outline", "presence"),
    ("ki_vvb_oppvarming_aktiv", "KI VVB Oppvarming Aktiv", "mdi:fire", "heat"),
    ("ki_vvb_mettet", "KI VVB Mettet", "mdi:water-check", None),
    ("ki_vvb_ingen_respons", "KI VVB Ingen Respons", "mdi:flash-alert", "problem"),
    ("ki_vvb_i_vindu", "KI VVB I Vindu", "mdi:clock-outline", None),
    ("ki_vvb_billig_time_na", "KI VVB Billig Time Nå", "mdi:cash-clock", None),
    ("ki_vvb_boost_aktiv", "KI VVB Boost Aktiv", "mdi:rocket-launch", None),
    ("ki_vvb_ferdig_i_vinduet", "KI VVB Ferdig I Vinduet", "mdi:check-circle-outline", None),
    ("ki_vvb_legionella_ok", "KI VVB Legionella OK", "mdi:shield-check", "safety"),
    ("ki_vvb_legionella_forfalt", "KI VVB Legionella Forfalt", "mdi:alert", "problem"),
    ("ki_vvb_bor_varme", "KI VVB Bør Varme", "mdi:water-boiler-auto", None),
]

# Varselhandlinger (mobile_app_notification_action)
AKSJON_HELG_JA = "KI_HELG_JA"
AKSJON_HELG_NEI = "KI_HELG_NEI"
AKSJON_HELG_NAA = "KI_HELG_NAA"
AKSJON_HJEM_JA = "KI_HJEM_JA"
AKSJON_HJEM_NEI = "KI_HJEM_NEI"
AKSJON_HJEM_SENERE = "KI_HJEM_SENERE"
AKSJON_HJEM_NAA = "KI_HJEM_NAA"
AKSJON_HJEM_FORLENG = "KI_HJEM_FORLENG"
AKSJON_HYTTE_DRAR = "KI_HYTTE_DRAR"
AKSJON_HYTTE_BLIR = "KI_HYTTE_BLIR"

# Eldre preset-nøkler
PRESETS["oslo"] = PRESETS["bolig"]
PRESETS["toten"] = PRESETS["hytte"]
