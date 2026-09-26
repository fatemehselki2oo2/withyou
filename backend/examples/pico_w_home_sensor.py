"""Raspberry Pi Pico W sender for the WithYou judging demo.

Copy this file to the Pico W as main.py after changing the configuration below.
The Wi-Fi transport is real; the environmental values are intentionally
simulated until exact external sensors are attached.
"""

import network
import ntptime
import time
import ujson
import urequests


WIFI_SSID = "YOUR_WIFI_NAME"
WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"
API_BASE_URL = "https://withyou-1g5l.onrender.com"

# Use a private 6-12 character code and tell judges this code. The backend
# automatically creates the temporary session when this Pico first sends data.
DEMO_SESSION_ID = "WITHYOU1"
DEVICE_ID = "pico-w-demo-01"
SEND_EVERY_SECONDS = 10


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(WIFI_SSID, WIFI_PASSWORD)
        started = time.ticks_ms()
        while not wlan.isconnected():
            if time.ticks_diff(time.ticks_ms(), started) > 20_000:
                raise RuntimeError("Wi-Fi connection timed out")
            time.sleep_ms(250)
    print("Wi-Fi connected:", wlan.ifconfig()[0])


def sync_clock():
    # FastAPI requires a timezone-aware timestamp. NTP lets the Pico create UTC.
    for _ in range(3):
        try:
            ntptime.settime()
            return
        except OSError:
            time.sleep(1)
    raise RuntimeError("Could not synchronize the Pico clock")


def utc_timestamp():
    year, month, day, hour, minute, second, _, _ = time.gmtime()
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (
        year, month, day, hour, minute, second
    )


def simulated_environment(counter):
    # Gentle changes make the live judging demo visible without claiming that
    # the Pico's internal temperature is the room temperature.
    return (
        ("temperature", 71.0 + (counter % 9) * 0.25, "fahrenheit"),
        ("humidity", 44.0 + (counter % 7) * 0.5, "percent"),
        ("light", 280 + (counter % 6) * 20, "lux"),
    )


def send_reading(sensor_type, value, unit, timestamp):
    reading_id = "%s:%s:%s" % (DEVICE_ID, sensor_type, timestamp)
    payload = {
        "id": reading_id,
        "demo_session_id": DEMO_SESSION_ID,
        "device_id": DEVICE_ID,
        "timestamp": timestamp,
        "source": "arduino",
        "sensor_type": sensor_type,
        "value": value,
        "unit": unit,
        "confidence": 1.0,
        "is_simulated": True,
        "metadata": {
            "hardware": "Raspberry Pi Pico W",
            "label": "Simulated environmental value",
        },
    }
    response = urequests.post(
        API_BASE_URL.rstrip("/") + "/api/sensors/readings",
        data=ujson.dumps(payload),
        headers={"Content-Type": "application/json"},
    )
    try:
        print(sensor_type, response.status_code, response.text)
    finally:
        response.close()


connect_wifi()
sync_clock()
counter = 0

while True:
    now = utc_timestamp()
    for reading in simulated_environment(counter):
        send_reading(reading[0], reading[1], reading[2], now)
    counter += 1
    time.sleep(SEND_EVERY_SECONDS)
