#!/usr/bin/env python3
"""
Flash Flood hub - hardware I/O daemon (Raspberry Pi 4).

Owns all hub hardware and talks to Node-RED only over MQTT. Since 2026-10-23 it follows the
teammate's hub/state contract (github.com/silanm/flash-flood, docs/PI_SETUP.md section 2):
  subscribes  farm/<site>/hub/state  retained, refreshed >= every 10 s by the "hub logic" flow:
              {led: green|amber|red, blink: bool, buzzer: off|warning|critical|fault,
               lcd: [4 lines <= 20 chars], ...}
  subscribes  farm/<site>/node/+/level  (only for the diagnostics page)
  publishes   farm/<site>/hub/ack    {"ackBy": "button", "ts": <ms>}  (button press while the buzzer sounds)
LCD pages (v4, 2026-11-05): page 1 = the flows' 4 lines, with the status word right-aligned on line 1;
page 2 = diagnostics (Pi WiFi SSID and RSSI, IP, last node reading, cloud bridge, CPU temp or under-voltage).
A button press acks while the buzzer sounds; otherwise it flips the page. Page 2 falls back to page 1
after DIAG_TIMEOUT_S, and at once when a new alarm starts sounding.
WiFi setup (ff_wifi_portal.py): while /run/ff-hub/wifi-setup.json exists the LCD shows the setup steps
(the LED and buzzer still follow hub/state). Holding the button WIFI_RESET_HOLD_S starts
ff-wifi-reset.service: forget all saved WiFi and open the "FF-Hub-Setup" portal.

Hardware (Build_Log.md section 1, as rewired):
  LCD 20x4 PCF8574  I2C bus 3 (GPIO4 SDA / GPIO5 SCL), addr 0x27, VCC 3.3 V
  Buzzer MH-FMD     GPIO18, ACTIVE-LOW (LOW = sound), VCC 3.3 V
  RGB LED HW-479    R/G/B = GPIO22/23/24, common cathode
  Ack button        GPIO17 -> GND, internal pull-up
MQTT login: MQTT_USER / MQTT_PASS from /home/pi/ff-hub/hub.env (mode 600), if present.
"""

import atexit
import json
import os
import signal
import subprocess
import sys
import threading
import time

import paho.mqtt.client as mqtt
from gpiozero import Button, DigitalOutputDevice, RGBLED
from smbus2 import SMBus

SITE = "ait"
BROKER = "localhost"
TOPIC_STATE = f"farm/{SITE}/hub/state"
TOPIC_ACK = f"farm/{SITE}/hub/ack"
TOPIC_LEVEL = f"farm/{SITE}/node/+/level"
ENV_FILE = "/home/pi/ff-hub/hub.env"

LCD_BUS, LCD_ADDR = 3, 0x27
PIN_BUZZER, PIN_BTN = 18, 17
PIN_R, PIN_G, PIN_B = 22, 23, 24

STALE_S = 35          # flows refresh hub/state every 10 s; silence this long -> hub logic is down
WIFI_STATUS = "/run/ff-hub/wifi-setup.json"
WIFI_RESET_HOLD_S = 8
DIAG_TIMEOUT_S = 30   # page 2 -> page 1 by itself
SYS_POLL_S = 5        # diagnostics refresh (subprocesses run in their own thread, never in the alarm loop)
STATUS_WORDS = ("NORMAL", "WARNING", "CRITICAL")   # index = hub/state "sev"
SENSOR_WORDS = {"stale": "no data", "degraded": "bad data"}   # hub/state "reason" -> LCD
LINK_WORDS = {"wifi": "WiFi", "rf": "RF"}   # how the last reading reached the Pi (level "transport")
LINK_FRESH_S = 10     # older than this -> the link shows "--"

COLORS = {
    "green":  (0, 1, 0),
    "amber":  (1, 0.35, 0),
    "red":    (1, 0, 0),
    "nodata": (0, 0, 1),
}
# (on, off, on, off, ...) seconds, repeated
BEEPS = {
    "warning":  (0.2, 1.8),               # slow beep
    "critical": (0.15, 0.15),             # fast beep
    "fault":    (0.08, 0.12, 0.08, 1.7),  # double chirp
}


