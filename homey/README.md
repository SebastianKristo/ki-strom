# KI Energi for Homey

Homey-versjonen av KI Energi. Appen bygges trinnvis:

1. **Strømkalkulator:** nettleie, kapasitetstrinn, strømstøtte, Norgespris og månedskostnad.
2. **Energimotor** (denne versjonen): timebudsjett, rom med prioritet, værvarsel og prisoptimal varmeplan.
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

## Energimotoren

Legg til enheten **KI Energi → Energimotor**, og sett opp rommene i appens innstillinger
(«Hent rom fra Homey-sonene» lager ett rom per sone med termostater).

Hvert minutt:

1. **Timens grense:** det høyeste timen kan ende på uten at kapasitetsleddet går opp et trinn,
   mellom en laveste og en absolutt grense du setter.
2. **Annet forbruk:** det motoren ikke styrer læres per ukedag og time, og brukes til å anslå resten av timen.
3. **Mål per rom:** fra programmet (dag/natt), eller fra varmeplanen når rommet er lært.
4. **Fordeling:** rommene får effekt etter prioritet. Blir timen for trang, senkes de minst viktige
   noen grader, og de slippes ett om gangen når det er rom igjen. Prioritet 1 senkes aldri.

**Varmeplanen** regner for hvert lærte rom den billigste måten å holde komforten på de neste 36 timene,
med rommets egen kurve (hvor fort det varmes og kjøles), værvarselet fra Yr og prisen time for time
(kraft etter strømstøtte eller Norgespris, pluss energiledd). Det gir nattsenking bare når den lønner seg,
forvarming i billige timer, og start i tide før dagen begynner — tidligere jo kaldere det er.

**Læringen** trenger effektmåling på ovnene (W) og noen døgn med data. Til et rom er lært, følger det programmet.

**Skyggemodus** er på som standard: motoren regner og forklarer, men rører ikke termostatene.
Slå den av på enheten eller i innstillingene når forslagene ser fornuftige ut.

Personprogram, helg/bortemodus, bereder, lading og lys kommer i trinn 3.

## Sensorer

Enheten **Strømkalkulator** har 33 sensorer: tariff, energiledd, kapasitetstrinn, de tre toppene, margin til neste trinn,
spotpris, strømstøtte, totalpris, forbruk og kostnad for timen, dagen og måneden, og forrige måned til å sjekke fakturaen mot.

## Flow-kort

- **Når:** kapasitetsvarsel, kapasitetstrinnet endret seg, en time er ferdig, tariffen skiftet, strømprisen endret seg,
  energimotorens status endret seg, et rom ble senket.
- **Og:** tariffen er dagtariff, Norgespris er aktiv, kapasitetsvarsel er på, totalprisen er over …, energimotorens status er …
- **Så:** overstyr temperaturen i et rom, fjern overstyringen, slå skyggemodus av eller på.

## Lokalt API

`http://<homey>/api/app/no.kristo.kienergi/…` med en API-nøkkel fra Homey som Bearer-token.

| Metode | Sti | Innhold |
| --- | --- | --- |
| GET | `/status` | Alt kalkulatoren viser, som JSON |
| GET | `/priser` | Spotpriser time for time, 48 t fram |
| GET | `/nettselskap` | Nettselskapene i katalogen |
| GET | `/enheter` | Enheter som kan være strømmåler |
| GET / PUT | `/innstillinger` | Les og endre innstillingene |
| GET | `/motor` | Energimotorens bilde: budsjett, rom, settpunkter og forklaringer |
| GET / PUT | `/motorinnstillinger` | Motorens innstillinger og rom |
| GET | `/termostater`, `/temperatursensorer`, `/romforslag` | Til oppsettet |
| POST | `/overstyr`, `/fjernoverstyring` | `{rom, temp, minutter}` / `{rom}` |

## Utvikling

All beregning ligger i `lib/` uten avhengighet til Homey, og testes med `npm test`.
`app.json` bygges fra tabellene i `lib/` med `npm run bygg`.
