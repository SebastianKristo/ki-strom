# KI Energi 2.33.2

Mindre feilrettinger og ytelse. Ingen oppsett må endres, og ingen nye entiteter.

## Lading

- **Ladingen trappet ikke ned i tide.** Dødbånd og minsteavstand gjaldt begge veier, så 18 A kunne bli
  stående mens bare 16 A var ledig, og timen gikk over budsjettet. Nå gjelder de bare oppover, og
  ladingen trapper ned med en gang.
- **Bilen ble aldri ladet med posisjonssensor uten stedsnavn.** Det ble lest som «vet ikke hvor bilen
  står». Nå gir en sensor uten stedsnavn ingen stedssperre.

## Varmtvannsbereder

- **Feil billige timer med 15-minutterspriser.** Når Nord Pool leverte kvarterspriser, ble bare første
  kvarter i timen brukt. Nå velges timene på snittet av de fire kvarterene.

## Lys og nærvær

- **Glemt lys ble slått av når nærværssensoren var `unavailable`/`unknown`.** Ukjent nærvær regnes
  ikke lenger som tomt rom.

## Timeslutt, læring og prognose

- **Prognoselæringen eller grensevarselet kunne forsvinne.** Timeslutt og tick lukket timen hver for
  seg, og bare den som kom først fikk radene. Hvilken det var lå fast fra oppstart. Nå deler de én
  avslutning.
- **Forvarmingen startet for sent med termostater i 0,5 °C-steg.** Varmetap og oppvarmingsrate læres nå
  over vinduer på minst 30 minutter med samme tilstand, og intervaller uten temperaturendring telles med
  for tapet. Før ga slike termostater alltid 6 °C/t.
- **Tjenestene deler tick-låsen**, og statistikken bruker faktisk tid siden forrige tick i stedet for et
  fast minutt.

## Ytelse

- **Mindre skriving til `.storage`.** Registerprøver tynnes til én i minuttet midt i timen, mens alle
  prøver nær timegrensen beholdes. Med HAN eller Pulse skrives noen hundre punkter i stedet for 5–7 000.
- **Store lister holdes utenfor recorder**: laster, tankegang, logglinjer, døgnpriser, lysregler,
  entiteter og soner. Databasen vokser mindre.

### Kontrollert

Python 3.13.16, Home Assistant 2026.2.3 og pytest-homeassistant-custom-component 0.13.316:
**211 tester bestått**, hele samlingen inkludert `test_smoke`, `test_overhaul`, `test_hytte_og_hus`,
`test_rom_temp` og `test_varmekilder`. 11 av dem er nye (`tests/test_mindre_funn.py`), og 10 av disse
feilet på 2.33.1.
