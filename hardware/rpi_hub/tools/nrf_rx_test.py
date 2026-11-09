#!/usr/bin/env python3
"""nRF24L01 link test - Pi hub receiver.

Stage 1 (no ESP32 needed): checks the Pi can talk to the module over SPI.
Stage 2: prints packets from ESP32_nRF_TX.ino. Ctrl+C to stop.
Wiring: CE GPIO25 (pin 22), CSN GPIO8/CE0 (pin 24) -> /dev/spidev0.0.
"""
import struct
import sys
import time

from pyrf24 import RF24, RF24_1MBPS, RF24_PA_LOW

CE_PIN = 25
CSN = 0                 # /dev/spidev0.0 (SPI0 CE0)
HUB_ADDR = b"FFHUB"     # must match ESP32_nRF_TX.ino
CHANNEL = 108
FMT = "<II"             # counter, uptime_ms
SIZE = struct.calcsize(FMT)

radio = RF24(CE_PIN, CSN)
if not radio.begin():
    sys.exit("radio.begin() FAILED - check VCC 3.3 V, GND, CE/CSN, SPI wires, dtparam=spi=on")
print("is_chip_connected:", radio.is_chip_connected)

radio.channel = CHANNEL
radio.data_rate = RF24_1MBPS
radio.set_pa_level(RF24_PA_LOW)
radio.payload_size = SIZE
radio.open_rx_pipe(1, HUB_ADDR)
radio.listen = True
radio.print_pretty_details()

print("\nListening... (Ctrl+C to stop)")
last, got, t0 = None, 0, time.monotonic()
try:
    while True:
        has_payload, pipe = radio.available_pipe()
        if has_payload:
            counter, uptime = struct.unpack(FMT, radio.read(SIZE))
            got += 1
            gap = "" if last is None or counter == last + 1 else f"  (gap: expected #{last + 1})"
            print(f"pipe {pipe}: #{counter}  esp32 uptime {uptime / 1000:.1f} s{gap}")
            last = counter
        time.sleep(0.005)
except KeyboardInterrupt:
    print(f"\nreceived {got} packets in {time.monotonic() - t0:.0f} s")
finally:
    radio.listen = False
    radio.power = False
