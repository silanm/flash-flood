#!/usr/bin/env python3
"""Edge vs cloud_only alarm latency on the real Pi hub, by replaying a recorded rise (Section V).

Runs on the Pi (~/ff-hub/.venv/bin/python). The ESP32 must be OFF: the replay publishes as node01.
Each run:
  1. flat water (5 cm) until the hub shows NORMAL, then at least 50 s more (rate history needs 45 s);
  2. the recorded slow rise of take 2 (replay_profile_take2.json), one reading per 2 s, fresh seq and ts;
  3. wait up to TAIL_S for WARNING and CRITICAL on hub/state, then acknowledge (silences the buzzer).
Latency = time hub/state reached the severity - time this script published the reading that triggered it
(edge: hub/state trace.seq; cloud_only: seq in the platform's retained alert). One clock: this Pi.

Link condition (applied here, always removed on exit), on the Pi <-> platform path only:
  clean     nothing
  impaired  netem delay 200 ms + 10 % loss, both directions, on tailscale0 (ifb0 for ingress)
  down      nftables drops traffic to/from the platform broker (PLATFORM_IP:1883)

Uplink/downlink bytes to the platform broker are counted per run (nft counters, from the start of the rise
to the end of the tail): edge and cloud_only both forward every reading, so the difference is the decision traffic.

Usage (detached, so a slow SSH session under "impaired" cannot kill it half-way):
  sudo PLATFORM_IP=<ip> setsid nohup ~/ff-hub/.venv/bin/python replay_latency.py <edge|cloud_only> <clean|impaired|down> [runs=5] \
       >> ~/ff-hub/replay.log 2>&1 < /dev/null &
Output: one CSV row per run in ~/ff-hub/replay.log and appended to ~/ff-hub/replay_results.csv
Manual cleanup if it ever dies hard:
  sudo tc qdisc del dev tailscale0 root; sudo tc qdisc del dev tailscale0 handle ffff: ingress; sudo ip link del ifb0;
  sudo nft delete table inet ffreplay; sudo nft delete table inet ffcount;
  mosquitto_pub -u hub -P <pw> -r -t farm/ait/hub/mode -m edge
"""
import atexit, csv, json, os, signal, subprocess, sys, threading, time
from datetime import datetime, timezone
import paho.mqtt.client as mqtt

MODE, COND = sys.argv[1], sys.argv[2]
RUNS = int(sys.argv[3]) if len(sys.argv) > 3 else 5
assert MODE in ("edge", "cloud_only") and COND in ("clean", "impaired", "down")
SITE, NODE = "ait", "node01"
PLATFORM_IP = os.environ["PLATFORM_IP"]   # Tailscale IP of the platform container
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = json.load(open(os.path.join(HERE, "replay_profile_take2.json")))
RISE_FROM = 40            # profile index where the flat start ends (the lead-in replaces it)
FLAT_CM, TEMP_C = 31.6, 26.4
TAIL_S, CLEAR_TIMEOUT_S, MIN_FLAT_S = 90, 180, 50
OUT = os.path.expanduser("~pi/ff-hub/replay_results.csv")
env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~pi/ff-hub/hub.env")) if "=" in l and not l.startswith("#"))

T = f"farm/{SITE}"
lock = threading.Lock()
state = {"sev": None, "events": [], "plat_seq": None}   # events: (t, sev, trigger seq)
pub_t = {}                                               # seq -> publish time


def on_message(c, u, m):
    now = time.time()
    try:
        p = json.loads(m.payload)
    except Exception:
        return
    with lock:
        if m.topic == f"{T}/platform/alert/{NODE}":
            if isinstance(p.get("seq"), int):
                state["plat_seq"] = p["seq"]
        elif m.topic == f"{T}/hub/state" and p.get("node") == NODE:
            sev = p.get("sev")
            if state["sev"] is not None and sev is not None and sev > state["sev"]:
                trig = (p.get("trace") or {}).get("seq") if MODE == "edge" else state["plat_seq"]
                state["events"].append((now, sev, trig))
            state["sev"] = sev


c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ff-replay-latency")
c.username_pw_set(env["MQTT_USER"], env["MQTT_PASS"])
c.on_message = on_message
c.connect("127.0.0.1", 1883, 30)
c.subscribe([(f"{T}/hub/state", 0), (f"{T}/platform/alert/{NODE}", 0)])
c.loop_start()


def sh(cmd, check=False):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, check=check)


def link_on():   # remove any impairment (idempotent)
    sh("tc qdisc del dev tailscale0 root; tc qdisc del dev tailscale0 handle ffff: ingress; ip link del ifb0")
    sh("nft delete table inet ffreplay")


def counters_on():   # byte counters on the bridge connection, before any drop rule (priority -10 < 0)
    sh("nft delete table inet ffcount")
    sh("nft add table inet ffcount", check=True)
    sh("nft add chain inet ffcount out '{ type filter hook output priority -10; }'", check=True)
    sh("nft add chain inet ffcount inp '{ type filter hook input priority -10; }'", check=True)
    sh(f"nft add rule inet ffcount out ip daddr {PLATFORM_IP} tcp dport 1883 counter", check=True)
    sh(f"nft add rule inet ffcount inp ip saddr {PLATFORM_IP} tcp sport 1883 counter", check=True)


