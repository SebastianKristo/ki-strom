# KI Energi 2.15.0

## «Denne timen» hoppet opp og ned

Sensoren `sensor.ki_time_energi` er summen av to ting: energiregisterets måling fram til
siste prøve, pluss et tillegg for tiden etter den. Tillegget ble regnet ut som
**øyeblikkseffekten akkurat nå × hele tiden siden registeret sist oppdaterte seg**.

Oppdaterer registeret seg hvert kvarter, ble ett sekunds topp på 3,6 kW til 0,9 kWh
«forbrukt» de siste femten minuttene. Når registeret så leverte den ekte verdien, falt
tallet tilbake. Derav 1,5 kWh kl. 08:30 og 0,9 kWh kl. 08:40, og toppene på over 6 kWh i
grafen — godt over den absolutte timegrensen på 4,9 kWh, uten at huset var i nærheten.

Hullet **måles** nå i stedet: effekt × tid summeres ved hver endring på effektsensoren og
ved hvert tick (venstre Riemann), og integralet starter på nytt hver gang registeret
leverer en ny prøve. Samme eksempel gir nå 0,075 kWh i stedet for 0,9.

I tillegg kan tallet bare vokse innenfor samme klokketime. Tar registeret igjen et anslag
som lå for høyt, blir differansen stående til neste time i stedet for å vises som at
forbruket gikk ned. Sperren nullstilles ved timeskiftet.

Dette påvirker også `sensor.ki_estimert_timesforbruk` og budsjettet, som begge bygger på
det samme tallet. Senkinger utløst av en falsk topp midt i timen skal dermed forsvinne.

## Berederen (fra 2.14.2)

Vernet mot at en annen styring slår av berederen utløste aldri. Betingelsen krevde at
bryteren sto `on` ved forrige tick og `off` ved denne, men `_siste_bryter` settes før KI
slår på. Skjer avslaget mellom to ticks, leser KI alltid `off` ved tickstart. Vernet går
nå ut fra KI sitt eget påslag, og logg og varsel oppgir hvor mange sekunder reléet sto på.

## Lysregler (fra 2.14.1)

`light` og `presence` hadde `default=""`, som `cv.entity_id_or_uuid` avviser — skjemaet
feilet før steget kjørte. `_glemt()` kalte alltid `light.turn_off`, så regler på
`switch.`-entiteter slo aldri av. Nattdemping avvises nå for entiteter som ikke kan dimmes.

## Tester

`tests/test_timesforbruk.py`: en kortvarig topp blir ikke ganget ut over hele hullet,
tallet faller ikke midt i timen, og sperren slipper ved timeskiftet. 40 tester grønt.
