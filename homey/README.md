# KI Energi for Homey

Homey-versjonen av KI Energi. Appen bygges trinnvis:

1. **Strømkalkulator** (denne versjonen): nettleie, kapasitetstrinn, strømstøtte, Norgespris og månedskostnad.
2. Effektmotor og soner, med værvarsel og prisoptimal varmeplan.
3. Bereder, moduser, helg, lading, lys og selvlærende vaner.
4. Kontrollversjon i Home Assistant, som styrer denne appen.

Krever Homey Pro (2023 eller nyere).

## Installere

```bash
cd homey
npm install
homey app install      # eller: homey app run  (viser loggen direkte)
```

Deretter:

1. Legg til enheten **KI Energi → Strømkalkulator** i Homey.
2. Åpne appens innstillinger. Velg strømmåleren (effekt og helst kWh-register), nettselskap og boligtype, og kryss av hvis du har Norgespris.

Spotprisene hentes av appen selv fra hvakosterstrommen.no for nettselskapets prisområde.

## Strømkalkulatoren

Regner på samme måte som [Strømkalkulator for Home Assistant](https://github.com/fredrik-lindseth/Stromkalkulator)
av Fredrik Lindseth (MIT). Tariffene for 76 nettselskap (`lib/tariffer.json`) og beregningsreglene er hentet derfra:

- **Forbruk:** delta fra målerens kWh-register, time for time. Uten register summeres effekten.
- **Kapasitetsledd:** nettselskapets metode. De fleste bruker snittet av de tre høyeste døgnmaksene i måneden;
  Sør Aurdal bruker månedens høyeste time, Alut og Netera hovedsikringen, Fjellnett fem sesongvektede ukestopper.
- **Energiledd:** dag er hverdager 06–22 utenom helligdager, ellers natt/helg. Noen nettselskap bruker bare klokkeslett,
  og noen har sommer- og vinterpriser.
- **Avgifter 2026:** forbruksavgift 7,13 øre, Enova 1,00 øre, mva 25 % (0 % i Nord-Norge, ingen forbruksavgift i tiltakssonen).
- **Strømstøtte:** 90 % av spotpris over 96,25 øre/kWh inkl. mva, inntil 5000 kWh per måned. Ikke for ren fritidsbolig.
- **Norgespris:** 50 øre/kWh (40 i nord), inntil 5000 kWh per måned (1000 for fritidsbolig), spotpris over taket.
- **Kostnad:** hvert intervall prises med sin egen spotpris og tariff. Kapasitetsleddet påløper jevnt over måneden.

Ikke med ennå: eksport/plusskunde, sammenligning mot strømleverandørens pris, og fakturakontrollen
(«avregning») fra originalen.

## Sensorer

Enheten **Strømkalkulator** har 33 sensorer: tariff, energiledd, kapasitetstrinn, de tre toppene, margin til neste trinn,
spotpris, strømstøtte, totalpris, forbruk og kostnad for timen, dagen og måneden, og forrige måned til å sjekke fakturaen mot.

## Flow-kort

- **Når:** kapasitetsvarsel, kapasitetstrinnet endret seg, en time er ferdig, tariffen skiftet, strømprisen endret seg.
- **Og:** tariffen er dagtariff, Norgespris er aktiv, kapasitetsvarsel er på, totalprisen er over …

## Lokalt API

`http://<homey>/api/app/no.kristo.kienergi/…` med en API-nøkkel fra Homey som Bearer-token.

| Metode | Sti | Innhold |
| --- | --- | --- |
| GET | `/status` | Alt kalkulatoren viser, som JSON |
| GET | `/priser` | Spotpriser time for time, 48 t fram |
| GET | `/nettselskap` | Nettselskapene i katalogen |
| GET | `/enheter` | Enheter som kan være strømmåler |
| GET / PUT | `/innstillinger` | Les og endre innstillingene |

## Utvikling

All beregning ligger i `lib/` uten avhengighet til Homey, og testes med `npm test`.
`app.json` bygges fra tabellene i `lib/` med `npm run bygg`.
