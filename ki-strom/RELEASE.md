# KI Energi 2.22.0

Samme innhold som 2.21.1, med nytt versjonsnummer. 2.21.1 ble aldri pushet — pakka ble
ikke lastet ned, og skriptet pushet det som alt lå i repoet. Et ubrukt nummer gjør at
verken en gammel zip eller en gammel tagg kan forveksles med denne.

Repoet står på 2.21.0 nå, så denne pakka inneholder to ting: ladingen fra 2.21.0 er
uendret, og oppsettsfeilen fra 2.21.1 er rettet.



## Ladeeffekten kunne ikke velges i oppsettet (var 2.21.1)

Feltet for bilens ladeeffekt filtrerte på `device_class: power`. Sensoren din er en
«Homey Link Number» — bare et tall, uten device class — og ble derfor filtrert bort fra
lista. Filteret skjulte nettopp den sensoren man trenger.

Filtreringen er fjernet. Feltet viser alle sensorer, og modulen leser enheten fra
attributtet i stedet.

### Enheten leses nå robust

`W` og `kW` håndteres som før, i alle skrivemåter. Nytt er sensorer **uten enhet i det
hele tatt**, som er vanlig for tall fra broer: da avgjør størrelsen. En bil lader aldri
på 2300 kW, men godt på 2300 W, så alt over 100 leses som watt.

Standardverdien peker nå på `sensor.tesla_model_y_batteri_charge_power`.

Seks nye tester for enhetslesningen, alle seks skrivemåter og tre tilfeller uten enhet.
31 tester i alt.

---

# KI Energi 2.21.0

## Billading: bilen får det varmen ikke bruker

Ny modul `lading.py`. Den holder hytta under kapasitetstrinnet ved å gi bilen bare det
som er til overs — den fortrenger aldri en ovn.

`engine.py` beregnet allerede `ledig` i hvert tikk: `tillatt_snitt` minus prognosen for
uregulert forbruk, berederens reservasjon, usikkerhetsmarginen og varmen. Tallet ble
publisert som `ledig_kw`, men ingenting styrte på den. Ladingen er lagt inn **etter**
`fordel()`, altså etter at varmen har tatt sitt: en panelovn som ikke får strøm blir kald
og må hentes igjen, mens bilen bare mister tid.

Bilens effekt er lagt inn i `forventet` for timen, så nettleievurderingen og
prognoselæringen ser den.

### Fire knapper, ikke et settpunkt

5, 10, 16 og 18 A — omtrent 1,15 / 2,3 / 3,68 / 4,14 kW ved 230 V enfase. Modulen velger
det høyeste trinnet som holder seg under det ledige, og stopper når ikke engang 5 A får
plass. Knappene kan settes opp som oppslag i YAML eller som liste fra skjemaet; for lista
leses ampere ut av entitets-ID-en.

### Målingen kontrollerer, den styrer ikke

Ligger bilen mer enn 0,5 kW under trinnet vi satte, frigjøres differansen til de andre
lastene. Under en halv kilowatt regnes som måleusikkerhet.

### To sperrer

`ki_lading_min_mellom_min` (5) og `ki_lading_dodband_kw` (0,6). Begge er nødvendige fordi
sensoren oppdaterer ved hver endring: uten dem ville hver måling utløst en ny endring.

### Nye entiteter

`switch.ki_lading_automatikk`, `number.ki_lading_min_mellom_min`,
`number.ki_lading_dodband_kw`, `sensor.ki_lading_status`.
