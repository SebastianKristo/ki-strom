# KI Energi 2.16.0

## Ett temperaturpunkt per rom

Et rom kan ha flere varmekilder: stua har panelovn og oljefyr, kjøkkenet panelovn og
gulvvarme. Hver av dem er sin egen sone med sitt eget dagpunkt, så å endre temperaturen i
et rom betydde å endre to tall — eller å holde en `input_number` ved siden av og koble den
opp med automasjoner.

Ny entitet per rom: **`number.ki_rom_<rom>_temp`**.

Setter du den, skjer to ting: dagpunktet (`temp_dag`) settes på alle sonene i rommet, slik
at motoren regner med den nye temperaturen, og `climate.set_temperature` sendes til alle
klimaenhetene i rommet så det merkes med en gang.

Rommet bestemmes av `rom:`-feltet på sonen. Sonene i kjøkkenet — panelovn og gulvvarme —
får dermed ett felles punkt, mens de fortsatt styres hver for seg av motoren med sin egen
prioritet og treghet. Soner som ikke er aktive, tas ikke med.

Attributtene lister varmekildene i rommet med type og nominell effekt, så kortene kan vise
«panelovn + oljefyr» uten å slå det opp selv.

Rom med bare én varmekilde får entiteten også, slik at dashbordet kan bruke samme
navnemønster uansett.

Flere varmekilder per rom har alltid vært mulig — `climate:` på en sone er en liste — men
det var ingen felles måte å styre dem på.