# ---------------------------------------------------------------- LCD
class Lcd:
    BL, EN, RS = 0x08, 0x04, 0x01
    ROWS = (0x00, 0x40, 0x14, 0x54)

    def __init__(self, bus, addr):
        self.bus, self.addr = SMBus(bus), addr
        time.sleep(0.05)
        for v in (0x30, 0x30, 0x30, 0x20):
            self._w4(v)
            time.sleep(0.005)
        for c in (0x28, 0x0C, 0x01, 0x06):
            self._send(c)
            time.sleep(0.002)
        self.shown = [None] * 4

    def _w4(self, v):
        self.bus.write_byte(self.addr, v | self.BL)
        self.bus.write_byte(self.addr, v | self.BL | self.EN)
        time.sleep(0.0005)
        self.bus.write_byte(self.addr, (v | self.BL) & ~self.EN)
        time.sleep(0.0001)

    def _send(self, v, mode=0):
        self._w4(mode | (v & 0xF0))
        self._w4(mode | ((v << 4) & 0xF0))

    def show(self, lines):
        """Rewrite only the rows that changed (avoids flicker)."""
        for i, text in enumerate(lines[:4]):
            text = text.ljust(20)[:20]
            if text == self.shown[i]:
                continue
            self._send(0x80 | self.ROWS[i])
            for ch in text:
                self._send(ord(ch) if 32 <= ord(ch) < 127 else ord("?"), self.RS)
            self.shown[i] = text


# ---------------------------------------------------------------- hardware
buzzer = DigitalOutputDevice(PIN_BUZZER, active_high=False, initial_value=False)
led = RGBLED(PIN_R, PIN_G, PIN_B)
button = Button(PIN_BTN, pull_up=True, bounce_time=0.05, hold_time=WIFI_RESET_HOLD_S)
lcd = Lcd(LCD_BUS, LCD_ADDR)


def buzzer_safe():
    """Leave GPIO18 driven HIGH (silent) even after gpiozero releases it."""
    try:
        buzzer.off()
    except Exception:
        pass
    subprocess.run(["pinctrl", "set", str(PIN_BUZZER), "op", "pu", "dh"], check=False)


atexit.register(buzzer_safe)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

# ---------------------------------------------------------------- state
lock = threading.Lock()
state = {}             # last farm/<site>/hub/state payload
state_rx = 0.0         # time.time() when it arrived
local_silence = None   # buzzer pattern that was sounding when the button was pressed
page, page_t = 0, 0.0  # 0 = status (flows), 1 = diagnostics; page_t = when page 2 was opened
nodes = {}             # node -> (rx time, transport, temp_c) of its last level reading
sysinfo = {}           # filled by sys_poller()
acked_at = {}          # "acked" / "sensorAcked" -> "HH:MM" when the flag last went false -> true

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ff-hub-io")


def load_env(path=ENV_FILE):
    env = {}
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def on_connect(c, userdata, flags, reason, props):
    print(f"[MQTT] connected ({reason})", flush=True)
    c.subscribe(TOPIC_STATE, qos=1)
    c.subscribe(TOPIC_LEVEL, qos=0)


def on_message(c, userdata, msg):
    global state, state_rx, local_silence
    try:
        data = json.loads(msg.payload)
    except ValueError:
        return
    if not isinstance(data, dict):
        return
    if msg.topic != TOPIC_STATE:   # a node reading, kept for the diagnostics page
        with lock:
            nodes[msg.topic.split("/")[3]] = (time.time(), data.get("transport"), data.get("temp_c"))
        return
    with lock:
        for flag in ("acked", "sensorAcked"):   # remember when each ack landed (unknown for the first state after a restart)
            if data.get(flag) and not state.get(flag):
                acked_at[flag] = time.strftime("%H:%M") if state else None
        state, state_rx = data, time.time()
        if local_silence and data.get("buzzer") != local_silence:
            local_silence = None   # pattern changed (ack applied, or a new alert) -> follow the flows again


def on_button():
    global local_silence, page, page_t
    with lock:
        sounding = state.get("buzzer", "off") != "off" and local_silence is None
        if not sounding:           # nothing to silence: the press flips the LCD page
            page, page_t = 1 - page, time.time()
            print(f"[BTN] LCD page {page + 1}", flush=True)
            return
        local_silence = state.get("buzzer", "off")
        page = 0
    buzzer.off()   # silence at once; the flows confirm with buzzer "off"
    payload = json.dumps({"ackBy": "button", "ts": int(time.time() * 1000)})
    client.publish(TOPIC_ACK, payload, qos=1)
    print(f"[BTN] ack -> {TOPIC_ACK} {payload}", flush=True)


def on_button_held():
    print(f"[BTN] held {WIFI_RESET_HOLD_S} s -> WiFi reset + setup portal", flush=True)
    subprocess.run(["sudo", "-n", "systemctl", "start", "--no-block", "ff-wifi-reset.service"], check=False)


