# KI Energi 2.35.0

Ny læringskjerne i Homey-appen (0.5.0). Home Assistant-integrasjonen viser det appen har lært.

## Homey-appen 0.5.0

Hvert rom får sin egen modell av fysikken, lært av det som faktisk skjer:

- **Oppvarmingsevne og varmetap**, vanligvis lært i løpet av et døgn.
- **Vind** — hvor mye tapet øker når det blåser (fra værvarselet, eller egen vindmåler).
- **Sol fra øst, sør og vest** — rommet lærer selv hvor vinduene står.
- **Treghet** — gulvvarme startes timer før, panelovner like før.
- **Lufting** — med vindussensor pauses varmen mens vinduet står åpent.
- **Ovnens virkelige effekt** og **husets øvrige forbruk** med usikkerhet.

Og den retter seg selv:

- **Lærer av feil:** bommer modellen mer enn den pleier, lærer den rommet på nytt. Var rommet for kaldt da dagen
  begynte, starter den tidligere neste gang. Uforutsigbart forbruk gir større reserve i timebudsjettet.
- **Kan korrigeres:** skrur du på en termostat selv, holdes det i tre timer. Tre like justeringer på to dager blir
  en fast justering for dag eller natt i det rommet. Alt kan glemmes igjen fra innstillingene.
- **Sikkerhet foran sparing:** ulærte rom følger programmet, planen regner forsiktig, og en vindussensor som
  henger får ikke la rommet stå kaldt.

Varmeplanen tar nå hensyn til vind, sol og treghet time for time, og unngår timer der huset pleier å bruke mye.

Oversikten i innstillingene viser hva appen har lært om hvert rom og de siste hendelsene i læringen.

Det som var lært fra før, brukes som utgangspunkt; rommene må bekreftes av nye målinger (rundt et døgn) før
varmeplanen tar over igjen.

Også i 0.4.4: månedens topper fra før appen begynte å måle kan legges inn under *Strøm*.

## Home Assistant

- Rommene (klimaenhetene) i fjernkontrollen har fått attributter for det appen har lært: tekst, sikkerhet,
  tidskonstant, varmetap, vind, sol og treghet, samt lært justering og om et vindu står åpent.

### Kontrollert

Homey-appen: 129 tester, blant dem læring mot et simulert hus med kjent fysikk og hele motoren i lukket sløyfe
(panelovn og gulvvarme). `homey app validate --level publish`. Home Assistant: 233 tester.

Styringslogikken er gjennomgått uavhengig; de fem feilene som ble funnet (blant dem at en omstart kunne tolke
appens eget settpunkt som en justering fra deg) er rettet og dekket av egne tester.

Ikke prøvd på en ekte Homey. Simuleringen viser at metoden virker; hvor mye den sparer i et virkelig hus er ikke målt.
