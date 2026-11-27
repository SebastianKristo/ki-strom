# KI Energi 2.35.1

Varsler om helg, ferie og hjemkomst fra Homey-appen, og flere rettelser der.

## Home Assistant

- Nye knapper i fjernkontrollen: «Helg: vi drar bort», «Helg: vi blir hjemme» og «Ferie (uten hjemkomstdato)».
- Sensoren «Modus» viser «Ferie» når huset regnes som på ferie.

## Homey-appen 0.5.5

- **Varsler om helg, ferie og hjemkomst** i Homeys tidslinje, hvert med av/på under *Hjemme og borte*:
  - Torsdag kl. 17 spør appen om dere skal bort i helgen. «Bort» senker huset i det siste person drar; «hjemme»
    hindrer automatisk bortemodus den helgen. Én påminnelse fredag hvis dere er hjemme og ikke har svart.
  - Varsel når oppvarmingen til hjemkomst starter, og når huset er klart (eller hvilke rom som ikke er varme ennå).
  - Kommer ingen til planlagt tid, regnes huset som på ferie, og den faste ukentlige oppvarmingen hoppes over til
    noen kommer hjem. Ferie kan også startes for hånd, med eller uten hjemkomstdato.
- Nye flow-kort: «KI Energi har et varsel» (teksten kan sendes videre som push eller leses opp), «KI Energi spør om
  dere skal bort i helgen», «Svar på helgespørsmålet», «Ferie til …» og «Ferie uten dato».
- **Robust strømmåling (0.5.4):** måleren leses direkte hvert minutt, og et kWh-register som står stille mens huset
  bruker strøm erstattes av effekten. Oversikten viser hva det regnes fra.
- **Håndklevarmeren (0.5.3)** slås av og på ved skiftene, og det du gjør selv får stå til neste skifte.
- **Berederen (0.5.2)** varmer alltid ferdig: bare dens egen termostat avslutter en oppvarming.

### Kontrollert

Homey-appen: 142 tester og `homey app validate --level publish`. Home Assistant: 233 tester.

Ikke prøvd på en ekte Homey. Homey-varsler kan ikke ha svarknapper, så helgespørsmålet besvares i innstillingene,
med et flow-kort eller fra Home Assistant.
