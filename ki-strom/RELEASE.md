# KI Energi 2.19.0

## Fraværstemperaturen på hytta kunne ikke settes

Hytteoppsettet setter frostsikringen til **8 °C** for panelovner og **10 °C** for
gulvvarme. Men tallentitetene hadde minimum **10** og **12**: en verdi under minimum kan
ikke settes, så hyttas egen standard ble avvist i det den skulle brukes.

Grensene går nå ned til 5 °C for alle tre. Lavere enn det er ikke frostsikring — det er å
la røret fryse.

En kontroll av alle 60 tallentitetene mot alle forhåndsvalgte verdier i oppsettene er lagt
inn som test, så den samme uoverensstemmelsen ikke kan snike seg inn igjen.

## Innstillingene het «Helgemodus»

Det er grunnen til at de ikke var å finne. På en hytte er det **ukedagene** den står tom,
og leter man etter en fraværstemperatur, ser man ikke etter «helg».

De heter nå:

* «KI Temp Borte Panelovner», «KI Temp Borte Gulvvarme», «KI Temp Borte Bad»
* «KI Borte Auto-aktivering Ved Fravær», «KI Borte Auto Etter Timer Borte»

Entitets-ID-ene er uendret — `ki_temp_helg` og de andre — så ingenting i dashbordene eller
automasjonene dine brekker. Det er bare navnet som er rettet.

## Om ankomst uten å svare på varselet

Kommer noen til hytta mens bortemodus står på, **avsluttes den med én gang**. Ingen varsel
må godtas: `modes.py` sjekker tilstedeværelse direkte, slår av bortemodus, og regner
varmeprogrammet om på nytt i samme omgang.

Dette er dekket av en test nå, siden det er en egenskap man ikke vil miste ved en
refaktorering.

Forutsetningen er at tilstedeværelse faktisk registreres. Hytta har posisjonsbrytere, og
er ingen av dem på når du kommer, vet integrasjonen ikke at du er der — da står den på 8 °C
til noe melder tilstedeværelse.

## Ett kjent problem, ikke løst her

`tests/test_smoke.py::test_lysregler` feiler: lyset på soverommet slås ikke av etter
fravær, mens vaskerommet gjør det. Jeg har ikke rørt lysreglene i denne versjonen, og
klarte ikke å tidfeste når det oppsto — arbeidskopien her har ingen historikk å
sammenligne med. Det er verdt en egen runde.
