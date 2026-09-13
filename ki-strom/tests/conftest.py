import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry  # noqa

@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield

@pytest.fixture
def expected_lingering_timers():
    # sun-integrasjonen (avhengighet) har sin egen polling-timer
    return True
