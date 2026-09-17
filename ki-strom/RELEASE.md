# KI Energi 2.18.0

## Legionella ble aldri bekreftet på en bereder uten relé

På hytta står berederen bare på — det finnes ingen bryter KI kan styre, bare en
effektmåling. I den modusen krevde metningen likevel `bryter == "on"`:

```python
mettet = (bryter == "on" and h.on("ki_vvb_har_trukket_effekt") and ...)
```

Uten relé leser `h.st(None)` en tom tilstand, aldri `"on"`. Betingelsen kunne dermed ikke
bli sann. Berederen kunne gjøre full oppvarming hver dag i månedsvis uten at én metning
ble registrert, dagteller bare vokste, og kortet meldte «Forfalt — tvinges på».

Uten relé regnes berederen nå som permanent på, som den faktisk er: elementet har strøm
hele tiden, og effektmålingen alene forteller om den varmer eller er mettet. Full
oppvarming fulgt av lav effekt i åtte minutter bekrefter legionella, akkurat som med
relé.

**Ny syklus startes av effekten, ikke av bryteren.** Uten relé finnes ingen av/på-overgang
som nullstiller «har trukket effekt». Flagget nullstilles derfor når elementet begynner å
trekke strøm igjen etter en metning — det er starten på neste oppvarming.

**Statusteksten lover ikke noe den ikke kan holde.** Ved forfall står det nå «Forfalt —
overvåkes» i stedet for «Forfalt — tvungen kjøring». Uten en bryter kan ingenting tvinges
på, og teksten skal si det.

«Ingen respons fra berederen» leser bryteren direkte og gir derfor ingen falsk alarm i
denne modusen. Det er kontrollert med egen test.

Fem tester dekker dette: at modusen kjennes igjen, at metning bekreftes uten relé, at
dagtelleren og legionella-status følger, at statusteksten er ærlig, og at
ingen-respons-alarmen holder seg rolig.