def counters_read():
    """(bytes out, bytes in) since the last reset, then reset."""
    js = json.loads(sh("nft -j list table inet ffcount").stdout or "{}")
    got = {}
    for item in js.get("nftables", []):
        r = item.get("rule")
        if r:
            for e in r.get("expr", []):
                if "counter" in e:
                    got[r["chain"]] = e["counter"]["bytes"]
    sh("nft reset rules table inet ffcount")   # "reset counters" only resets named counters, not these rule counters
    return got.get("out", ""), got.get("inp", "")


def cleanup():
    link_on()
    sh("nft delete table inet ffcount")
    try:   # never leave the rig in the baseline mode, also after a crash
        c.publish(f"{T}/hub/mode", "edge", qos=1, retain=True).wait_for_publish(3)
    except Exception:
        pass


def link_set():
    link_on()
    if COND == "impaired":
        for cmd in ("modprobe ifb", "ip link add ifb0 type ifb", "ip link set ifb0 up",
                    "tc qdisc add dev tailscale0 root netem delay 200ms loss 10%",
                    "tc qdisc add dev tailscale0 handle ffff: ingress",
                    "tc filter add dev tailscale0 parent ffff: matchall action mirred egress redirect dev ifb0",
                    "tc qdisc add dev ifb0 root netem delay 200ms loss 10%"):
            sh(cmd, check=True)
    elif COND == "down":
        sh("nft add table inet ffreplay", check=True)
        sh("nft add chain inet ffreplay out '{ type filter hook output priority 0; }'", check=True)
        sh("nft add chain inet ffreplay inp '{ type filter hook input priority 0; }'", check=True)
        sh(f"nft add rule inet ffreplay out ip daddr {PLATFORM_IP} tcp dport 1883 drop", check=True)
        sh(f"nft add rule inet ffreplay inp ip saddr {PLATFORM_IP} tcp sport 1883 drop", check=True)


atexit.register(cleanup)
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(sig, lambda *_: sys.exit(1))   # sys.exit runs the atexit cleanup
seq = [100000 + int(time.time()) % 100000]   # well clear of the node's own counter


def publish(dist, temp):
    seq[0] += 1
    s = seq[0]
    ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    body = {"seq": s, "ts": ts, "distance_cm": dist, "filtered_cm": dist, "temp_c": temp, "transport": "replay"}
    with lock:
        pub_t[s] = time.time()
    c.publish(f"{T}/node/{NODE}/level", json.dumps(body), qos=0)
    return s


def wait_until(pred, timeout, dist=FLAT_CM, tick=2.0):
    """Keep the water at dist (one reading per tick) until pred() or timeout."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        publish(dist, TEMP_C)
        time.sleep(tick)
        with lock:
            if pred():
                return True
    return False


c.publish(f"{T}/hub/mode", MODE, qos=1, retain=True)
time.sleep(3)
writer_new = not os.path.exists(OUT)
out = open(OUT, "a", newline="")
w = csv.writer(out)
cols = ["ts", "mode", "condition", "run", "warn_ms", "warn_seq", "crit_ms", "crit_seq", "up_bytes", "down_bytes", "rise_s", "note"]
counters_on()
if writer_new:
    w.writerow(cols)
print(",".join(cols), flush=True)

for run in range(1, RUNS + 1):
    link_on()   # flat lead-in with a clean link, so every run starts from the same NORMAL state
    ok = wait_until(lambda: state["sev"] == 0, CLEAR_TIMEOUT_S)
    t_flat = time.time()
    while time.time() - t_flat < MIN_FLAT_S:
        publish(FLAT_CM, TEMP_C); time.sleep(2)
    link_set()
    time.sleep(2)
    with lock:
        state["events"].clear()
    counters_read()   # reset: count only the rise and the tail
    t_rise = time.time()
    for i in range(RISE_FROM, len(PROFILE["distance_cm"])):
        publish(PROFILE["distance_cm"][i], PROFILE["temp_c"][i] or TEMP_C); time.sleep(2)
    wait_until(lambda: any(e[1] >= 2 for e in state["events"]), TAIL_S, dist=PROFILE["distance_cm"][-1])   # the water stays high
    with lock:
        ev = list(state["events"])
        pt = dict(pub_t)
    up_b, down_b = counters_read()
    rise_s = round(time.time() - t_rise)

    def lat(level):
        e = next((e for e in ev if e[1] >= level), None)
        if not e:
            return "", ""
        return (round((e[0] - pt[e[2]]) * 1000) if e[2] in pt else ""), (e[2] or "")

    wm, ws = lat(1)
    cm, cs = lat(2)
    note = "" if ok else "did not return to NORMAL before the run"
    row = [datetime.now().isoformat(timespec="seconds"), MODE, COND, run, wm, ws, cm, cs, up_b, down_b, rise_s, note]
    w.writerow(row); out.flush()
    print(",".join(map(str, row)), flush=True)
    if state["sev"]:
        c.publish(f"{T}/hub/ack", json.dumps({"ackBy": "replay", "ts": int(time.time() * 1000)}), qos=1)

cleanup()
time.sleep(1)
c.loop_stop()