def wifi_setup_lines():
    """LCD lines while the WiFi portal runs, else None."""
    try:
        w = json.load(open(WIFI_STATUS))
    except (OSError, ValueError):
        return None
    st, target = w.get("state"), str(w.get("target", ""))[:20]
    if st == "connecting":
        return ["WiFi: connecting to", target, "please wait...", ""]
    if st == "connected":
        return ["WiFi connected:", target, str(w.get("ip", ""))[:20], ""]
    if st == "failed":
        return ["WiFi FAILED:", target, "wrong password?", "portal reopening..."]
    if st == "error":
        return ["WiFi setup ERROR", str(w.get("note", ""))[:20], "", ""]
    return ["WiFi setup: join", str(w.get("ap_ssid", ""))[:20], ("pass " + str(w.get("ap_pass", "")))[:20],
            ("open " + str(w.get("url", ""))[7:])[:20]]


def run(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=4).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def sys_poller():
    """Refresh the diagnostics every SYS_POLL_S: WiFi, IP, cloud bridge, CPU temperature, under-voltage."""
    while True:
        info = {"ssid": None, "dbm": None, "ip": None, "cloud": False, "cpu": None, "undervolt": False}
        for line in run("nmcli", "-t", "-f", "ACTIVE,SSID", "device", "wifi", "list", "ifname", "wlan0",
                        "--rescan", "no").splitlines():
            if line.startswith("yes:"):
                info["ssid"] = line[4:].replace("\\:", ":")
        try:
            for line in open("/proc/net/wireless"):
                if line.strip().startswith("wlan0:"):
                    info["dbm"] = int(float(line.split()[3]))
        except (OSError, ValueError, IndexError):
            pass
        for dev in ("wlan0", "eth0"):
            parts = run("ip", "-4", "-o", "addr", "show", dev).split()
            if "inet" in parts:
                info["ip"] = parts[parts.index("inet") + 1].split("/")[0]
                break
        # the bridge is the only outgoing MQTT connection that does not go to this host
        for line in run("ss", "-Htn", "state", "established", "( dport = :1883 )").splitlines():
            peer = line.split()[-1] if line.split() else ""
            if peer and not peer.startswith(("127.", "[::1]")):
                info["cloud"] = True
        try:
            info["cpu"] = int(open("/sys/class/thermal/thermal_zone0/temp").read()) // 1000
        except (OSError, ValueError):
            pass
        out = run("vcgencmd", "get_throttled")
        if "=" in out:
            try:
                info["undervolt"] = bool(int(out.split("=")[1], 16) & 0x1)   # bit 0 = under-voltage now
            except ValueError:
                pass
        with lock:
            sysinfo.clear()
            sysinfo.update(info)
        time.sleep(SYS_POLL_S)


def fit(left, right=""):
    """One 20-char LCD line: left text, right text flush right (left is cut to make room)."""
    left, right = str(left), str(right)[:20]
    return left[:20 - len(right) - (1 if right else 0)].ljust(20 - len(right)) + right


def status_line(line):
    """'node01 NORMAL' -> 'node01        NORMAL'; anything else unchanged."""
    head, _, word = line.rstrip().rpartition(" ")
    return fit(head, word) if head and word in STATUS_WORDS else line


def status_lines(s, lines, now):
    """Page 1 from the hub/state fields, so a sensor fault, the node link and an ack say what they are:
    'node01         FAULT' / 'Sensor no data    --' / 'Acked SENSOR   20:45'. Falls back to the flows' lines."""
    sev = s.get("sev")
    if not isinstance(sev, int) or not 0 <= sev < len(STATUS_WORDS):
        return [status_line(lines[0])] + lines[1:]
    fault = s.get("sensor") == "fault"
    flood_acked, sensor_acked = sev > 0 and s.get("acked"), fault and s.get("sensorAcked")
    word = STATUS_WORDS[sev] if sev or not fault else "FAULT"   # a dead sensor must never read NORMAL
    node = s.get("node") or lines[0].split(" ")[0]
    out = [fit(node, word), lines[1], lines[2], lines[3]]
    with lock:
        seen = nodes.get(node)
    link = LINK_WORDS.get(seen[1], seen[1] or "?") if seen and now - seen[0] <= LINK_FRESH_S else "--"
    reason = s.get("reason")
    out[2] = fit(f"Sensor {SENSOR_WORDS.get(reason, reason or 'fault') if fault else 'ok'}", link)
    if (sev > 0 and not flood_acked) or (fault and not sensor_acked):
        out[3] = "Press button to ack"
    elif flood_acked or sensor_acked:
        what = [STATUS_WORDS[sev]] if flood_acked else []
        what += ["SENSOR"] if sensor_acked else []
        with lock:
            t = acked_at.get("acked" if flood_acked else "sensorAcked") or ""
        if len(what) == 2:
            what[0], t = what[0][:4], ""                 # "Acked CRIT+SENSOR": no room for the time
        out[3] = fit("Acked " + "+".join(what), t)
    return out


