# KI Energi 2.34.0

Kontrollversjon for Homey. Eksisterende oppsett påvirkes ikke.

## Nytt

- **Valg i starten av oppsettet:** «I Home Assistant» (som før — motoren regner og styrer her) eller
  «På Homey» (kontrollversjon).
- **Kontrollversjonen** kobler seg til KI Energi-appen på Homey over hjemmenettet og gjør den om til
  entiteter i Home Assistant. All beregning og styring skjer på Homey; Home Assistant viser og betjener.
  - **Sensorer:** tariff, kapasitetstrinn, priser, forbruk og kostnad, motorens status og forklaring,
    timens grense, modus, hjemkomst, bereder og elbillading.
  - **Rom som klimaenheter:** temperatur nå og settpunkt. Setter du temperaturen, overstyres rommet i to timer.
  - **Brytere:** energimotor, skyggemodus, varmeplan, bortemodus, Norgespris, berederstyring og elbillading.
  - **Tall og klokkeslett:** dag- og nattemperatur per rom, timegrenser, bortetemperatur, dag-/nattstart,
    fast hjemkomst og «Vi kommer hjem kl.».
  - **Knapper:** varm opp berederen, full oppvarming, «vi blir borte lenger» og fjern overstyringer.
  - Én binær sensor per person (hjemme/borte).
- Svarer ikke Homey, blir entitetene utilgjengelige og kommer tilbake av seg selv.

## Slik setter du den opp

1. Installer KI Energi-appen på Homey (mappen `homey/` i dette repoet) og sett den opp der.
2. Lag en API-nøkkel i Homey: *Innstillinger → API-nøkler*.
3. I Home Assistant: legg til KI Energi, velg «På Homey», og oppgi Homeys IP-adresse og nøkkelen.

Bare ett oppsett av KI Energi kan finnes om gangen. For å bytte fra lokal versjon til kontrollversjonen
må den lokale fjernes først — læringen der blir da borte.

### Kontrollert

Python 3.13, Home Assistant 2026.2.3, pytest-homeassistant-custom-component 0.13.316: 232 tester, ni av dem
nye (`tests/test_kontrollversjon.py`). De prøves mot svar skrevet av Homey-appens egen test, så formatet
er det appen faktisk sender. Homey-appen: 89 tester.

Ikke verifisert mot en ekte Homey: at Homeys API-nøkkel godtas som Bearer-token mot appens lokale API,
og adressen `http://<homey>/api/app/no.kristo.kienergi/…`.
