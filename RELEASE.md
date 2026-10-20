# KI Energi 2.33.1

Feilrettinger. Ingen oppsett må endres, og ingen nye entiteter.

## Varmtvannsbereder

- **Ble slått av midt i oppvarmingen.** Effekten leses én gang i minuttet. Ett minutt med 0 W eller
  `unavailable` fra måleren fikk berederen til å regnes som ferdig. Var vinduet stengt eller timen ikke
  lenger billig, slo KI av før termostaten koblet ut — og metningen ble aldri sett, så legionella ble
  heller ikke bekreftet. Nå får en påbegynt oppvarming gå til termostaten kobler ut (høyst
  `ki_vvb_maks_oppvarming_min`).
- **«Tving syklus» ble slått av etter ett minutt** når vinduet var ferdig for natta.
- **Nord Pool nede → kaldt vann i dagevis.** Med «følg spotpris» og ingen priser fantes ingen billige
  timer, og berederen varmet først når legionellafristen tvang den. Nå følges vinduet når prisene mangler.
- **Falsk varsel «Berederen styres av noe annet»** når KI selv slo av like etter påslag (timeskifte,
  vinduet stenger), eller når releet var `unavailable` et øyeblikk. Ga også 30 minutters sperre.
- **Releet klikket av og på hvert 11. minutt** under boost etter at vannet var varmt. Boosten avsluttes
  nå ved metning.

## Lading og effekttrinn

- **Bilen ble regnet som husets uregulerte forbruk.** Den spiste sin egen plass i budsjettet, så ladingen
  stoppet og startet omtrent hvert minutt, presset ned varmen og ble lært inn i timeprofilen som fast
  forbruk om natta. Ladeeffekten trekkes nå ut (målt, ellers trinnet KI satte). Med automatikken av
  regnes manuell lading som uregulert, men telles ikke lenger to ganger i prognosen.
- **Månedsmålet ble gitt opp etter én høy dag.** Snittet av én eller to kjente topper ble sammenlignet
  med målet, og KI godtok neste effekttrinn for resten av måneden. Nå er målet tapt først når summen
  av de kjente toppene delt på tre passerer det.
- **Reserven eksploderte de siste minuttene av timen** når den adaptive marginen var lært (0,3 kWh med
  ett minutt igjen ble 18 kW), og alle soner unntatt prioritet 1 ble senket ved hvert timeskifte.
  Marginen skaleres nå ned med tiden igjen, slik den faste reserven alltid har gjort.

## Moduser

- **«Ja, sett sparemodus nå» fra varselet ble opphevet etter ett minutt.** Varselet sendes bare når noen
  er hjemme, og «noen er hjemme» ble lest som «noen kom hjem». Nå er det overgangen borte → hjemme som
  avslutter sparemodus og hjemkomst.
- **Hjemkomst-bryteren virket bare første gang.** Den gamle, passerte planen ble stående, og hjemkomsten
  ble avsluttet i neste tick. Nå lages en ny plan.
- **Bad-vifta startet aldri på fukt** når fuktstyring av håndklevarmeren var av (standard). De to delte
  tidsstempel, og det ene slettet det andre hvert minutt.
- **Forsinket hjemkomst ga hvilenivå.** Etter planlagt ankomsttid falt forvarmingen bort og målet til
  16 °C fram til hjemkomsten ble avsluttet (opptil 3 t). Nå holdes dagtemperatur.

### Kontrollert

Python 3.13.16 og Home Assistant 2026.2.3 (uten pytest-homeassistant-custom-component, som ikke lot
seg installere): 148 tester bestått, 18 av dem nye (`tests/test_vvb_midt_i_syklus.py`,
`tests/test_gjennomgang.py`). Hver feil over har minst én test som feilet på 2.33.0. `test_smoke`, `test_overhaul`,
`test_hytte_og_hus`, `test_rom_temp` og `test_varmekilder` trenger HA-testinstansen og er ikke kjørt
for denne versjonen.
