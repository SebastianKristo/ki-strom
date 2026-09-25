# KI Energi 2.32.0

## Overstyringen synes i lastlista

Hver rad i `sensor.ki_laster` har fått to felt:

- `overstyrt_til` — når den manuelle overstyringen slutter (ISO-tid), eller `null`
- `overstyrt_temp` — temperaturen den står på

Før sa lista bare *at* en sone var overstyrt. Veggpanelet i ki-cards 5.70.0 bruker feltene til å vise
«Manuelt til 11:34» og temperaturen du valgte.

### Kontrollert

Python 3.13.15 og Home Assistant 2025.12.5: 154 tester bestått, én ny — en overstyring på 90 minutter
gir `overstyrt: true`, temperaturen og en slutt 85–91 minutter fram, og `fjern_overstyring` nullstiller
alle tre.
