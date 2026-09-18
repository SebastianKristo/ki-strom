# KI Energi 2.23.1

## Flagg for om laderen er satt opp

`sensor.ki_energi_status` publiserer nå `lading` og `bad_fukt` blant funksjonsflaggene,
ved siden av `gardiner`, `hanklevarmer` og `elbil`.

Kortene bruker `lading` til å skjule Elbillader-fanen når laderen ikke er koblet til. Det
betyr noe annet enn `elbil`, som fantes fra før: `elbil` sier at huset har elbil,
`lading` at laderen faktisk er satt opp i integrasjonen.

`bad_fukt` følger samme mønster, for fuktstyringen av håndklevarmeren.

# KI Energi 2.23.0

## Håndklevarmer etter dusj

Ny valgfri styring: har du en fuktsensor på badet, kan håndklevarmeren slås på når fukten
har vært over en grense sammenhengende, og stå på en stund etterpå.

Standard er 70 %, tre minutter, to timer. Alt tre kan endres.

### Hvorfor «sammenhengende» er poenget

Et enkelt øyeblikksmål over grensen ville slått på varmeren hver gang noen vasker hendene
eller koker vann. Det som skiller en dusj fra alt annet er at fukten **blir stående**.
Derfor må grensen holdes i tre minutter — og faller fukten under før tiden er ute,
nullstilles klokka. Halvveis oppfylt to ganger er ikke det samme som oppfylt én gang.

### Når vinduet først er åpnet, står det

Fukten i rommet legger seg lenge før håndklærne er tørre. Vinduet varer derfor de to
timene uansett hva fukten gjør etterpå, og statussensoren viser hvor mange minutter som
er igjen.

### Det samarbeider med det som alt var der

Fuktvinduet regnes som et vindu på lik linje med dusjvinduene. Det er ikke bare enklere,
det er nødvendig: uten det ville sikkerhetsavstengingen på 240 minutter og kanten på et
tidsvindu slått av varmeren midt i fuktvinduet.

Tre ting følger av det, og alle er med vilje:

* **Effektvakten gjelder også her.** Er huset i rød sone når vinduet åpner, utsettes
  starten, som i dusjvinduene.
* **Et ferskt fuktvindu overstyrer «slått av manuelt».** Slo du den av i går kveld,
  gjaldt det den dusjen, ikke denne.
* **Fuktvinduet slås av eksplisitt** når tiden er ute. Tidsvinduene har en kant i klokka
  å reagere på; fuktvinduet har ikke det.

### Nye entiteter

* `switch.ki_hanklevarmer_fukt` — av som standard, så ingenting endrer seg før du slår
  den på
* `number.ki_hanklevarmer_fukt_grense` (40–95 %)
* `number.ki_hanklevarmer_fukt_minutter` (1–30 min)
* `number.ki_hanklevarmer_fukt_timer` (0,5–8 t)

`sensor.ki_hanklevarmer` har fått `fukt_styring`, `fukt_na`, `fukt_grense`,
`i_fuktvindu` og `fukt_til`, og forklaringen sier «Tørker håndklær etter dusj — 87 min
igjen» når vinduet er åpent.

### Oppsett

Nytt felt under Utstyr: fuktsensor for badet. Uten device_class-filter, av samme grunn
som ladeeffekten — sensorer fra broer har ofte ingen device class, og filteret ville
skjult dem.

### Tester

20 nye i `tests/test_hanklevarmer_fukt.py`: uten sensor, avslått, sensor uten tall, under
grensen, første måling, for kort tid, grensen holdt lenge nok, fall som nullstiller
klokka, vinduet som står når fukten faller, vinduet som lukkes, ny dusj som åpner nytt
vindu, fire grenseverdier og fem varigheter. 51 tester i alt med ladingen.

---

# KI Energi 2.22.0

Ladingen fra 2.21.0 uendret, og oppsettsfeilen fra 2.21.1 rettet: feltet for bilens
ladeeffekt filtrerte på `device_class: power`, og en «Homey Link Number» uten device class
ble filtrert bort. Filtreringen er fjernet, og enheten leses fra attributtet — `W`, `kW`,
eller ingen enhet, der størrelsen avgjør.

# KI Energi 2.21.0

Ny modul `lading.py`: bilen får bare det varmen ikke bruker, og fortrenger aldri en ovn.
Fire trinn (5/10/16/18 A), målingen kontrollerer i stedet for å styre, og to sperrer mot
vingling. Nye entiteter `switch.ki_lading_automatikk`,
`number.ki_lading_min_mellom_min`, `number.ki_lading_dodband_kw` og
`sensor.ki_lading_status`.
