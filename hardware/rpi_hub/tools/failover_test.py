#!/usr/bin/env python3
"""Failover test on the Pi (v2, 2026-10-25, for the RF hot standby).

Blocks the ESP32's MQTT traffic for CUT_S seconds with nftables, then reports, per seq, which path
delivered it and how late. Does not open the serial port (that resets the ESP32).
  MODE drop   : silently drop both directions -> half-open TCP, the node's QoS 0 publishes "succeed"
                (the case that lost data on 2026-10-25, Build_Log.md section 10)
  MODE reject : TCP reset -> the node sees the failure at once (the 2026-10-23 test)
Usage: sudo is needed for nft.  python failover_test.py <esp_ip> [cut_s=30] [drop|reject]
"""
import json, os, subprocess, sys, time
from datetime import datetime
import paho.mqtt.client as mqtt

ESP_IP = sys.argv[1]
CUT_S = int(sys.argv[2]) if len(sys.argv) > 2 else 30
MODE = sys.argv[3] if len(sys.argv) > 3 else "drop"
AFTER_S = 40
env = dict(l.strip().split("=", 1) for l in open("/home/pi/ff-hub/hub.env") if "=" in l and not l.startswith("#"))

rx = []   # (rx time, seq, transport, ts)
def on_msg(c, u, m):
    try:
        d = json.loads(m.payload)
        rx.append((time.time(), d["seq"], d["transport"], datetime.fromisoformat(d["ts"]).timestamp()))
    except Exception:
        pass
c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ff-failover-test")
c.username_pw_set(env["MQTT_USER"], env["MQTT_PASS"])
c.on_message = on_msg
c.on_connect = lambda c, u, f, r, p: c.subscribe("farm/ait/node/node01/level")
c.connect("127.0.0.1"); c.loop_start()

def nft(cmd):
    subprocess.run(["sudo", "nft"] + cmd.split(), check=False)
time.sleep(10)
action = "drop" if MODE == "drop" else "reject with tcp reset"
nft("add table inet fftest")
nft("add chain inet fftest in { type filter hook input priority 0 ; }")
nft("add chain inet fftest out { type filter hook output priority 0 ; }")
nft(f"add rule inet fftest in ip saddr {ESP_IP} tcp dport 1883 {action}")
nft(f"add rule inet fftest out ip daddr {ESP_IP} tcp sport 1883 drop")
t_cut = time.time()
print(f"CUT ({MODE}) for {CUT_S} s", flush=True)
time.sleep(CUT_S)
nft("delete table inet fftest")
t_restore = time.time()
print("RESTORE", flush=True)
time.sleep(AFTER_S)
c.loop_stop()

seqs = {}
for t, s, tr, ts in rx:
    seqs.setdefault(s, []).append((t, tr, ts))
lo, hi = min(seqs), max(seqs)
missing = [s for s in range(lo, hi + 1) if s not in seqs]
dups = [s for s, v in seqs.items() if len(v) > 1]
rf = sorted(s for s, v in seqs.items() if any(tr == "rf" for _, tr, _ in v))
lat = [t - ts for v in seqs.values() for t, tr, ts in v if tr == "rf"]
print(f"seq {lo}-{hi}: {len(seqs)} delivered, missing {missing or 'none'}, duplicates {dups or 'none'}")
print(f"via RF: {len(rf)} {('seq %d-%d' % (rf[0], rf[-1])) if rf else ''}")
if lat:
    print(f"RF delivery delay (ts -> broker): min {min(lat):.1f} s, max {max(lat):.1f} s")
for t, s, tr, ts in rx:
    if t_cut - 4 <= t <= t_restore + AFTER_S:
        print(f"{t - t_cut:6.1f}s seq {s:4d} {tr:4s} (reading taken at {ts - t_cut:6.1f}s)")
