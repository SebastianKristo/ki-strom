# KI Energi 2.31.0

## Gjennomgang: robusthet, ytelse og diagnostikk

Ingen endring i selve styringen. Alt her handler om at motoren skal holde seg oppe, bruke mindre
ressurser, og være lett å feilsøke.

### Ticket tåler at en del feiler

Ticket kjørte moduser, bereder, lys og motor etter hverandre, og bare motoren hadde sin egen vakt. En
feil i modusene eller berederen stoppet hele ticket **før** motoren fikk kjørt — varmestyringen sto
stille det minuttet, uten at noe ble logget. Nå har hver del sin egen vakt: feiler én, logges den, og
resten kjører likevel. Feilen står som `feil` på `sensor.ki_energi_status` til delen går igjen.

### Ticket overlapper ikke seg selv

Et tick som venter på et tregt tjenestekall (en termostat som ikke svarer) fikk et nytt tick oppå seg
etter et minutt, og de to skrev settpunkter om hverandre. Nå får det som pågår gjøre seg ferdig;
det neste hoppes over og telles i `ticks_hoppet_over` på statussensoren. Ligger tallet og stiger, er
noe tregt — og det er nå synlig.

### Effektsensorene skrives samlet

Effektmåleren kan melde flere ganger i sekundet (Tibber Pulse, smartplugger). For hver melding ble
tre avledede sensorer skrevet på nytt — tre tilstandsendringer i recorderen per måling, døgnet rundt.
Integralet tar fortsatt hver eneste måling (det må det, for å bli riktig), men sensorene skrives
høyst hvert annet sekund.

### Diagnostikk

**Innstillinger → Enheter og tjenester → KI Energi → Last ned diagnostikk** gir én fil med oppsettet,
alle sensorene slik motoren sist regnet dem, kildeentitetene slik Home Assistant ser dem (tilstand,
enhet, sist oppdatert), minnet med læringen, og helsen til ticket. Varselmottakerne strykes.

### Rydding

- Tjenestene registreres og fjernes fra én liste (`TJENESTER` i `const.py`), med en sjekk som stopper
  oppstarten hvis en ny tjeneste er glemt i den. Før lå navnene i to lister som måtte holdes like.
- Ubrukte importer og løkkevariabler fjernet; `ruff` er ren på feil-, bug- og importreglene.

### Kontrollert

Kjørt med Python 3.13.15 og Home Assistant 2025.12.5: 153 tester bestått, fem nye i
`tests/test_overhaul.py` — berederen som feiler uten at motoren stopper (og feilen på statussensoren
til neste tick går), et tick som henger uten at neste legger seg oppå, fem effektmålinger som gir
fem integreringer men én sensorskriving, diagnostikken med strøkne mottakere, og tjenestene som
registreres og fjernes fra samme liste. Oversettelser og `services.yaml` er sjekket mot koden — alt
stemmer. Ingen advarsler om utgåtte API-er fra Home Assistant.
