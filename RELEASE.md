# KI Energi 2.14.2

## Berederen som slo seg av og på hvert minutt

Vernet mot at en annen styring slår av berederen (lagt inn i 2.9.4) utløste aldri.
Betingelsen krevde at bryteren sto `on` ved forrige tick og `off` ved denne, men
`_siste_bryter` settes tidlig i ticken, før KI slår på. Slår den andre styringen av
mellom to ticks, leser KI alltid `off` ved tickstart, og overgangen ble usynlig.
Resultatet var at KI slo lydig på igjen hvert minutt hele natten.

Vernet går nå ut fra KI sitt eget påslag: er bryteren av, slo vi den på for under fem
minutter siden, og slo vi den ikke av selv, er det noen andre. Da venter KI 30 minutter
før nytt forsøk, og logg, beslutningslogg og varsel oppgir hvor mange sekunder reléet
faktisk sto på, pluss hvor mange ganger det har skjedd siden omstart.

## Lysregler (fra 2.14.1)

* `light` og `presence` i lysregel-skjemaet hadde `default=""`. `cv.entity_id_or_uuid`
  avviser tom streng, så skjemaet feilet med «Entity is neither a valid entity ID nor a
  valid UUID» før steget kjørte. Verdiene legges nå inn som suggested_value.
* En nærværssensor kan fjernes igjen; tidligere ble den gamle verdien liggende.
* `_glemt()` kalte alltid `light.turn_off`. Regler på `switch.`-entiteter slo aldri av,
  men ble logget som avslått. Tjenesten kalles nå i entitetens eget domene.
* Nattdemping avvises for entiteter som ikke kan dimmes, i stedet for å sende
  `brightness_pct` til en bryter.
* `fra`/`til` normaliseres (`8` → `08:00`), og ugyldige klokkeslett gir feilmelding i
  skjemaet i stedet for å bli stille forkastet.

## Filer

`custom_components/ki_energi/`: `vvb.py`, `config_flow.py`, `lys.py`, `manifest.json`,
`strings.json`, `translations/nb.json`, `translations/en.json`
