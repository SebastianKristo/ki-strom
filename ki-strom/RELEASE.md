# KI Energi 2.20.0

## Ny sensor: `sensor.ki_tilstedevaerelse`

Integrasjonen skilte allerede mellom en tur på butikken og bortreist — den første skal
ikke senke huset, den andre skal — men skillet fantes ikke noe sted utenfor koden.
`borte_siden` lå bare i minnet til `modes.py`, så et kort kunne ikke vise hvor lenge
noen hadde vært borte.

Sensoren sier det i klartekst:

| Tilstand | Tekst |
| --- | --- |
| `hjemme` | Noen er hjemme |
| `hjemkomst` | Noen er hjemme — varmer opp igjen |
| `kort_tur` | Ute en tur, 40 min — bortemodus om 5 t 20 min |
| `borte` | Alle er borte |
| `borte_lenge` | Borte i 3 døgn — huset står i bortemodus |
| `ukjent` | Vet ikke om noen er hjemme |

Attributter: `tekst`, `borte_siden`, `minutter_borte`, `bortemodus`,
`hjemkomst_aktiv`, `venter_svar`, `auto_etter_timer` og `hjemkomst_tid`.

Ni tester dekker overgangene, inkludert bortemodus uten kjent starttid og
nedtellingen til automatisk bortemodus.

## Ett kjent problem, fortsatt ikke løst

`tests/test_smoke.py::test_lysregler` feiler: soveromslyset slås ikke av etter fravær,
mens vaskerommet gjør det. Jeg har ikke rørt lysreglene i denne eller forrige versjon.
Det er verdt en egen runde.
