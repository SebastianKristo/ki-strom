# KI Energi 2.28.0

## Baderomsvifte på samme fuktmåling

Vifta starter når fukten har ligget over grensen sammenhengende, og slår seg av etter et
antall minutter. Standard 20.

### Egen varighet, samme utløsning

Vifta skal lufte ut, håndklevarmeren skal tørke håndklær. Tjue minutter på full vifte er
noe annet enn to timer med lunken varme, så varigheten er egen og regnes i minutter.

Men de utløses av den **samme** målingen, og det tvang fram en endring: utløsningen er
skilt ut i `_fukt_utlost()`. Lå klokka inne i hver av dem, ville den som kjørte først
nullstilt den for den andre.

Håndklevarmeren nullstilte faktisk klokka etter at den hadde åpnet sitt vindu. Med begge
slått på ville vifta aldri ha startet. Klokka nullstilles nå først når fukten faller under
grensen, og gjenåpning hindres av at vinduet alt står åpent.

### Vi slår bare av det vi slo på

Har noen startet vifta manuelt, står den. Vi husker om starten var vår, og rører den
ellers ikke.

### Nye entiteter

* `switch.ki_bad_vifte_fukt` — av som standard
* `number.ki_bad_vifte_minutter` (5 til 120 min, standard 20)

Nytt felt under Utstyr: baderomsvifte. Tar `switch`, `fan` eller `input_boolean`.

`sensor.ki_hanklevarmer` har fått `har_badvifte`, `vifte_styring`, `vifte_minutter` og
`vifte_til`.

### Tester

13 nye i `tests/test_bad_vifte.py`: utløsning etter sammenhengende tid, nullstilling ved
fall, at håndklevarmeren ikke stjeler utløsningen, start og stopp, egen varighet mot
varmeren, vifte som sto på fra før, avslått, uten vifte, ny dusj, og fire varigheter.
78 tester i alt.

---

# KI Energi 2.27.0

## Nytt attributt: har_fuktsensor

`sensor.ki_hanklevarmer` hadde bare `fukt_styring`, som er sann når styringen er slått
PÅ. Et kort kunne derfor ikke skille «ingen fuktsensor er valgt» fra «sensor valgt, men
styringen er av» — og viste innstillingene i begge tilfellene.

`har_fuktsensor` sier om en sensor er valgt i det hele tatt. De to sammen gir kortene det
de trenger.

---

# KI Energi 2.26.0

## «Hjemkomst 13:00» på en lørdag

`hjemkomst_tid` ble publisert på `sensor.ki_tilstedevaerelse` **alltid**, også når ingen
hjemkomst var planlagt. Tallet var bare standardverdien i innstillingen, men kortene leste
det som «dere kommer hjem klokka 13» — også en lørdag der ingen hadde bedt om noe.

Attributtet settes nå bare når `hjemkomst_aktiv` er sann. Innstillingen for seg ligger i
`hjemkomst_tid_innstilling`, så kortene kan vise den under Bortemodus uten å forveksle den
med en planlagt hjemkomst.

---

# KI Energi 2.25.0

## Lading bare hjemme, og bare til batteriet er fullt

### Stedssperre

Bilen lades bare når stedssensoren sier at den står der den skal. Står den andre steder,
**rører ikke integrasjonen laderen i det hele tatt** — verken for å starte eller stoppe.
Laderen der er ikke vår.

Tre ting settes opp under Utstyr: stedssensor, stedets navn, og batterinivå. Sammenligningen
tåler store bokstaver og mellomrom i kantene, siden slike navn kommer fra en bil-app og
ikke er skrevet av oss.

Er stedet ikke satt opp, er det ingen stedssperre og alt virker som før. Men svarer
sensoren ikke — «unknown», «unavailable» eller tom — rører vi heller ingenting. Vi vet da
ikke hvor bilen er, og å gjette er verre enn å la være.

### Hysterese på batteriet

Stopper ved 80 %, starter igjen først under 70 %. Begge grensene kan endres.

**Avstanden mellom dem er poenget.** Med bare ett tall ville den vippet av og på rundt
det, og hver vipp er et avbrudd for bilen.

Det gir også oppførselen du beskrev når bilen har vært borte, uten at vi trenger å spore
det: kommer den hjem med 75 % etter å ha blitt full, står den — den er full nok. Kommer
den hjem med 60 %, lader den. Nivået forteller alt vi må vite, og en «har vært borte»-
tilstand ville vært en ekstra ting som kan bli feil.

**Et fullt batteri slår av uansett hvor mye ledig effekt det er.** Effektbudsjettet kan
bare gjøre ladingen mindre, aldri mer nødvendig.

### Statussensoren

`sensor.ki_lading_status` har fått `batteri_pst`, `stopp_ved_pst`, `start_under_pst`,
`fulladet`, `hjemme` og `sted_navn`. Ny tilstand `borte` når bilen ikke står hjemme.

### Nye innstillinger

* `number.ki_lading_stopp_ved` (50–100 %, standard 80)
* `number.ki_lading_start_under` (10–95 %, standard 70)

Settes start høyere enn stopp, flyttes start automatisk ned — ellers ville bilen aldri
ladet.

### Tester

14 nye: uten sted, bilen borte, bilen hjemme, sted uten svar, navn med store bokstaver og
mellomrom, stopp ved 80, lading under 70, hjem med 75 som ikke starter, fall under 70 som
starter igjen, uten batterinivå, ugyldige grenser, og fullt batteri med mye ledig effekt.
45 tester for ladingen, 65 i alt.

---

# KI Energi 2.24.1

## Ladingen så konfigurert ut overalt

`DEFAULT_CONFIG` inneholdt ekte entitets-ID-er for laderen — Tesla-bryteren, ladeeffekten
og de fire knappene. Dermed svarte `konfigurert()` ja på **hver eneste installasjon**,
også der laderen aldri var valgt.

To ting fulgte av det. Elbillader-fanen dukket opp i klimakortet hjemme, der det ikke
finnes noen lader. Og verre: modulen ville forsøkt å styre entiteter som ikke finnes.

Standardverdiene er nå tomme, som de er for håndklevarmeren og gardinene. Laderen velges
under Utstyr, og flagget `lading` blir sant først da.

To nye tester låser det: standardkonfigurasjonen skal være tom, og uten bryter er
ladingen av uansett hva annet som er satt. 53 tester i alt.

---

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
