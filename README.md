<p align="center"><img src="brand/logo.png" alt="KI Energi" width="520"></p>

# KI Energi

**Selvlærende energi- og klimastyring for Home Assistant — laget for norske rekkehus med Elvia-nettleie.**

[![Legg til i HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=SebastianKristo&repository=ki-strom&category=integration)
[![Legg til integrasjon](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=ki_energi)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Versjon](https://img.shields.io/github/v/release/SebastianKristo/ki-strom?label=versjon)](https://github.com/SebastianKristo/ki-strom/releases)
![Home Assistant 2024.12+](https://img.shields.io/badge/Home%20Assistant-2024.12%2B-blue)

KI Energi holder timesforbruket under det Elvia-trinnet du har valgt, styrer panelovner og
gulvvarme etter når rommene faktisk brukes, varmer opp huset før dere kommer hjem, passer på
at varmtvannsberederen tar legionellasyklusen sin — og **forklarer alt den gjør på norsk**,
i klartekst, i beslutningsloggen.

> Kort fortalt: én integrasjon, null YAML, null pyscript. Alt settes opp i Innstillinger →
> Enheter og tjenester, med entitetsvelgere og husets data.

### Laget for Norge

KI Energi er skrevet for det norske nettleiesystemet: kapasitetsledd etter snittet av de tre
høyeste timene i måneden, energiledd dag/natt, og Norgespris. Tekster, varsler og logg er på
norsk.

Den er **ikke avhengig** av andre integrasjoner, men vi **anbefaler
[Strømkalkulator](https://github.com/fredrik-lindseth/Stromkalkulator)** ved siden av. Den
regner ut den faktiske strømprisen din (spotpris + nettleie + avgifter, eller Norgespris),
kjenner satsene til 74 nettselskap, og verifiseres mot ekte fakturaer. Sensorene derfra passer
rett inn i KI Energi:

| Strømkalkulator-sensor | Brukes i KI Energi som |
|---|---|
| Energiledd dag / natt | *Nettleie → Energiledd dag/natt* |
| Kapasitetstrinn | *Måling → Kapasitetstrinn* |
| Norgespris aktiv / prisforskjell | *Måling → Norgespris aktiv* |
| Totalpris inkl. avgifter | *Nettleie → Strømpris* (til besparelsesestimatet) |

Har du **Norgespris**, trenger du ingen spotprissensor: energiprisen er lik hele døgnet, så
berederen legges i vinduet med billigste nettleie. Uten Norgespris kan timeprisene hentes fra den
offisielle [Nord Pool-integrasjonen](https://www.home-assistant.io/integrations/nordpool/)
(`raw_today` / `raw_tomorrow`), og berederen velger de billigste enkelttimene.

---

## Innhold

- [Hva den gjør](#hva-den-gjør)
- [Installasjon](#installasjon)
- [Oppsett steg for steg](#oppsett-steg-for-steg)
- [Kortet «KI Klima Pro»](#kortet-ki-klima-pro)
- [Soner og profiler](#soner-og-profiler)
- [Bolig eller fritidsbolig — presets](#bolig-eller-fritidsbolig--presets)
- [Moduser: helg, hjemkomst, sommer](#moduser-helg-hjemkomst-sommer)
- [Varmtvann og legionella](#varmtvann-og-legionella)
- [Eksempler](#eksempler)
- [Entiteter](#entiteter)
- [Nettleie etter døgnmaks](#nettleie-etter-døgnmaks)
- [Tjenester](#tjenester)
- [Oppgradering til 2.7.0](#oppgradering-til-270)
- [Migrering fra pakke + pyscript](#migrering-fra-pakke--pyscript)
- [Feilsøking og FAQ](#feilsøking-og-faq)

---

## Hva den gjør

| Funksjon | Hvordan |
|---|---|
| **Effektbudsjett per time** | Måler hver hele klokketime mot energiregisteret (tidsstemplet, med målt/estimert/manglende kvalitet), husker døgnmaks per dato og regner etter Elvias modell: snittet av de tre høyeste døgnmaksene fra tre ulike dager. Timegrensen settes så dagens døgnmaks ikke løfter snittet over ønsket trinn — og timer opp til dagens allerede registrerte døgnmaks er «gratis». Se [Nettleie etter døgnmaks](#nettleie-etter-døgnmaks). |
| **Prognose 15/30/60/120 min** | Lærer husets lastprofil (uke × time) og varsler *før* timen sprekker. Fleksible laster flyttes fram i stedet for å kuttes i siste liten. |
| **Prediktiv oppvarming** | Lærer tidskonstanten (τ) for hvert rom og starter oppvarmingen akkurat tidsnok til vekking, hjemkomst eller søndagsretur. Gulvvarme får alltid minst 45 min forvarming. |
| **Nattsenking bare når det lønner seg** | Regner på om senkingen faktisk sparer penger med dagens pris, nettleie og rommets τ — ellers holdes temperaturen. |
| **Solkompensasjon** | Stue med stor glassflate får lavere settpunkt når sola står på; skaleres etter glass-m² du oppgir. |
| **Måltidsreserver** | Holder av effekt til frokost/middag så komfyr + ovn + oppvaskmaskin ikke sprenger timen. |
| **Helg / hytte** | Fredagsspørsmål på mobilen, automatisk helgemodus ved lengre fravær, søndagsspørsmål med «Ja / Spør igjen / Forleng / Kommer nå», og automatisk fallback hvis ingen svarer. |
| **Varmtvann** | Kjører berederen i billigste timer innenfor vinduet, oppdager metning, og har en legionella-syklus med **hard fail-safe**: mangler effektmåling, faller den tilbake til termostat + vindu. |
| **Skyggemodus** | Motoren regner og forklarer, men rører ingenting. Perfekt de første ukene. |
| **Forklaringer** | `sensor.ki_energi_status` og `sensor.ki_beslutningslogg` sier hvorfor — «Senker vaskegang gulvvarme for å holde timen under 4,90 kWh. Tar høyde for middagsvinduet.» |

---

## Installasjon

### Via HACS (anbefalt)

1. Trykk knappen **Legg til i HACS** øverst, eller: HACS → ⋮ → *Custom repositories* →
   `https://github.com/SebastianKristo/ki-strom`, kategori **Integration** → *Add*.
2. Søk opp **KI Energi** i HACS, trykk *Download*.
3. Start Home Assistant på nytt.
4. Trykk **Legg til integrasjon** øverst, eller: Innstillinger → Enheter og tjenester →
   *Legg til integrasjon* → «KI Energi».

### Manuelt

Kopier `custom_components/ki_energi/` til `/config/custom_components/ki_energi/`, start HA på
nytt og legg til integrasjonen som over.

### Kortet

HACS-kategorien *Integration* installerer bare selve integrasjonen. Kopier
`www/ki-klima-pro-card.js` til `/config/www/` og legg til ressursen
`/local/ki-klima-pro-card.js?v=2.7.0` under Innstillinger → Dashboard → ⋮ → Ressurser
(type *JavaScript-modul*). Tøm nettleser-cache.

---

## Oppsett steg for steg

Veiviseren har fem steg. Alle felt har entitetsvelgere; verdiene under er eksempler.

| Steg | Du oppgir | Eksempel |
|---|---|---|
| **1 Måling** | Total effekt (W), importert energi (kWh, økende), utetemperatur, værentitet | `sensor.strommaler_effekt`, `sensor.strommaler_imported_energy`, `sensor.outdoor_meter_temperature`, `weather.forecast_home` |
| **2 Utstyr** | VVB-bryter og effektsensor, håndklevarmer, gardiner, hvitevarer (valgfritt) | `switch.varmtvannsbereder`, `sensor.varmtvannsbereder_power`, `cover.stue_gardin` |
| **3 Personer** | Én hjemme/borte-entitet per person | `switch.sebastian_posisjon_hjemme_borte`, `person.cybele` |
| **4 Nettleie og pris** | Elvia topp 1–3, energiledd dag/natt, spotpris eller Norgespris, Nord Pool (for VVB-planlegging) | `sensor.nettleie_elvia_toppforbruk`, `sensor.norgespris_total_strompris_norgespris` |
| **5 Hus og varsler** | Areal, byggeår, glass-m² i stua, stueareal, og hvilke telefoner som skal varsles (velges fra en liste over `notify.mobile_app_*`) | 120 m², 1980, 20 m², 40 m² |

Etterpå: **Konfigurer** på integrasjonen gir samme meny + **Soner**.

Anbefalt første uke:

```text
switch.ki_skyggemodus  = på    (motoren forklarer, men rører ikke ovnene)
switch.ki_energi_hovedbryter = på
```

Les `sensor.ki_beslutningslogg` noen dager. Ser resonnementet fornuftig ut, slå skyggemodus av.
`sensor.ki_overgang_klar` lister hva som eventuelt gjenstår (f.eks. «Ingen tidskonstanter lært ennå»).

---

## Kortet «KI Klima Pro»

Ett kort med faner: **Oversikt · Soner · Energi · Vann og bad · Tanker · Oppsett · Avansert**.
«Vann og bad» har underfaner for **Bereder** (status, legionella med sist sikret / neste frist,
prisstyring med døgnstripe som viser hvilke timer berederen kjører) og **Håndklevarmer**
(dusjvinduer, sikkerhetsavstenging). Gardinstyringen ligger under *Oppsett*.

Statuskortet øverst kan utvides (pilen nederst): da vises **«Slik tenker motoren nå»** — budsjett,
prognose, hva som senkes og hvorfor — og et sammendrag av hele systemet akkurat nå
(`sensor.ki_energi_status` → attributtet `tankegang`).

Under *Oppsett → Varslinger* velger du hvilke varsler som sendes: effektgrense, helg, hjemkomst,
sommermodus, varmtvann og håndklevarmer (`switch.ki_varsel_*`). Kritiske feil på berederen
sendes alltid. Alle innstillinger
kan endres rett i kortet (stepper-rader, brytere, klokkeslett), og hver blokk har en «?»-hjelp.

```yaml
type: custom:ki-klima-pro-card
title: Klima og energi        # valgfri
default_tab: oversikt         # oversikt | soner | energi | varmtvann | motor | logg
remember_tab: true            # husk sist valgte fane i nettleseren
```

Som popup fra et Bubble Card / tile:

```yaml
type: custom:bubble-card
card_type: button
name: Klima
icon: mdi:thermostat
tap_action:
  action: navigate
  navigation_path: "#klima"
sub_button:
  - entity: sensor.ki_energi_status
```

```yaml
type: custom:bubble-card
card_type: pop-up
hash: "#klima"
```
…og legg `custom:ki-klima-pro-card` som neste kort i samme vertical-stack.

---

## Soner og profiler

**En sone er et rom, ikke en ovn.** Under *Konfigurer → Soner* velger du én eller flere termostater
og én effektsensor per ovn for rommet; motoren skriver samme settpunkt til alle og summerer
effekten. Ved oppgradering til 2.7.0 slås soner med samme rom, type og profil sammen automatisk
(f.eks. «Stue panelovn» + «Stue oljefyr» → «Stue» med nøkkel `stue`); det logges, og
`switch.ki_styr_<gammel nøkkel>` erstattes av `switch.ki_styr_stue`. Temperaturhjelperne
(`number.ki_temp_stue_dag/natt`) beholdes.

Integrasjonen starter med ti soner (bad, kjøkken gulv/panel, stue, gang, do, vaskegang,
Cybele, Sebastian, Rune). Under **Konfigurer → Soner** kan hver sone endres, deaktiveres
eller slettes, og nye legges til.

| Felt | Betydning |
|---|---|
| `climate` | Termostaten som styres |
| `effekt` | Effektsensor (W) for sonen — gir læring av faktisk forbruk |
| `duty` / `temp` | Valgfri duty-cycle-sensor og romtemperatur (bedre τ-læring) |
| `type` | `panel` (rask) eller `gulv` (treg, minst 45 min forvarming) |
| `prio` | 1 = senkes sist (bad), 5 = senkes først (do/vaskegang) |
| `nominell` | Nominell effekt i kW — brukes til budsjettet før profilen er lært |
| `profil` | Styringsprofil, se under |
| `sol` | Om sonen påvirkes av sol (solkompensasjon) |

### Profiler

| Profil | Oppførsel |
|---|---|
| `fellesrom` | Dag/natt-temperatur, nattsenking bare når det lønner seg |
| `stue` | Som fellesrom + reduksjon etter formiddag (`ki_stue_reduksjon`) + solkompensasjon |
| `konstant` | Holdes på settpunkt hele døgnet (bad) |
| `gulv_natt` | Gulvvarme med nattsenking hvis lønnsomt (kjøkken) |
| `sjelden` | Aggressiv sparing (do, vaskegang) |
| `cybele` | Egen dag/natt/borte-tid, forvarming til vekking 05:30 |
| `sebastian` | Hjemme på dagtid, egen vekking hverdag/helg, ferie-bryter |

Hver sone får `switch.ki_styr_<sone>` (skal motoren styre denne?) og
`number.ki_temp_<sone>_dag/natt`.

---

### Leggetid og prioritet fra kortet

Øverst på *Oversikt* ligger **Leggetid**: én knapp for Cybeles og Sebastians rom. Trykker du
«Sebastian» når han legger seg, senkes rommet til natt-temperatur med én gang og varmes opp igjen
til hans vanlige vekketid (tjeneste `ki_energi.leggetid`). Prioritet mellom soner settes under
*Konfigurer → Soner*, eller med tjenesten `ki_energi.sett_prio` (lagres i minnet og overstyrer
konfigurasjonen).

Alle blokker på fanene utenom Oversikt kan legges sammen ved å trykke på overskriften — kortet
husker hva som er åpent og lukket. Alle tall- og klokkeslettfelt er rullevelgere (hjul på iPhone/Android, nedtrekk på PC). Tider
vises som en døgnplan med én rad per person, og sesonger (sommer, gardiner) som en månedsstripe
der du trykker startmåned og sluttmåned. Åpner du en sone, ser du effekt og temperatur nå og en
graf for siste seks timer.

### Vinduer og dører

Hver sone kan få én eller flere vindu-/dørsensorer (*Konfigurer → Soner → sonen → Vindu-/dørsensorer*).
Står et vindu åpent lenger enn forsinkelsen (standard 3 min, så en rask lufting ikke trigger), settes
ovnen i den sonen ned til «vindu-temperaturen» (standard 12 °C) og effekten tas ut av prognosen.
Når vinduet lukkes, går sonen tilbake til normal styring. Begge verdiene og hovedbryteren
(`switch.ki_vindu_stopp`) ligger under *Oppsett*. Sonen vises med merket **Vindu åpent** i kortet
og i «Slik tenker motoren nå».

## Bolig eller fritidsbolig — presets

Første steg i oppsettet er å velge hus:

| Preset | Hustype | Innhold |
|---|---|---|
| **Bolig — rekkehus i Oslo** | bolig | Standardoppsettet: panelovner og gulvvarme, bereder med relé, håndklevarmer, helg/hjemkomst som beskrevet under. |
| **Fritidsbolig — hytta på Toten** | fritidsbolig | 100 m² fra 1960, varmepumpe i stua (type *varmepumpe*: billigst, senkes sist), gulvvarme kjøkken/bad/inngang, oljefyr i inngangen (samme sone som gulvet), panelovner på tre soverom, bereder som bare måles, elbillader 5 A om natten. Frosttemperaturer 8/10/12 °C, mål under 5 kW, absolutt grense 9,5 kWh. |
| **Tomt oppsett** | bolig | Ingen soner, ingen forslag. |

Alle entitets-ID-er i presetet er forslag og redigeres i stegene som følger. Hjelperverdiene
(frosttemperaturer, elbil, grenser) legges inn én gang ved første kjøring og kan endres fritt
etterpå. Hustypen kan byttes senere under *Konfigurer → Hus og varsler*.

### Slik oppfører hytta seg

* **Tom hytte = frostsikring.** Når ingen er der i «Helg auto etter»-timer (3 t i presetet),
  uansett ukedag, settes `switch.ki_helgemodus` (vises som «Tom hytte (frostsikring)» i kortet):
  panelovner 8 °C, gulvvarme 10 °C, bad 12 °C.
* **Fredag kl. 10** spør den *«Kommer dere til Toten i dag?»* når hytta er tom. «Ja, vi kommer»
  starter oppvarmingen med én gang, med mål om varm hytte til `ki_hjemkomst_tid` (17:00) — sone
  for sone innenfor effektbudsjettet, gulvvarme først, varmepumpen alltid, panelovnene sist.
  «Nei» eller ikke svar gjør ingenting; frostsikringen står. (Torsdagsspørsmålet kan slås på i
  tillegg; da planlegger «ja» ankomst fredag og frosten holdes til forvarmingen må starte.)
* **Søndag kl. 10** spør den *«Drar dere hjem i dag?»*. «Ja, vi drar» — eller ikke svar innen
  fristen kl. 12 — gjør at hytta går i frostsikring i det siste person drar. «Nei, vi blir»
  stopper spørsmålet for dagen; frostsikringen kommer likevel av seg selv når hytta har vært tom
  i «Helg auto etter»-timer.
* Kommer ingen innen tre timer etter planlagt ankomst, går hytta tilbake til frostsikring.
* Kommer noen (person-entiteter «home» i hyttas Home Assistant), avsluttes ankomst og vanlige
  dag/natt-temperaturer gjelder. Sebastian og Cybele har samme profiler som hjemme (kaldt om
  natten, varmt til vekking).
* **Bereder uten bryter** regnes som uregulert last og læres inn i lastprofilen. Prisstyring og
  legionella slås på av seg selv den dagen du legger inn et relé under *Konfigurer → Utstyr*.
* **Elbil** (`switch.ki_elbil_natt`, `number.ki_elbil_effekt_kw`, `time.ki_elbil_fra/til`):
  motoren holder av ladeeffekten i ladevinduet når den planlegger varme, så bil + forvarming ikke
  havner i samme time. Når profilen har lært natten, teller halvparten.
* Nettleien regnes likt som hjemme (Elvia også på Toten): mål under 5 kW, og absolutt grense
  9,5 kWh sikrer at én time aldri passerer 10 kW-trinnet selv ved full oppvarming fra kaldt.

## Moduser: helg, hjemkomst, sommer

**Slik fungerer en hyttehelg:** Torsdag kl. 16 (og fredag kl. 10 hvis dere ikke svarte — begge
dagene kan slås av hver for seg under Helgevarsler) spør
KI Energi *«Skal dere bort i helgen?»* — bare hvis dere fortsatt er hjemme. Svarer dere
*«Ja, vi drar»*, skjer ingenting før siste person har gått ut døra; da settes helgemodus
automatisk. Drar dere uten å svare, aktiveres helgemodus av seg selv etter 6 timers fravær
(torsdag/fredag). Søndag morgen spør den *«Skal dere hjem i dag?»* og varmer opp huset til
avtalt tid — og når noen faktisk kommer hjem, avsluttes helgemodus uansett.

`sensor.ki_klima_status` viser gjeldende modus: **AUTO · MANUELL · HELG · SOMMER · HJEMKOMST ·
EFFEKTBEGRENSNING · SKYGGE**.

**Helg / hytte.** Fredag kl. `time.ki_helg_varsel_tid` får mottakerne et varsel med
*Ja, vi reiser* / *Nei*. Er alle borte i mer enn `number.ki_helg_auto_timer` timer torsdag/fredag,
slås helgemodus på automatisk. I helgemodus holdes rommene på `number.ki_temp_helg_*`.

**Hjemkomst.** Søndag kl. `time.ki_helg_sporsmal_tid`: *Ja, kl. 16 · Spør igjen om 2 t ·
Forleng til mandag · Kommer nå*. Motoren regner τ bakover fra måltiden og starter hver sone
akkurat tidsnok. Svarer ingen innen `time.ki_helg_frist_tid`, starter oppvarmingen uansett. Når noen kommer
hjem (eller planlagt tid + 3 t), går huset tilbake til AUTO.

**Sommer.** Manuelt med `switch.ki_sommermodus`, eller automatisk (`switch.ki_sommer_auto`)
mellom `number.ki_sommer_start_maned` og `..slutt_maned` når døgnmiddel ute er over
`number.ki_sommer_ute_grense`. Ovner går til minimum, gardiner skjermer for sol på varme dager.

---

## Varmtvann og legionella

- Vindu fra `time.ki_vvb_vindu_start` til `time.ki_vvb_klar_innen` (standard 22:00–05:00). Innenfor vinduet velges
  de billigste timene fra Nord Pool hvis tilgjengelig.
- **Metning**: når effekten faller under `number.ki_vvb_metning_terskel_w` i `..metning_minutter` minutter,
  regnes berederen som full og slås av.
- **Legionella**: hver `number.ki_vvb_intervall_dager` dag kreves en full syklus på minst
  `number.ki_vvb_oppvarming_minutter` minutter (senest etter `..maks_dager`). Forfalt syklus tvinges hver 2. time til den er godkjent.
- **Fail-safe**: mangler effektsensoren, eller svarer den ikke, følges bare vinduet og
  termostaten styrer. `binary_sensor.ki_vvb_ingen_respons` er da på, og du får varsel.
- `ki_energi.vvb_boost` gir varmtvann utenom vinduet (gjester, badekar).
- `sensor.ki_bereder` samler alt kortet trenger: `varmer`, `bryter_pa`, `effekt_w`, `sikret`,
  `siste_syklus`, `neste_frist`, `vindu`.

**Gardiner** (`sensor.ki_gardiner`): i sesongen (`number.ki_gardin_start_maned`–`..slutt_maned`)
holdes de lukket utenfor `time.ki_gardin_apne_tidligst`–`time.ki_gardin_lukk_senest`, og — hvis
`switch.ki_gardin_folg_sol` er på — også når sola er nede. Under `number.ki_gardin_ute_grense`
holdes de lukket hele dagen. Slås av/på med `switch.ki_styr_gardiner`.

---

## Eksempler

**Vis forklaringen på en tile**

```yaml
type: markdown
content: >-
  **{{ state_attr('sensor.ki_energi_status','modus') }}** ·
  {{ state_attr('sensor.ki_energi_status','forklaring') }}

  Igjen denne timen: {{ state_attr('sensor.ki_energi_status','igjen_kwh') }} kWh
  ({{ state_attr('sensor.ki_energi_status','minutter_igjen') }} min)
```

**Gjester: hold stua på 23 °C i tre timer**

```yaml
action: ki_energi.overstyr
data:
  sone: stue_panelovn
  temp: 23
  minutter: 180
```

**Kommer hjem tidligere enn planlagt (fra en automasjon eller iOS-snarvei)**

```yaml
action: ki_energi.hjemkomst
data:
  naa: true
```

**Varsle når legionella-syklusen er forfalt i mer enn to døgn**

```yaml
automation:
  alias: VVB forfalt
  triggers:
    - trigger: state
      entity_id: binary_sensor.ki_vvb_legionella_forfalt
      to: "on"
      for: "48:00:00"
  actions:
    - action: notify.mobile_app_iphone
      data:
        message: "Berederen har ikke fått legionellasyklus på over to døgn."
```

**Kjør motoren umiddelbart etter at du har endret en innstilling**

```yaml
action: ki_energi.tick
```

**Lese hva sonene gjør akkurat nå** — `sensor.ki_laster` har attributtet `laster`, én rad per
sone med `navn`, `mal`, `settpunkt`, `handling` (`normal`/`senket`/`forvarming`/`overstyrt`),
`prio`, `styr`, `helpere`, `entiteter`.

---

## Entiteter

### Gammel → ny ID (for deg som migrerer)

Alle hjelpere beholder object-ID; bare domenet endres.

| Gammelt | Nytt | Antall |
|---|---|---|
| `input_boolean.ki_*` | `switch.ki_*` | 26 |
| `input_number.ki_*` | `number.ki_*` | 56 (+ ett `number.ki_temp_<sone>_dag/natt` per ny sone) |
| `input_datetime.ki_*` (kun klokkeslett) | `time.ki_*` | 24 |
| `input_datetime.ki_vvb_siste_godkjente_syklus`, `ki_vvb_oppvarming_startet`, `ki_vvb_boost_til`, `ki_hjemkomst_planlagt` | `datetime.ki_*` | 4 |
| `input_text.ki_varsel_mottakere` | `text.ki_varsel_mottakere` | 1 |
| `sensor.ki_*` / `binary_sensor.ki_*` | uendret | 19 / 11 |
| `input_boolean.ki_klima_<sone>` (styr-brytere) | `switch.ki_styr_<sone>` | én per sone |

Nye entiteter: `sensor.ki_prognose` (15/30/60/120 min), `sensor.ki_besparelse`,
`switch.ki_nattsenk_aktiv`, `switch.ki_sommer_auto`, `switch.ki_helg_auto`,
`switch.ki_hjemkomst_aktiv`, `switch.ki_vvb_legionella_aktiv`, `number.ki_temp_helg_bad`,
`number.ki_sommer_*_maned`, `number.ki_sommer_ute_grense`, `number.ki_helg_auto_timer`,
`number.ki_gardin_ute_grense`, `number.ki_trinn_kostnad_diff` (reserve når tabellen ikke dekker),
`number.ki_mal_trinn_kw`, `number.ki_reserve_topp_kwh`, `switch.ki_tillat_dyrere_trinn`,
`text.ki_tariff_tabell`, `sensor.ki_nettleie`, `number.ki_stat_spart_kr`,
`number.ki_stat_komfortavvik`, `time.ki_hjemkomst_tid`, `time.ki_cybele_borte_fra/til`.

Fjernet (den gamle DEL 1 «effektvakt»): `ki_motor_overtar`, `ki_shed_niva`,
`ki_effektgrense_kwh`, hysterese/stagger/preheat-tallene, `ki_klima_hovedbryter`,
utility-meterne og lagringstesten. Kortet er oppdatert tilsvarende
(«Prognose og reserver», «Moduser og unntak», hjemkomstknapper i helgeblokken).

Viktigste sensorer:

| Entitet | Innhold |
|---|---|
| `sensor.ki_energi_status` | `grønn/gul/rød/av`, attributter: forklaring, modus, grense_kwh, forbrukt_kwh, igjen_kwh, minutter_igjen, prognose_15/30/60/120_kw |
| `sensor.ki_prognose` | Forventet effekt om 15/30/60/120 min + tillatt |
| `sensor.ki_laster` | Antall senkede soner; attributt `laster` |
| `sensor.ki_beslutningslogg` | Siste 40 beslutninger med tid, forklaring og tiltak |
| `sensor.ki_klima_status` | Gjeldende modus |
| `sensor.ki_tidskonstanter` | Lært τ per sone |
| `sensor.ki_besparelse` | Estimert besparelse denne måneden (merket estimat) |
| `sensor.ki_overgang_klar` | Hva som gjenstår før skyggemodus kan slås av |
| `sensor.ki_vvb_legionella_status`, `binary_sensor.ki_vvb_legionella_forfalt`, `binary_sensor.ki_vvb_ingen_respons` | Varmtvann |
| `binary_sensor.ki_alle_borte` | Alle personer borte |

---

## Tjenester

| Tjeneste | Felt |
|---|---|
| `overstyr` | `sone`, `temp`, `minutter` (standard 120) |
| `fjern_overstyring` | `sone` (utelat for alle) |
| `nullstill_laering` | `hva`: `alt` / `profil` / `tau` |
| `vvb_boost` / `vvb_avbryt_boost` / `vvb_tving_syklus` | `minutter` (boost) |
| `hjemkomst` / `hjemkomst_ferdig` | `tid` (HH:MM) eller `naa: true` |
| `helg_sporsmal` | – (send fredagsspørsmålet nå) |
| `sett_standardverdier` | – (tilbakestill alle hjelpere) |
| `tick` | – (kjør motoren nå) |

Varsler går til `notify.<mottaker>` for hver mottaker i `text.ki_varsel_mottakere`.
Knappene i varslene (`KI_HELG_JA/NEI`, `KI_HJEM_JA/SENERE/FORLENG/NAA`) fanges av
integrasjonen via `mobile_app_notification_action`; ingen egne automasjoner trengs.

---

## Nettleie etter døgnmaks

Fra 2.7.0 følger motoren Elvias faktiske modell i stedet for en fast timegrense.

### Måling av hele klokketimer

* Energiregisteret (`Måling → Importert energi`) prøves ved hver oppdatering, med sensorens eget
  tidsstempel. Verdien ved en timegrense regnes som **målt** når en prøve ligger innenfor ±15 s,
  ellers **estimert** ved lineær interpolering mellom nærmeste prøver (bare hvis hullet er under
  20 min). Er hullet lengre, er timen **mangler** — den regnes ikke som null og differansen legges
  ikke på én time.
* Ved omstart eller databrudd forsøker motoren å rekonstruere prøvene rundt timegrensene fra
  Home Assistants recorder. Lykkes det ikke, forblir timen «mangler».
* Faller registeret (nullstilling/målerbytte), forkastes timen bruddet skjedde i; neste time
  måles normalt.
* Timene nøkles i UTC, så høst-døgnet med 25 timer og vår-døgnet med 23 timer håndteres uten at
  timer slås sammen eller mistes. Datoer er lokale (Home Assistants tidssone).
* `sensor.ki_time_energi` viser foreløpig verdi for inneværende time; kilden i statussensoren
  sier om nullpunktet var målt eller interpolert.

### Døgnmaks, topp tre og tariff

* Døgnmaks per lokal dato beregnes av **fullførte** timer, med klokketime, kilde og kvalitet.
  Inneværende time holdes utenom som prognose.
* De tre eksterne toppsensorene (`Nettleie → Topp 1–3`) har ingen dato. Egne, daterte
  døgnmakser er fasit. En ekstern verdi lik en egen dag (±0,06 kWh) regnes som samme dag; resten
  legges inn som **udaterte dager** — de kan aldri være «i dag», så de trekker alltid i
  konservativ retning, og datakvaliteten settes til «usikker». Ved installasjon midt i måneden
  er det derfor de eksterne tallene som bærer de første dagene.
* Tarifftabellen ligger i `text.ki_tariff_tabell` (standard `2:150,5:250,10:420,15:585,20:755`,
  øvre grense kW → kr/mnd). Nøyaktig på grensen regnes som trinnet over (5,0 → 420 kr). Snittet
  avrundes ikke. Over siste grense er trinnet **ukjent** — motoren dikter ikke satser.

### Timegrensen

For hver time regnes:

1. forventet sluttforbruk = brukt hittil + planlagt effekt × tid igjen;
2. kandidat for dagens døgnmaks = maks(registrert døgnmaks, forventet sluttforbruk);
3. topp tre fra tre ulike datoer i en kopi av måneden, med dagens verdi erstattet — aldri telt
   dobbelt;
4. snitt, trinn og eventuell økning i fastledd (kr/mnd, én gang per måned — ikke per time).

Grensen er `maks(dagens registrerte døgnmaks, 3·(mål − reserve) − de to høyeste andre dagene)`,
begrenset av **absolutt timegrense** (`number.ki_maks_time_kwh`, nå 6,0 som standard — anleggets
og komfortens tak, ikke økonomi) og laveste grense. Mål er `number.ki_mal_trinn_kw` (snitt under
5 kW). Er målet alt passert denne måneden, holder motoren snittet under *neste* grense i stedet
(«mål passert» i kortet). Bryteren `switch.ki_tillat_dyrere_trinn` setter komfort foran
fastledd: da gjelder bare den absolutte grensen. Det finnes ingen skjult kroneverdi for komfort.

Reserven er `number.ki_reserve_topp_kwh` (0,30) pluss 0,10 ved delvis og 0,20 ved usikker
historikk. Er færre enn to andre dager kjent, går motoren i **reservemodus**: ukjente dager regnes
som den høyeste kjente døgnmaksen eller den absolutte grensen — ikke som null.

Eksempel: topper 4,8 / 4,1 / 3,9 fra tre dager. Ender en time i dag på 5,5 kWh, blir snittet 4,8
(fortsatt 250 kr), og resten av dagen kan alle timer gå til 5,5 uten at noen ovn senkes. 6,1 kWh
ville gitt snitt 5,0 → 420 kr (+170 kr); det stopper motoren, med mindre du har slått på «tillat
dyrere trinn». Neste dag er 5,5-dagen bare én av «de andre», og rommet krymper til
3·4,7 − 5,5 − 4,8 = 3,8 kWh.

Alt dette vises i `sensor.ki_nettleie` og i *Energi → Dynamisk grense* (topp tre og en
søylegraf over månedens døgnmakser ligger i en nedtrekksdel): dagens døgnmaks med time,
topp tre med datoer og kilde, registrert snitt og trinn, forventet sluttforbruk, forventet topp
tre og trinn, økning i fastledd, reserve og datakvalitet — registrert og prognose adskilt.

### Begrensninger

* Prognosen for timen bygger på motorens lastprofil; den er et anslag, ikke en sikker kostnad.
* Reserven er en enkel regel (grunnreserve + påslag), ikke en statistisk modell av resten av
  måneden. Den skjelner mellom «ingen økning med dagens topper» og «mindre rom framover», men
  regner ikke sannsynlighet for framtidige topper.
* Motoren kan bare fjerne styrt varme. Komfyr, bil og bereder utenfor motorens kontroll kan
  fortsatt gi en topp den ikke får stoppet.
* Trinn over 20 kW er ikke i standardtabellen; legg dem inn selv om du trenger dem.

## Tidsplan i motoren

- Energimotor: hvert minutt (første kjøring 20 s etter oppstart)
- Læring (lastprofil + tidskonstanter): hvert 5. minutt
- Timeslutt: hele klokketimen (hh:00:05 lukkes forrige time; timemåleren venter inntil 5 min på forsinket registerprøve)
- Månedsskifte (nullstill statistikk): 00:00 den 1.
- Sommer-auto: 12:00 daglig; helg-auto/hjemkomst sjekkes i motoren

Innlærte profiler, τ, overstyringer, logg og VVB-tilstand lagres i
`.storage/ki_energi.<entry_id>.minne` og overlever omstart og oppdatering.

---

## Oppgradering til 2.7.0

* `number.ki_maks_time_kwh` betyr nå **absolutt** timegrense (anlegg/komfort), ikke økonomi.
  Sto den på den gamle standardverdien 4,90, løftes den automatisk til 6,00 én gang ved første
  kjøring (logges i beslutningsloggen). Har du satt en annen verdi, røres den ikke.
* `number.ki_mal_snitt_kwh` (mål for snitt) brukes ikke lenger av motoren; erstattet av
  `number.ki_mal_trinn_kw` (ønsket trinn) og `number.ki_reserve_topp_kwh` (reserve). Entiteten
  beholdes så dashboards ikke knekker.
* Standardverdien for `number.ki_trinn_kostnad_diff` er 170 kr (250 → 420). Den brukes bare som
  reserve i besparelsesestimatet når tarifftabellen ikke dekker.
* Soner med samme rom slås sammen til én sone (se [Soner og profiler](#soner-og-profiler)).
* Timehistorikk og døgnmakser bygges opp fra første kjøring; de første dagene bærer de eksterne
  toppsensorene grunnlaget (datakvalitet «usikker», litt større reserve).

## Migrering fra pakke + pyscript

1. Slett/kommenter ut `packages/ki_klima_energi.yaml` og `pyscript/ki_energi.py`.
2. Start HA på nytt **én gang** så de gamle `input_*`- og `sensor.ki_*`-entitetene forsvinner
   (ellers får de nye suffiks `_2`).
3. Installer integrasjonen som over. Veiviseren er forhåndsutfylt med entitetene fra det gamle oppsettet.
4. Bytt kortressurs til `?v=2.0.0`. Kortet oversetter gamle `input_*`-ID-er og
   `pyscript.*`-tjenester automatisk, så eksisterende popup-konfigurasjon virker.
5. Innstillingene dine (temperaturer, tider) må settes én gang på nytt — eller trykk
   *Standardverdier* i kortet for utgangspunktet.

---

## Feilsøking og FAQ

**Motoren står i «Effektmåleren svarer ikke».** Sjekk at total effekt-sensoren oppdateres
minst hvert 2. minutt. HAN-port-lesere som faller ut gir dette. Motoren rører ingenting før
målingen er tilbake.

**Ovnene endres ikke.** Er `switch.ki_skyggemodus` av? Er `switch.ki_styr_<sone>` på? Står
sonen i `sensor.ki_laster` med `handling: overstyrt`? Samme settpunkt skrives maks hvert 5. minutt.

**Prognosen er lik i alle horisonter.** Normalt de første dagene — lastprofilen er ikke lært ennå.
`ki_energi.nullstill_laering` starter på nytt hvis huset har endret seg mye.

**Jeg vil se hva den tenker.** Fanen *Motor* i kortet, eller
`sensor.ki_beslutningslogg` → attributt `linjer`.

**Logg:** `logger: logs: custom_components.ki_energi: debug` i `configuration.yaml`.

Feil og forslag: [Issues](https://github.com/SebastianKristo/ki-strom/issues).

---

## Ikon og logo

`brand/` inneholder `icon.svg/png` (256 px, HA-integrasjonsikon) og `logo.svg/png`. Ikonet ligger også i
`custom_components/ki_energi/` så det vises lokalt. Vil du ha det i Home Assistant offisielt, send
`brand/icon.png`, `icon@2x.png`, `logo.png` og `logo@2x.png` som PR til
[home-assistant/brands](https://github.com/home-assistant/brands) under `custom_integrations/ki_energi/`.

## Utvikling

`tests/` inneholder pytest-tester (`pytest-homeassistant-custom-component`) som setter opp
integrasjonen i en ekte HA-testinstans, oppretter alle entiteter, kjører motor/VVB/moduser,
kaller alle tjenester og går gjennom oppsettsveiviser og options-flyt. Kjørt mot HA 2025.1.

```bash
pip install pytest-homeassistant-custom-component
pytest
```

Lisens: MIT.
