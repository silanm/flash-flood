#!/usr/bin/env python3
"""nRF24L01 -> MQTT gateway on the Pi hub (v2: RF hot standby).

Since 2026-10-25 the ESP32 (ESP32_Node.ino v3) sends EVERY reading twice: over WiFi/MQTT and over
nRF24L01 (RfPacket). This gateway is the de-duplicator:
  - it subscribes to farm/<site>/node/+/level and remembers each reading that arrived over WiFi,
    keyed by (node, seq, ts);
  - it holds each RF packet for HOLD_S seconds; if the same reading has arrived over WiFi by then,
    the RF copy is dropped, otherwise it is published on the same topic with "transport":"rf"
    (teammate's contract, ARCHITECTURE.md section 4). Not retained, QoS 1 on the local broker.
So a WiFi path that silently loses data (e.g. QoS 0 into a half-open TCP socket, Build_Log section 10)
is filled from RF within HOLD_S, and the platform sees each reading once.

Config: env vars, or /home/pi/ff-hub/hub.env (KEY=VALUE, mode 600):
  FF_SITE (default ait), MQTT_HOST (127.0.0.1), MQTT_PORT (1883), MQTT_USER, MQTT_PASS
Radio settings must match ESP32_Node.ino. Only one process may own the radio
(stop this service before running nrf_rx_test.py).
"""
import json
import os
import re
import signal
import struct
import sys
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from pyrf24 import RF24, RF24_1MBPS, RF24_PA_LOW

CE_PIN, CSN = 25, 0          # GPIO25 (pin 22), /dev/spidev0.0
HUB_ADDR = b"FFHUB"
CHANNEL = 108
FMT = "<B8sBIQhhhh"          # ver, node, flags, seq, ts_ms, dist_mm, filt_mm, temp_cc, rh_cpct
SIZE = struct.calcsize(FMT)  # 30
PKT_VER = 2
INT16_MIN = -32768
HOLD_S = 3.0                 # wait this long for the WiFi copy before publishing the RF copy
SEEN_TTL_S = 120             # forget WiFi readings after this long
STATS_S = 300                # log counters this often
# 2026-11-05: a corrupt packet that passed the version check put a bad node name into the topic; the broker
# dropped the connection as "malformed", and paho resent the queued QoS 1 publish on every reconnect (Build_Log 20).
NODE_RE = re.compile(rb"[A-Za-z0-9_-]{1,8}")
TS_MIN_MS = 1_700_000_000_000  # Nov 2023: an older "synced" node clock is garbage


def load_env(path="/home/pi/ff-hub/hub.env"):
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def log(*a):
    print(*a, flush=True)


def iso_ms(ts):
    return datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main():
    load_env()
    site = os.environ.get("FF_SITE", "ait")
    lock = threading.Lock()
    seen = {}       # (node, seq, ts_ms) -> monotonic time the WiFi copy arrived
    pending = {}    # (node, seq, ts_ms) -> (deadline, topic, payload, rx_ms)
    stats = {"rf_rx": 0, "rf_dup": 0, "rf_filled": 0}

    def on_connect(c, u, f, rc, p):
        log("[MQTT] connected:", rc)
        c.subscribe(f"farm/{site}/node/+/level", qos=0)

    def on_message(c, u, msg):
        try:
            d = json.loads(msg.payload)
            if d.get("transport") != "wifi":
                return   # our own RF republish, or a non-node publisher
            node = msg.topic.split("/")[3]
            ts_ms = round(datetime.fromisoformat(d["ts"]).timestamp() * 1000)
            key = (node, int(d["seq"]), ts_ms)
        except (ValueError, KeyError, TypeError, IndexError):
            return
        with lock:
            seen[key] = time.monotonic()
            if pending.pop(key, None):
                stats["rf_dup"] += 1

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ff-rf-gateway")
    if os.environ.get("MQTT_USER"):
        client.username_pw_set(os.environ["MQTT_USER"], os.environ.get("MQTT_PASS"))
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect_async(os.environ.get("MQTT_HOST", "127.0.0.1"), int(os.environ.get("MQTT_PORT", "1883")))
    client.loop_start()

    radio = RF24(CE_PIN, CSN)
    if not radio.begin() or not radio.is_chip_connected:
        sys.exit("[RF] nRF24L01 not responding (wiring, or another process owns it)")
    radio.channel = CHANNEL
    radio.data_rate = RF24_1MBPS
    radio.set_pa_level(RF24_PA_LOW)
    radio.payload_size = SIZE
    radio.open_rx_pipe(1, HUB_ADDR)
    radio.listen = True
    log(f"[RF] listening on ch {CHANNEL}, payload {SIZE} B, site {site}, hot standby (hold {HOLD_S} s)")

    running = True

    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    last_stats = time.monotonic()
    while running:
        now = time.monotonic()

        # publish RF copies whose WiFi twin never came; forget old WiFi keys
        with lock:
            due = [k for k, v in pending.items() if v[0] <= now]
            fill = [pending.pop(k) for k in due]
            for k in [k for k, t in seen.items() if now - t > SEEN_TTL_S]:
                del seen[k]
        for _, topic, payload, rx_ms in fill:
            client.publish(topic, json.dumps(payload, separators=(",", ":")), qos=1, retain=False)
            stats["rf_filled"] += 1
            log(f"[RF->MQTT] {topic} seq {payload['seq']} dist {payload['distance_cm']} "
                f"(no WiFi copy after {HOLD_S} s; radio rx at {iso_ms(rx_ms)})")

        if now - last_stats >= STATS_S:
            log(f"[STATS] last {STATS_S} s: rf rx {stats['rf_rx']}, dropped as WiFi duplicate {stats['rf_dup']}, "
                f"filled from RF {stats['rf_filled']}")
            stats = dict.fromkeys(stats, 0)
            last_stats = now

        has_payload, _ = radio.available_pipe()
        if not has_payload:
            time.sleep(0.005)
            continue
        rx_ms = int(time.time() * 1000)
        ver, node, flags, seq, ts_ms, dist_mm, filt_mm, temp_cc, rh_cpct = struct.unpack(FMT, radio.read(SIZE))
        if ver != PKT_VER:
            log(f"[RF] packet version {ver} (want {PKT_VER}), dropped")
            continue
        node = node.rstrip(b"\0")
        if not NODE_RE.fullmatch(node) or (flags & 1 and not TS_MIN_MS < ts_ms < rx_ms + 3_600_000):
            log(f"[RF] corrupt packet (node {node!r}, ts {ts_ms}), dropped")
            continue
        stats["rf_rx"] += 1
        node = node.decode("ascii")
        key = (node, seq, ts_ms)
        payload = {
            "seq": seq,
            # node clock not synced -> stamp with the Pi's clock
            "ts": iso_ms(ts_ms if flags & 1 else rx_ms),
            "distance_cm": None if dist_mm < 0 else dist_mm / 10,
            "filtered_cm": None if filt_mm < 0 else filt_mm / 10,
            "temp_c": None if temp_cc == INT16_MIN else temp_cc / 100,
            "rh_pct": None if rh_cpct == INT16_MIN else rh_cpct / 100,
            "transport": "rf",
        }
        with lock:
            if key in seen:
                stats["rf_dup"] += 1
            else:
                pending[key] = (time.monotonic() + HOLD_S, f"farm/{site}/node/{node}/level", payload, rx_ms)

    radio.listen = False
    radio.power = False
    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
