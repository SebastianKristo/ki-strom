# KI Energi 2.34.1

Tydeligere oppsett, og sjekk av varmtvannsberederen i Homey-appen.

## Home Assistant

- **Oppsettet sier rett ut hva du velger:** «Kjør her i Home Assistant (regner og styrer selv)» eller
  «Fjernkontroll for Homey-appen (styrer ingenting selv)», med forklaring av forskjellen.
- **Fjernkontrollen bekrefter tilkoblingen** før oppsettet fullføres: nettselskap, rom, personer, bereder og om
  appen står i skyggemodus — og at Home Assistant ikke styrer noen enheter selv.
- Enheten heter nå «KI Energi på Homey», og sensoren «Styres fra» viser «Homey-appen».
- **Den lokale versjonen** har nummererte steg («Steg 1 av 7») og kortere forklaringer som sier hva som er
  påkrevd og hva som er valgfritt.
- Nye entiteter i fjernkontrollen: «Varmtvann klart til fristen», «Legionellasikret», «Bereder – morgensjekk»,
  «Bereder – legionella» og «Berederen sist varm».

Har du fjernkontrollen fra før, beholder oppføringen sitt gamle navn; entitetene er de samme.

## Homey-appen 0.4.3

- **Varmt til fristen:** rekker ikke berederen å bli ferdig til «Ferdig innen» (standard kl. 05), varmer den
  uansett pris og effekt. Oppvarmingstiden læres av berederens egne oppvarminger.
- **Morgensjekk:** når fristen passerer, sjekkes det at vannet ble varmt. Hvis ikke, får du et varsel med grunnen,
  og flow-kortet «Berederen ble ikke varm til fristen» utløses.
- **Legionella:** varsel når det er mer enn tre dager siden vannet var varmt, lenge før tvangen etter sju dager.
- Nye ikoner, logo, omskrevet dokumentasjon og innstillingsside i faner (0.4.2).

Sjekkene gjelder Homey-appen. Den lokale Home Assistant-versjonen har legionellafristen fra før, men ikke
morgensjekken.

### Kontrollert

Python 3.13, Home Assistant 2026.2.3: 233 tester. Homey-appen: 105 tester, og `homey app validate --level publish`.

Ikke prøvd på en ekte Homey.
