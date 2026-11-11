#!/usr/bin/env python3
"""Flash Flood hub - WiFi setup portal (no screen or keyboard needed), like the ESP32's WiFiManager.

The Pi opens its own access point "FF-Hub-Setup" (password "floodhub"). A phone joins it, the captive
portal page opens (or browse to http://10.42.0.1), the user picks a WiFi network and types its password.
The Pi then joins that network and saves it (NetworkManager). Progress is shown on the hub LCD by
hub_io.py, which reads STATUS_FILE.

Modes (run as root):
  boot    at boot: wait up to BOOT_WAIT_S for wlan0 to join a saved network; open the portal only if it
          did not. A WiFi that drops LATER never opens the portal (the demo turns the phone hotspot off
          on purpose; the Pi must rejoin it when it comes back).
  start   open the portal now (saved networks kept)
  reset   forget every saved WiFi network, then open the portal (demo: "show how to connect")
  dry     serve the page on port 8099 without touching the network (for testing)

Without a successful connection the portal closes after PORTAL_TIMEOUT_S if a saved network exists
(NetworkManager then rejoins it). After a reset, the forgotten networks are kept in RESTORE_FILE (root
only) and put back at that timeout, so a portal problem can never lock the Pi out for good.
Requires: NetworkManager, dnsmasq-base. No pip packages.
"""
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IFACE = "wlan0"
AP_CON = "ff-setup"
AP_SSID = "FF-Hub-Setup"
AP_PASS = "floodhub"
AP_IP = "10.42.0.1"
BOOT_WAIT_S = 60
PORTAL_TIMEOUT_S = int(os.environ.get("FF_PORTAL_TIMEOUT_S", "600"))   # env override for tests
STATUS_DIR = "/run/ff-hub"
STATUS_FILE = f"{STATUS_DIR}/wifi-setup.json"
CAPTIVE_DNS = "/etc/NetworkManager/dnsmasq-shared.d/ff-captive.conf"
RESTORE_FILE = "/var/lib/ff-hub/wifi-restore.json"


def log(*a):
    print("[WIFI]", *a, flush=True)


def nm(*args, timeout=40):
    """Run nmcli with an argv list (never a shell: SSIDs and passwords are user input)."""
    r = subprocess.run(["nmcli", *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout + r.stderr).replace("\r", "\n").strip()   # --wait progress uses \r


def set_status(state, **kw):
    os.makedirs(STATUS_DIR, exist_ok=True)
    os.chmod(STATUS_DIR, 0o755)
    tmp = STATUS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"state": state, "ap_ssid": AP_SSID, "ap_pass": AP_PASS, "url": f"http://{AP_IP}",
                   "t": time.time(), **kw}, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, STATUS_FILE)


def clear_status():
    try:
        os.remove(STATUS_FILE)
    except FileNotFoundError:
        pass


def wifi_connected():
    rc, out = nm("-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device")
    for line in out.splitlines():
        dev, typ, state, con = (line.split(":") + ["", "", "", ""])[:4]
        if dev == IFACE and state == "connected" and con != AP_CON:
            return con
    return None


def saved_wifi():
    rc, out = nm("-t", "-f", "NAME,TYPE", "connection", "show")
    return [l.rsplit(":", 1)[0].replace("\\:", ":") for l in out.splitlines()
            if l.endswith(":802-11-wireless") and l.rsplit(":", 1)[0] != AP_CON]


