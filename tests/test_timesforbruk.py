"""«Denne timen» skal måle hullene, ikke gange siste avlesning med dem."""
import pytest
from unittest.mock import MagicMock, patch

from custom_components.ki_energi.engine import KiEngine


def _motor(effekt_w, register_kwh, siste_ts):
    hub = MagicMock()
    hub.f.return_value = effekt_w
    hub.cfg.return_value = "sensor.effekt"
    hub.nettleie.forelopig_time.return_value = (register_kwh, "forelopig")
    hub.nettleie.siste_prove_ts.return_value = siste_ts
    return KiEngine(hub)


def test_kortvarig_topp_blir_ikke_et_helt_kvarter():
    """3,6 kW i ett sekund skal ikke bli 0,9 kWh fordi registeret er 15 min gammelt."""
    naa = 1_000_000.0
    with patch("custom_components.ki_energi.engine.dt_util") as dt:
        dt.utcnow.return_value.timestamp.return_value = naa - 900
        dt.now.return_value.strftime.return_value = "2026-09-13 08"
        motor = _motor(300.0, 0.5, naa - 900)      # 300 W i 15 minutter
        motor.forbrukt_denne_timen()

        # 14 minutter med rolig forbruk
        for i in range(1, 15):
            dt.utcnow.return_value.timestamp.return_value = naa - 900 + i * 60
            motor.integrer_effekt()

        # og så et sekunds topp på 3,6 kW idet vi leser av
        motor.hub.f.return_value = 3600.0
        dt.utcnow.return_value.timestamp.return_value = naa
        kwh, _ = motor.forbrukt_denne_timen()

    tillegg = kwh - 0.5
    assert tillegg == pytest.approx(0.075, abs=0.02), f"fikk {tillegg:.3f} kWh, ventet ~0,075 kWh"
    assert tillegg < 0.9, "toppen ble ganget ut over hele hullet igjen"


def test_faller_ikke_midt_i_timen():
    """Når registeret tar igjen anslaget, skal tallet stå — ikke gå ned."""
    naa = 2_000_000.0
    with patch("custom_components.ki_energi.engine.dt_util") as dt:
        dt.now.return_value.strftime.return_value = "2026-09-13 08"
        dt.utcnow.return_value.timestamp.return_value = naa
        motor = _motor(1200.0, 1.5, naa - 600)
        forst, _ = motor.forbrukt_denne_timen()

        # registeret oppdaterer seg, men til en lavere verdi enn anslaget
        motor.hub.nettleie.forelopig_time.return_value = (0.9, "forelopig")
        motor.hub.nettleie.siste_prove_ts.return_value = naa
        dt.utcnow.return_value.timestamp.return_value = naa + 60
        etter, _ = motor.forbrukt_denne_timen()

    assert etter >= forst, f"gikk ned fra {forst:.2f} til {etter:.2f} kWh"


def test_nullstilles_ved_timeskifte():
    naa = 3_000_000.0
    with patch("custom_components.ki_energi.engine.dt_util") as dt:
        dt.utcnow.return_value.timestamp.return_value = naa
        dt.now.return_value.strftime.return_value = "2026-09-13 08"
        motor = _motor(1000.0, 2.4, naa)
        motor.forbrukt_denne_timen()
        dt.now.return_value.strftime.return_value = "2026-09-13 09"
        motor.hub.nettleie.forelopig_time.return_value = (0.05, "forelopig")
        kwh, _ = motor.forbrukt_denne_timen()
    assert kwh < 0.2, "sperren mot fall holdt igjen verdien inn i neste time"
