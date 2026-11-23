# KI Energi for Homey

Homey-versjonen av KI Energi. Appen bygges trinnvis:

1. **Strømkalkulator:** nettleie, kapasitetstrinn, strømstøtte, Norgespris og månedskostnad.
2. **Energimotor:** timebudsjett, rom med prioritet, værvarsel og prisoptimal varmeplan.
3. **Huset** (denne versjonen, 3a): personer, bortemodus og hjemkomst, bereder, håndklevarmer, vaner og widget.
   Elbillading og lysregler kommer i 3b.
4. **Kontrollversjon i Home Assistant:** integrasjonen i dette repoet kan kobles til appen («På Homey» i oppsettet)
   og viser og betjener den derfra.

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

**Skyggemodus** er på som standard: appen regner og forklarer, men rører verken termostater, bereder eller håndklevarmer.
Slå den av på enheten eller i innstillingene når forslagene ser fornuftige ut.

## Huset

Settes opp under «Huset» i appens innstillinger.

**Personer.** Hver person følger en Homey-bruker eller en ja/nei-variabel (ja = hjemme). Et rom kan følge
en person: barn har fast opp/legg og er borte på dagtid, ungdom har egen leggetid og vekking for hverdag og helg.

**Bortemodus** slår seg på når alle har vært ute lenge nok (standard 3 timer), og av i det noen kommer hjem.
Den kan også slås på for hånd, fra enheten eller et flow-kort; da står den til dere har dratt og kommet tilbake.

**Bortetemperaturen** velges for hvert lærte rom: den laveste temperaturen rommet rekker å varme seg opp fra
til dagtemperaturen innen forvarmingstiden, i det kaldeste været varselet viser — aldri under bunnen du setter
(standard 12 °C). Rom som ikke er lært, bruker faste temperaturer (16 / 18 / 22 °C).

**Hjemkomst** er når huset skal være varmt igjen: en fast ukedag og tid (standard søndag kl. 13), eller satt
med flow-kortet «Vi kommer hjem kl. …». Fordi kravet stiger på et kjent tidspunkt, starter varmeplanen
oppvarmingen i tide rom for rom. Etter tiden holdes dagtemperatur til noen kommer.
«Vi blir borte lenger» hopper over den faste hjemkomsten.

**Berederen** varmer i vinduet (standard 22–05) eller i de billigste timene, slår av når termostaten kobler ut,
og hviler når huset står tomt. Legionellasikringen går foran alt: har det gått for lenge siden vannet var varmt,
varmes det uansett pris og effekt. En påbegynt oppvarming avbrytes ikke.

**Håndklevarmeren** står på i et morgen- og et kveldsvindu, og av når huset er tomt.

**Vanene** lærer når dere pleier å komme hjem etter en tur og når huset våkner, og foreslår endringer i
innstillingene. Lært hjemkomsttid kan brukes automatisk.

**Widgeten** «KI Energi – oversikt» viser status, timen, prisen nå, måneden, modus og hvert rom.

Homey-varsler kan ikke ha svarknapper, så spørsmålene fra Home Assistant-versjonen («Skal dere bort i helgen?»)
er erstattet av automatisk bortemodus og flow-kort.

## Sensorer

Enheten **Strømkalkulator** har 33 sensorer: tariff, energiledd, kapasitetstrinn, de tre toppene, margin til neste trinn,
spotpris, strømstøtte, totalpris, forbruk og kostnad for timen, dagen og måneden, og forrige måned til å sjekke fakturaen mot.

## Flow-kort

- **Når:** kapasitetsvarsel, kapasitetstrinnet endret seg, en time er ferdig, tariffen skiftet, strømprisen endret seg,
  energimotorens status endret seg, et rom ble senket, bortemodus ble slått av eller på, noen kom hjem, berederen er varm.
- **Og:** tariffen er dagtariff, Norgespris er aktiv, kapasitetsvarsel er på, totalprisen er over …, energimotorens status er …,
  bortemodus er på, alle er borte.
- **Så:** overstyr temperaturen i et rom, fjern overstyringen, slå skyggemodus eller bortemodus av eller på,
  «vi kommer hjem kl. …», «vi blir borte lenger», varm opp berederen nå, kjør en full oppvarming av berederen.

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
| GET | `/hus` | Modus, personer, hjemkomst, bereder, håndklevarmer og vaner |
| GET / PUT | `/husinnstillinger` | Personer, bortemodus, bereder og håndklevarmer |
| GET | `/personkilder`, `/brytere` | Til oppsettet |
| POST | `/bortemodus`, `/hjemkomst`, `/forleng`, `/bereder` | `{paa}` / `{tid}` / – / `{handling, minutter}` |

## Utvikling

All beregning ligger i `lib/` uten avhengighet til Homey, og testes med `npm test`.
`app.json` bygges fra tabellene i `lib/` med `npm run bygg`.
