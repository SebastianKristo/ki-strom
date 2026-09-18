# KI Energi 2.24.0

Nytt versjonsnummer på innholdet fra 2.23.1, så HACS ser en ren ny utgivelse. Ingen
kodeendringer siden 2.23.1 — alt under er samlet fra utgivelsene som aldri nådde fram
med riktig innhold.

## Billading: bilen får det varmen ikke bruker

Ny modul `lading.py`. Den holder hytta under kapasitetstrinnet ved å gi bilen bare det som
er til overs, og fortrenger aldri en ovn.

Motoren beregnet allerede `ledig` i hvert tikk — `tillatt_snitt` minus prognosen for
uregulert forbruk, berederens reservasjon, usikkerhetsmarginen og varmen — men ingenting
styrte på den. Ladingen er lagt inn **etter** `fordel()`: en panelovn som ikke får strøm
blir kald og må hentes igjen, mens bilen bare mister tid. Bilens effekt går inn i
`forventet` for timen, så nettleievurderingen og prognoselæringen ser den.

**Fire knapper, ikke et settpunkt.** 5, 10, 16 og 18 A — omtrent 1,15 / 2,3 / 3,68 /
4,14 kW ved 230 V enfase. Modulen velger det høyeste trinnet som holder seg under det
ledige, og stopper når ikke engang 5 A får plass. Knappene settes opp som liste; ampere
leses fra entitets-ID-en, og en knapp uten tall i navnet hoppes over med en advarsel.

**Målingen kontrollerer, den styrer ikke.** Ligger bilen mer enn 0,5 kW under trinnet vi
satte — nesten full, eller kald — frigjøres differansen til de andre lastene. Under en
halv kilowatt regnes som måleusikkerhet.

**To sperrer.** `ki_lading_min_mellom_min` (5) og `ki_lading_dodband_kw` (0,6). Begge er
nødvendige fordi bilens effektsensor oppdaterer seg ved hver strømendring: uten dem ville
hver måling utløst en ny endring, som utløste en ny måling.

## Håndklevarmer etter dusj

Har du en fuktsensor på badet, kan håndklevarmeren slås på når fukten har vært over en
grense **sammenhengende**. Standard 70 %, tre minutter, to timer.

Et øyeblikksmål ville slått på varmeren hver gang noen vasker hendene. Det som skiller en
dusj er at fukten blir stående — og faller den under grensen før tiden er ute, nullstilles
klokka.

Når vinduet først er åpnet, står det. Fukten i rommet legger seg lenge før håndklærne er
tørre.

Fuktvinduet regnes som et vindu på lik linje med dusjvinduene. Uten det ville
sikkerhetsavstengingen på 240 minutter og kanten på et tidsvindu slått av varmeren midt i
vinduet. Effektvakten gjelder derfor også her, et ferskt fuktvindu overstyrer «slått av
manuelt», og vinduet slås av eksplisitt når tiden er ute.

## Oppsettsfeil rettet

Feltet for bilens ladeeffekt filtrerte på `device_class: power`. En «Homey Link Number» er
bare et tall uten device class og ble filtrert bort — filteret skjulte nettopp sensoren man
trenger. Filtreringen er fjernet, og enheten leses fra attributtet: `W`, `kW`, eller ingen
enhet, der størrelsen avgjør.

Fuktsensorfeltet har samme behandling, av samme grunn.

## Flagg for kortene

`sensor.ki_energi_status` publiserer nå `lading` og `bad_fukt` blant funksjonsflaggene.
Kortene bruker `lading` til å skjule Elbillader-fanen når laderen ikke er koblet til. Det
betyr noe annet enn `elbil`: `elbil` sier at huset har elbil, `lading` at laderen er satt
opp i integrasjonen.

## Nye entiteter

* `switch.ki_lading_automatikk`, `number.ki_lading_min_mellom_min`,
  `number.ki_lading_dodband_kw`, `sensor.ki_lading_status`
* `switch.ki_hanklevarmer_fukt` (av som standard),
  `number.ki_hanklevarmer_fukt_grense`, `number.ki_hanklevarmer_fukt_minutter`,
  `number.ki_hanklevarmer_fukt_timer`

`sensor.ki_hanklevarmer` har fått `fukt_styring`, `fukt_na`, `fukt_grense`, `i_fuktvindu`
og `fukt_til`.

## Oppsett

Fire nye felt under Utstyr: laderens bryter, bilens ladeeffekt, knappene for ladestrøm, og
fuktsensor for badet.

**Krever omstart**, ikke reload — nye entiteter opprettes bare ved full oppstart.

## Tester

51 i alt: 31 for ladingen og 20 for fuktstyringen.
