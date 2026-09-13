# KI Energi 2.17.0

## Flere varmekilder i samme rom

Sone-skjemaet har bare én `type`, og det er med vilje: typen styrer hvordan motoren
behandler sonen. Gulvvarme startes tidlig fordi den er treg, varmepumpe senkes sist fordi
den er billigst per kWh. En sone kan derfor ikke være både panelovn og oljefyr.

Riktig modell er **én sone per varmekilde, med samme `rom`** — slik kjøkkenet allerede er
satt opp med panelovn og gulvvarme. To ting manglet for at det skulle være praktisk:

**Ny type: «Vannbåren — oljefyr, radiatorer».** En oljefyr er ikke en panelovn. Den nye
typen behandles som treg, på linje med gulvvarme: den startes tidlig og tåler dypere
senking om gangen. Før måtte du velge mellom å kalle den panelovn (starter for sent) eller
gulvvarme (riktig oppførsel, feil navn).

**«Legg til en varmekilde til i dette rommet»** nederst i sone-skjemaet. Den tar deg rett
til en ny sone med rommet fylt inn, så du slipper å huske å skrive det likt.

Stua di står nå som én sone med to klimaenheter og type «panelovn». Del den i to — «Stue
panelovn» og «Stue oljefyr» — så får oljefyren riktig oppstartstid, og motoren kan senke
dem uavhengig av hverandre etter hvor mye effekt hver av dem faktisk trekker.

Begge sonene deler `number.ki_rom_stue_temp` fra 2.16, så det er fortsatt ett tall å sette
i dashbordet.

## Motoren

`er_tregt()` erstatter de tre stedene som sammenlignet direkte mot `"gulv"`, så nye trege
typer ikke må legges inn tre steder. Oppførselen for eksisterende soner er uendret.
