# KI Energi 2.30.0

## Hjemkomsten sendes med dato, ikke bare klokkeslett

`sensor.ki_tilstedevaerelse` hadde `hjemkomst_tid` — klokkeslettet i innstillingen. Kortene som
ville telle ned måtte gjette datoen, og la på et døgn så snart tiden var passert. Derfor sto det
«Hjemkomst om 23 t 45 min» kl. 13.00 på en søndag der svaret nettopp var gitt.

Klokkeslettet er ikke nok til å vite når hjemkomsten er:

- svarer du ja etter at innstilt tid er passert, settes planen til om 30 minutter
- «Vi kommer hjem nå» gir om 20 minutter
- på fritidsboligen planlegges ankomsten på en annen **dag** (fredag kl. 17)

Nytt attributt `hjemkomst_planlagt` gir hele tidspunktet i lokal tid, hentet fra
`datetime.ki_hjemkomst_planlagt` — det samme motoren selv forvarmer mot. Det er `null` når ingen
hjemkomst er planlagt, akkurat som `hjemkomst_tid`, så et gammelt tidspunkt blir aldri stående og
se ut som en ny plan.

`hjemkomst_tid` er beholdt uendret, så eldre kort virker som før.

### Kontrollert

Hele testpakka kjørt: 148 tester, alle grønne. To nye i `test_tilstedevaerelse.py` — at tidspunktet
følger med når hjemkomst er aktiv, og at feltet er tomt når den ikke er det. Ingen endring i selve
styringen: motoren har alltid brukt `datetime.ki_hjemkomst_planlagt` (`hjemkomst_frist` i engine.py),
det var bare kortene som ikke fikk se den.

Kortsiden ligger i KI Klima/Strøm-kort 1.22.0, som leser det nye attributtet.