def diag_lines(now, node):
    with lock:
        si, seen = dict(sysinfo), nodes.get(node) if node else None
        if seen is None and nodes:
            node, seen = next(iter(nodes.items()))
    if not si:
        return ["DIAG", "reading system...", "", ""]
    wifi = fit(f"WiFi {si['ssid'] or 'DOWN'}", f"{si['dbm']}" if si["ssid"] and si["dbm"] is not None else "")
    ip = fit(f"IP {si['ip'] or '--'}", "2/2")
    if seen:
        rx, transport, temp = seen
        age = int(now - rx)
        node_line = fit(f"{node} {transport or '?'} {age if age < 1000 else '999+'}s",
                        f"{temp:.1f}C" if isinstance(temp, (int, float)) else "")
    else:
        node_line = fit(f"{node or 'node'} no data")
    power = "LOW VOLT!" if si["undervolt"] else (f"CPU {si['cpu']}C" if si["cpu"] is not None else "")
    return [wifi, ip, node_line, fit(f"Cloud {'OK' if si['cloud'] else 'DOWN'}", power)]


client.on_connect = on_connect
client.on_message = on_message
button.when_pressed = on_button
button.when_held = on_button_held


# ---------------------------------------------------------------- render
def render(now):
    """-> (led colour key, blink, buzzer pattern or None, 4 LCD lines)"""
    global page
    with lock:
        s, age, silenced = dict(state), now - state_rx, local_silence is not None
        if page and (now - page_t > DIAG_TIMEOUT_S or (s.get("buzzer", "off") != "off" and not silenced)):
            page = 0                                     # back to status: timeout, or a new alarm is sounding
        show_diag = page == 1

    if not s:
        lines = ["Flash Flood Hub", "Waiting for", "hub logic...", time.strftime("%H:%M:%S")]
        return "nodata", True, None, diag_lines(now, None) if show_diag else lines
    if age > STALE_S:   # never look safe when the flows have stopped
        lines = ["HUB LOGIC SILENT", f"no state for {int(age)}s", "check Node-RED", time.strftime("%H:%M:%S")]
        return "nodata", True, None, diag_lines(now, s.get("node")) if show_diag else lines

    pattern = s.get("buzzer", "off")
    beep = None if silenced or pattern == "off" else BEEPS.get(pattern, BEEPS["critical"])
    lines = [str(x) for x in (s.get("lcd") or [])][:4]
    lines += [""] * (4 - len(lines))
    lines = status_lines(s, lines, now)
    if show_diag:
        lines = diag_lines(now, s.get("node"))
    return s.get("led", "amber"), bool(s.get("blink")), beep, lines


def main():
    env = load_env()
    if env.get("MQTT_USER"):
        client.username_pw_set(env["MQTT_USER"], env.get("MQTT_PASS"))
    client.connect_async(BROKER, 1883, keepalive=30)
    client.loop_start()
    threading.Thread(target=sys_poller, daemon=True).start()
    beep_key, beep_i, beep_t = None, 0, 0.0
    last_draw = 0.0
    while True:
        now = time.time()
        colour, blink, beep, lines = render(now)
        on = not blink or int(now * 2) % 2 == 0          # blink at 1 Hz
        led.color = COLORS.get(colour, COLORS["amber"]) if on else (0, 0, 0)

        if beep is None:
            if buzzer.value:
                buzzer.off()
            beep_key = None
        else:
            if beep != beep_key:                          # new pattern: start with a beep
                beep_key, beep_i, beep_t = beep, 0, now
                buzzer.on()
            elif now - beep_t >= beep[beep_i]:
                beep_i, beep_t = (beep_i + 1) % len(beep), now
                buzzer.value = beep_i % 2 == 0            # even index = sound

        if now - last_draw >= 0.5:
            lines = wifi_setup_lines() or lines
            try:
                lcd.show(lines)
            except OSError as e:   # loose I2C wire must not kill the alarm path
                print(f"[LCD] {e}", flush=True)
            last_draw = now
        time.sleep(0.02)


if __name__ == "__main__":
    print("[HUB] hub_io starting", flush=True)
    main()
