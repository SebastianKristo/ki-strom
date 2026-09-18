# KI Energi 2.21.0

## Billading: bilen får det varmen ikke bruker

Ny modul `lading.py`. Den holder hytta under kapasitetstrinnet ved å gi bilen bare det
som er til overs — den fortrenger aldri en ovn.

### Den bruker det som alt fantes

`engine.py` beregnet allerede `ledig` i hvert tikk: `tillatt_snitt` minus prognosen for
uregulert forbruk, berederens reservasjon, usikkerhetsmarginen og varmen. Tallen ble
publisert som `ledig_kw`, men ingenting styrte på den.

Ladingen er lagt inn **etter** `fordel()`, altså etter at varmen har tatt sitt. Det er
hele designet: en panelovn som ikke får strøm blir kald og må hentes igjen, mens bilen
bare mister tid. Derfor er bilen den siste som får, og den eneste lasten det er
gratis å utsette.

Bilens effekt er også lagt inn i `forventet` for timen, så nettleievurderingen og
prognoselæringen ser den.

### Fire knapper, ikke et settpunkt

Ladestrømmen settes med knapper for 5, 10, 16 og 18 A — omtrent 1,15 / 2,3 / 3,68 /
4,14 kW ved 230 V enfase. Modulen velger det **høyeste trinnet som holder seg under**
det ledige, og stopper ladingen når ikke engang 5 A får plass.

Knappene kan settes opp på to måter, og begge virker: som et oppslag i YAML, eller som
en rein liste fra oppsettskjemaet. For lista leses ampere ut av entitets-ID-en —
`tesla_ladestrom_16a_button` gir 16. Finner den ikke et tall, hoppes knappen over med en
advarsel i loggen, for en knapp på feil trinn er verre enn en manglende knapp.

### Målingen kontrollerer, den styrer ikke

Bilens effektsensor oppdaterer seg ved hver strømendring. Den brukes til å sammenligne
det vi ba om med det bilen faktisk tar: ligger den mer enn 0,5 kW under trinnet — fordi
den er nesten full, eller kald — **frigjøres differansen til de andre lastene** i stedet
for å stå reservert til noe som ikke bruker den.

Under en halv kilowatt regnes som måleusikkerhet og røres ikke.

### To sperrer

* `ki_lading_min_mellom_min` (standard 5) — minste tid mellom endringer, fordi hver
  endring gir bilen et lite avbrudd.
* `ki_lading_dodband_kw` (standard 0,6) — nytt trinn velges bare når det gir noe å
  hente. Uten dette ville den vekslet mellom 16 og 18 A hver gang måleren spratt.

Begge er nødvendige **fordi** sensoren er rask ved endring: uten dem ville hver måling
utløst en ny endring, som utløste en ny måling.

### Nye entiteter

* `switch.ki_lading_automatikk` — av lar deg styre ladingen selv
* `number.ki_lading_min_mellom_min`, `number.ki_lading_dodband_kw`
* `sensor.ki_lading_status` — handling, valgt trinn, målt effekt, ledig effekt og en
  forklaring i klartekst

### Oppsett

Tre nye felt under Utstyr: laderens bryter, bilens ladeeffekt, og knappene for
ladestrøm. Måleren for hele hytta er den du alt har valgt under Måling.

### Tester

25 nye tester i `tests/test_lading.py`: trinnvalg på grensene (2,29 → 5 A, 2,30 → 10 A),
gulv, knappetolkning fra liste med ukjente og navnløse knapper, start fra stillstand,
oppjustering, stopp når plassen forsvinner, begge sperrene både som holder og slipper,
frigjøring av ubrukt effekt, måleusikkerhet som ikke frigjøres, automatikk av, og lader
som ikke svarer.