def forget_all():
    """Delete saved WiFi profiles, keeping SSID/PSK in RESTORE_FILE for the timeout fallback."""
    keep = []
    for con in saved_wifi():
        # one field per call: with -g, nmcli prints each field on its own line
        ssid = nm("-g", "802-11-wireless.ssid", "connection", "show", con)[1]
        psk = nm("-s", "-g", "802-11-wireless-security.psk", "connection", "show", con)[1]
        keep.append({"ssid": ssid, "psk": psk})
        log(f"forgetting {con!r}")
        nm("connection", "delete", con)
    if keep:
        os.makedirs(os.path.dirname(RESTORE_FILE), mode=0o700, exist_ok=True)
        with open(os.open(RESTORE_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            json.dump(keep, f)
    subprocess.run(["sync"])


def restore_forgotten():
    try:
        keep = json.load(open(RESTORE_FILE))
    except (OSError, ValueError):
        return False
    ok = True
    for w in keep:
        args = ["connection", "add", "type", "wifi", "ifname", IFACE, "con-name", f"wifi-{w['ssid']}"[:60], "ssid", w["ssid"]]
        if w["psk"]:
            args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", w["psk"]]
        rc, out = nm(*args)
        ok &= rc == 0
        log(f"restored {w['ssid']!r}" if rc == 0 else "restore failed: " + out.splitlines()[0][:120].replace(w["psk"] or "\0", "***"))
    if ok:
        os.remove(RESTORE_FILE)   # keep it when anything failed, so nothing is lost
    subprocess.run(["sync"])
    return ok


def scan():
    nm("device", "wifi", "rescan", "ifname", IFACE, timeout=20)
    time.sleep(3)
    rc, out = nm("-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", IFACE)
    best = {}
    for line in out.splitlines():
        parts = line.replace("\\:", "\0").split(":")
        if len(parts) < 3:
            continue
        ssid, sig, sec = (p.replace("\0", ":") for p in parts[:3])
        if ssid and ssid != AP_SSID and int(sig or 0) > best.get(ssid, (-1, ""))[0]:
            best[ssid] = (int(sig or 0), sec)
    return sorted(((s, v[0], v[1]) for s, v in best.items()), key=lambda x: -x[1])


def ap_up():
    os.makedirs(os.path.dirname(CAPTIVE_DNS), exist_ok=True)
    if not os.path.exists(CAPTIVE_DNS):
        with open(CAPTIVE_DNS, "w") as f:   # every name resolves to us -> phones show the portal
            f.write(f"address=/#/{AP_IP}\n")
    nm("connection", "delete", AP_CON)
    rc, out = nm("connection", "add", "save", "no", "type", "wifi", "ifname", IFACE, "con-name", AP_CON,
                 "autoconnect", "no", "ssid", AP_SSID, "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
                 "ipv4.method", "shared", "ipv4.addresses", f"{AP_IP}/24", "ipv6.method", "disabled",
                 "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", AP_PASS)
    if rc == 0:
        rc, out = nm("connection", "up", AP_CON)
    log("AP up" if rc == 0 else f"AP failed: {out}")
    return rc == 0


def ap_down():
    nm("connection", "delete", AP_CON)


# ---------------------------------------------------------------- web page
PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flash Flood Hub - WiFi</title><style>
body{{font-family:system-ui,sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#123}}
h1{{font-size:1.3em}} label{{display:block;margin:6px 0;padding:8px;border:1px solid #ccd;border-radius:6px}}
input[type=text],input[type=password]{{width:100%;padding:10px;margin:6px 0 12px;box-sizing:border-box;font-size:1em}}
button{{width:100%;padding:12px;font-size:1.05em;background:#0a6;color:#fff;border:0;border-radius:6px}}
.sig{{float:right;color:#678}} .msg{{padding:10px;background:#fee;border-radius:6px}}
</style></head><body><h1>Flash Flood Hub &ndash; WiFi setup</h1>{msg}
<form method="post" action="/connect"><p>Choose a network:</p>{nets}
<p>Or type its name (hidden network / phone hotspot not listed):</p>
<input type="text" name="manual" placeholder="Network name (SSID)" autocapitalize="none" autocorrect="off">
<input type="password" name="password" placeholder="WiFi password">
<button type="submit">Connect</button></form>
<p style="color:#678;font-size:.9em">After you press Connect, this hotspot closes for a moment. The hub LCD shows the result.
If it fails, the hotspot comes back: join {ap} again.</p></body></html>"""

DONE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connecting</title></head><body style="font-family:system-ui;max-width:420px;margin:24px auto;padding:0 16px">
<h1>Connecting to {ssid}&hellip;</h1><p>Watch the hub LCD. You can close this page.</p></body></html>"""


class Portal:
    def __init__(self, dry=False):
        self.dry = dry
        self.nets = []
        self.msg = ""
        self.done = threading.Event()
        self.busy = threading.Lock()

    def page(self):
        nets = "".join(
            f'<label><input type="radio" name="ssid" value="{html.escape(s, quote=True)}"> {html.escape(s)}'
            f'<span class="sig">{sig}%{" &#128274;" if sec and sec != "--" else ""}</span></label>'
            for s, sig, sec in self.nets) or "<p>(no networks found &ndash; type the name below)</p>"
        msg = f'<p class="msg">{html.escape(self.msg)}</p>' if self.msg else ""
        return PAGE.format(nets=nets, msg=msg, ap=AP_SSID)

    def connect(self, ssid, password):
        """Runs in a thread: drop the AP, try to join, come back on failure."""
        with self.busy:
            log(f"trying {ssid!r}")
            set_status("connecting", target=ssid)
            if self.dry:
                time.sleep(2)
                set_status("connected", target=ssid, ip="(dry run)")
                self.done.set()
                return
            ap_down()
            # Right after AP mode the radio has no scan results yet; wait until the network shows up
            # (a hidden network never does: the profile below has hidden=yes, so activation still finds it).
            seen = False
            for _ in range(8):
                rc, out = nm("-t", "-f", "SSID", "device", "wifi", "list", "ifname", IFACE, "--rescan", "yes", timeout=25)
                if ssid in [l.replace("\\:", ":") for l in out.splitlines()]:
                    seen = True
                    break
                time.sleep(3)
            log(f"{ssid!r} {'found' if seen else 'not in scan (hidden?)'}")
            # Explicit profile + activation: does not depend on the scan list, unlike "nmcli device wifi connect"
            con = f"wifi-{ssid}"[:60]
            args = ["connection", "add", "type", "wifi", "ifname", IFACE, "con-name", con, "ssid", ssid,
                    "802-11-wireless.hidden", "no" if seen else "yes"]
            if password:
                args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", password]
            rc, out = nm(*args)
            m = re.search(r"\(([0-9a-f-]{36})\)", out)
            uuid = m.group(1) if m else None
            if rc == 0 and uuid:
                rc, out = nm("--wait", "45", "connection", "up", "uuid", uuid, timeout=60)
            if rc == 0 and wifi_connected():
                subprocess.run(["sync"])
                rc2, ip = nm("-g", "IP4.ADDRESS", "device", "show", IFACE)
                ip = ip.split("/")[0]
                log(f"connected to {ssid!r}, {ip}")
                set_status("connected", target=ssid, ip=ip)
                if os.path.exists(RESTORE_FILE):
                    os.remove(RESTORE_FILE)   # the new network replaces the forgotten ones
                self.done.set()
                return
            err = next((l for l in out.splitlines() if "rror" in l), out.splitlines()[-1] if out else "")
            log(f"failed: {err.replace(password, '***') if password else err}"[:240])   # never log the password
            if uuid:   # drop only the profile made here (wrong password / out of range)
                nm("connection", "delete", "uuid", uuid)
            self.msg = f"Could not join {ssid}: wrong password or out of range. Try again."
            set_status("failed", target=ssid)
            time.sleep(3)
            ap_up()
            set_status("portal", note=f"failed: {ssid}")

    def handler(portal):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body="", ctype="text/html; charset=utf-8", loc=None):
                b = body.encode()
                self.send_response(code)
                if loc:
                    self.send_header("Location", loc)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(b)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if urllib.parse.urlsplit(self.path).path == "/" and self.headers.get("Host", "").split(":")[0] in (AP_IP, "localhost", "127.0.0.1"):
                    self.send(200, portal.page())
                else:   # captive-portal probes (generate_204, hotspot-detect, ...) and any other host
                    self.send(302, loc=f"http://{AP_IP}/")

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                f = urllib.parse.parse_qs(self.rfile.read(min(n, 4096)).decode(errors="replace"))
                ssid = (f.get("manual", [""])[0].strip() or f.get("ssid", [""])[0]).strip()[:32]
                pw = f.get("password", [""])[0][:64]   # 8-63 char passphrase, or a 64-hex raw PSK
                if not ssid or portal.busy.locked():
                    portal.msg = "Choose a network first." if not ssid else "Busy, wait a moment."
                    return self.send(302, loc=f"http://{AP_IP}/")
                portal.msg = ""
                self.send(200, DONE.format(ssid=html.escape(ssid)))
                threading.Thread(target=portal.connect, args=(ssid, pw), daemon=True).start()
        return H


def run_portal(dry=False):
    p = Portal(dry)
    log("scanning")
    p.nets = scan() if not dry else [("Example-WiFi", 80, "WPA2"), ("Phone <hotspot>", 55, "WPA2")]
    log(f"{len(p.nets)} networks")
    if not dry and not ap_up():
        set_status("error", note="AP failed")
        return 1
    set_status("portal")
    port = 8099 if dry else 80
    srv = ThreadingHTTPServer(("0.0.0.0", port), p.handler())
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"portal on :{port}")
    t0 = time.time()
    while not p.done.wait(5):
        if time.time() - t0 > PORTAL_TIMEOUT_S and not p.busy.locked():
            if not dry and restore_forgotten():
                log("timeout after a reset: forgotten networks restored")
            if saved_wifi() and not dry:
                log("timeout: closing the portal, NetworkManager rejoins a saved network")
                break
            t0 = time.time()   # nothing to fall back to: keep the portal open
    srv.shutdown()
    if not dry:
        ap_down()
    time.sleep(15 if p.done.is_set() else 0)   # leave "connected" on the LCD for a moment
    clear_status()
    return 0


def main():
    global STATUS_DIR, STATUS_FILE
    mode = sys.argv[1] if len(sys.argv) > 1 else "start"
    if mode == "dry":
        STATUS_DIR = "/tmp/ff-hub-dry"
        STATUS_FILE = f"{STATUS_DIR}/wifi-setup.json"
        return run_portal(dry=True)
    if os.geteuid() != 0:
        sys.exit("run as root")
    if mode == "boot":
        for _ in range(BOOT_WAIT_S // 2):
            con = wifi_connected()
            if con:
                log(f"on {con!r}: no portal needed")
                clear_status()
                return 0
            time.sleep(2)
        log(f"no WiFi after {BOOT_WAIT_S} s: opening the portal")
    elif mode == "reset":
        forget_all()
    elif mode != "start":
        sys.exit(__doc__)
    return run_portal()


if __name__ == "__main__":
    sys.exit(main())
