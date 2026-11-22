# KI Energi 2.33.2

Ferdig oppsett for huset, bortetemperatur som velges av algoritmen, forvarming søndag og en
rekke mindre rettelser. Ingen oppsett må endres; de nye funksjonene er av til de slås på eller
et oppsett som bruker dem tas i bruk.

## Nytt

- **«Bruk ferdig oppsett»** under *Konfigurer*: legger et preset inn på en installasjon som alt
  kjører — måling, utstyr, soner, personer og (valgfritt) temperaturer og tider. Det KI har lært
  (oppvarmingskurver, lastprofil, prognoser) beholdes. Soner som ikke finnes i oppsettet, fjernes.
- **Preset «Kristo (Homey-oppsettet)»**: stue og kjøkken med to varmekilder hver, trappegang,
  Cybeles og Sebastians rom, bad og do; bereder og håndklevarmer; Elvia, Norgespris og Nord Pool;
  personer via Homey-posisjon. Fellesrom 22/19 °C fra 06 til 23, bortehelg med spørsmål bare fredag
  og hjemkomst søndag kl. 13.
- **Automatisk bortetemperatur** (`switch.ki_borte_auto_temp`, `number.ki_borte_min_temp`): for
  hvert rom velges den laveste temperaturen rommet rekker å varme seg opp fra før dere kommer, ut
  fra lært oppvarmingsevne, varmetap og utetemperaturen. Kaldere vær gir høyere bortetemperatur.
  Aldri under bunnen (standard 12 °C). Til rommet er lært, gjelder de faste bortetemperaturene.
- **Forvarming søndag** (`switch.ki_helg_forvarm_sondag`): i helgemodus regnes hjemkomsten som
  planlagt til `ki_hjemkomst_tid`, så hvert rom starter forvarmingen når modellen sier det må — ikke
  først når søndagsspørsmålet er besvart. Etter tiden holdes dagtemperatur til noen kommer.
  «Forleng helgen» stopper det for dagen.

## Rettet

- Elbilladingen trappes ned med en gang når det blir mindre ledig effekt (dødbånd og minsteavstand
  gjelder bare oppover), og en posisjonssensor uten stedsnavn sperrer ikke lenger ladingen.
- Berederen velger billige timer etter snittet av kvartersprisene, ikke bare første kvarter.
- Glemt lys slås ikke av når nærværssensoren har falt ut.
- Prognoselæringen og varselet om passert effektgrense kjører nå begge, uansett om timeslutt eller
  ticket lukker timen.
- Varmetap og oppvarmingsrate læres over vinduer på minst 30 min, så termostater som melder i halve
  grader ikke gir for høye verdier (forvarmingen startet for sent).
- Tjenestekall venter på et tick som pågår, og statistikken telles ikke dobbelt.
- Registerprøver fra HAN/Pulse tynnes til én i minuttet midt i timen, og store lister skrives ikke
  til recorder hvert minutt.

### Kontrollert

Python 3.13, Home Assistant 2026.2.3, pytest-homeassistant-custom-component 0.13.316: hele
testsamlingen, 223 tester, 23 av dem nye (`tests/test_mindre_funn.py`, `tests/test_preset_kristo.py`).
`test_smoke.py::test_lysregler` avhenger av klokkeslettet (setter tiden til kl. 14 mens sensorens
`last_changed` er ekte tid) og feiler når den kjøres etter ca. kl. 14.

Ikke verifisert mot ditt utstyr: at Homey-bryterne for posisjon står på når personen er hjemme, og
hvor raskt hvert rom faktisk varmes opp — det lærer KI de første ukene.
