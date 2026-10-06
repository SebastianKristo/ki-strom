# KI Energi 2.33.0

Gjennomgang av hele integrasjonen med hytte og hus som to likeverdige tilfeller. Ingen oppsett
må endres; forskjellen merkes først i kulda, i tomt hus, og hos andre nettselskap enn Elvia.

## Feil som er rettet

- **Settpunkt utenfor termostatens grenser** ble avvist av Home Assistant uten at sonen fikk vite det.
  En varmepumpe går sjelden under 16 °C, så hyttas frostsikring på 8 °C ble aldri skrevet. Nå klemmes
  verdien til `min_temp`–`max_temp`, og det logges én gang.
- **Nettleie første dagene i måneden:** ukjente dager ble regnet som den absolutte grensen. Med 9,5 kWh
  på hytta ble rommet for dagen negativt, og ankomsten på månedens første fredag strupt til laveste
  grense uten grunn. Nå regnes ukjente dager som det huset pleier å toppe på (forrige måneds snitt),
  aldri under målet.
- **Nattsenking «lønte seg» nesten aldri:** regelen sammenlignet k·timer med prisforholdet, som om hele
  gjenoppvarmingen var en ekstra kostnad. Energien som ikke tilføres om natten er den som hentes igjen
  om morgenen; den koster bare prisforskjellen. Ny regel regner nedkjølingstiden med dagens
  utetemperatur.
- **Varmetap lært mens ovnen gikk** i soner uten effektsensor («ingen sensor» ble lest som 0 W).
  Termostatens `hvac_action` avgjør nå; er den ukjent, læres ingenting.
- **Tidsstyrte spørsmål** (torsdag/fredag/søndag, fristen, sommer-auto) krevde at ticket traff nøyaktig
  minuttet. Et hoppet tick ga ingen spørsmål den dagen. Nå gjelder et vindu etter klokkeslettet, én
  gang per dag.
- **«Toten» sto i koden** i fredagsspørsmålet — feil for Strömstad. Stedsnavnet settes under
  *Hus → Stedets navn*.
- Helgevekking for ungdom var inkonsekvent mellom to steder i motoren (ukedagen nå mot morgenen etter).
- Sperren mot at timeforbruket «faller» midt i timen kunne dra seg inn i neste time ved overgangen til
  vintertid.
- En feilende ladeknapp veltet hele motorens tick. `ki_energi.tick` kjørte ikke lysreglene. Boost og
  tvungen syklus uten relé gjorde tomme tjenestekall. `sw_version` på enheten sto på 2.0.0.

## Nytt

- **Frostvakt** (`switch.ki_frostvakt`, `binary_sensor.ki_frostfare`): bortetemperaturene løftes
  trinnvis når det er kaldere enn −10 ute (+2 °C, +4 under −20); et rom under 5 °C får prioritet 1,
  varmes uansett modus og budsjett, og varsles alltid. Død termostat i tomt hus i kulda varsles også.
- **Termisk modell for forvarming:** motoren lærer oppvarmingsevnen (°C/t ved null forskjell til ute)
  og regner tiden etter dT/dt = r − k·(T − ute). Samme rom trenger lenger tid i −20 enn i +5; når
  målet ikke kan nås i været, startes det så tidlig som tillatt og forklaringen sier hvorfor.
  `number.ki_forvarming_maks_timer` (10 t, hytta 24 t).
- **Lastprofil per tilstedeværelse:** én profil for hus med folk, én for tomt hus. Prognosen bruker
  den som gjelder nå.
- **Nettleiemodeller:** `elvia` (døgnmaks fra tre ulike dager) eller `topp3_timer` (tre høyeste timer i
  måneden — svensk effektavgift), med høylastvindu (klokkeslett, bare hverdager, bare måneder).
  Utenfor vinduet gjelder bare den absolutte grensen.
- **Bereder i bortemodus** (`switch.ki_vvb_borte_sparing`): hviler når huset står tomt, varmer når
  legionellafristen er i siste døgn, når noen er hjemme, og tre timer før planlagt hjemkomst
  (`number.ki_vvb_klar_for_ankomst_timer`).
- **Lading:** faser og spenning i oppsettet (16 A = 3,7 / 6,4 / 11 kW), trinnets faktiske effekt læres
  fra målingen, `switch.ki_lading_kun_natt`. Styrer KI laderen, holdes det ikke av ladeeffekt på
  forhånd i prognosen i tillegg.

## Nye entiteter

`switch.ki_frostvakt`, `switch.ki_vvb_borte_sparing`, `switch.ki_lading_kun_natt`,
`number.ki_frost_ute_grense`, `number.ki_frost_paslag`, `number.ki_frost_alarm_temp`,
`number.ki_vvb_klar_for_ankomst_timer`, `number.ki_forvarming_maks_timer`, `binary_sensor.ki_frostfare`.
Nye attributter: `sensor.ki_tidskonstanter.oppvarmingsevne`, `sensor.ki_nettleie.modell/hoylast/i_hoylast/
forrige_maned_snitt`, `sensor.ki_bereder.borte_sparing`, `sensor.ki_lading_status.faser/volt/kw_per_trinn/kw_malt`.

Kortet (ki-klima-strom-kort) viser ikke de nye innstillingene ennå; de ligger på enheten i
Home Assistant til kortet oppdateres.

### Kontrollert

Python 3.13.16, Home Assistant 2025.12.5, pytest-homeassistant-custom-component 0.13.300:
182 tester bestått, 28 av dem nye (`tests/test_hytte_og_hus.py`) — termisk modell mot lukket formel,
frostpåslag og -alarm, klemming, høylastvindu og timemodell, plassholder med forrige måned,
bereder i bortemodus, faser/lærte trinn/nattlading, tolerante tidshendelser, og hytta i −22 i en
ekte HA-testinstans (varmepumpe klemt til 16, panelovner med +4, nettleie brukbar første dag).

Ikke verifisert mot fysisk utstyr: hvilke `min_temp` termostatene dine faktisk melder, Ellevios
nøyaktige høylastdefinisjon for Strömstad (sett vinduet etter fakturaen), og laderens trinn-effekt
på tre faser.
