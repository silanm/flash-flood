"""Bytes on the wire for one level reading: MQTT (mosquitto_pub) vs HTTP POST (curl), captured with tcpdump on lo.
Runs on the platform container. Reads MQTT_USER / MQTT_PASS from the environment (never printed).
IP-layer bytes = IP + TCP headers + application data, both directions; no Ethernet/WiFi framing.
Usage: MQTT_USER=.. MQTT_PASS=.. python3 mqtt_vs_http.py [N]"""
import http.server, os, re, subprocess, sys, threading, time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 100
PAYLOAD = ('{"seq":149,"ts":"2026-11-06T17:39:47.324Z","distance_cm":31.4,"filtered_cm":31.4,'
           '"temp_c":26.19,"rh_pct":71.40,"transport":"wifi","rssi":-34}')   # a real node01 reading, 7 Nov
TOPIC = "farm/bench/node/sim01/benchmark"     # inside sim01's ACL subtree; no flow subscribes to "benchmark"
HTTP_PORT, MQTT_PORT = 8099, 1883
U, P = os.environ["MQTT_USER"], os.environ["MQTT_PASS"]


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(204); self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, *a): pass


def capture(port, fn):
    """Run fn() while tcpdump records port on lo; return (packets, IP bytes, app bytes)."""
    p = subprocess.Popen(["tcpdump", "-i", "lo", "-n", "-v", "-l", f"tcp port {port}"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    lines = []
    t = threading.Thread(target=lambda: lines.extend(p.stdout)); t.start()
    time.sleep(1.0); fn(); time.sleep(1.0); p.terminate(); t.join()
    txt = "".join(lines)
    ip = [int(x) for x in re.findall(r"proto TCP \(6\), length (\d+)", txt)]
    app = [int(x) for x in re.findall(r", length (\d+)\s*$", txt, re.M)]   # TCP payload length per packet
    return len(ip), sum(ip), sum(app)


def mqtt_persistent():   # one session, N publishes paced 50 ms apart (the node sends one reading per 2 s, never batched)
    p = subprocess.Popen(["mosquitto_pub", "-h", "127.0.0.1", "-u", U, "-P", P, "-q", "0", "-t", TOPIC, "-l"],
                         stdin=subprocess.PIPE, text=True)
    for _ in range(N):
        p.stdin.write(PAYLOAD + "\n"); p.stdin.flush(); time.sleep(0.05)
    p.stdin.close(); p.wait()

def mqtt_per_msg():      # connect, publish, disconnect for every reading
    for _ in range(N):
        subprocess.run(["mosquitto_pub", "-h", "127.0.0.1", "-u", U, "-P", P, "-q", "0", "-t", TOPIC, "-m", PAYLOAD], check=True)

def http_keepalive():    # one TCP connection, N POSTs (curl reuses the connection across --next groups)
    one = ["-s", "-o", "/dev/null", "-u", "node01:xxxxxxxxxxxxxxxx", "-H", "Content-Type: application/json",
           "--data", PAYLOAD, f"http://127.0.0.1:{HTTP_PORT}/api/v1/level"]
    args = ["curl"] + one
    for _ in range(N - 1):
        args += ["--next"] + one
    subprocess.run(args, check=True)

def http_per_msg():      # new TCP connection per POST (a simple HTTP client)
    for _ in range(N):
        subprocess.run(["curl", "-s", "-o", "/dev/null", "-u", "node01:xxxxxxxxxxxxxxxx", "-H", "Content-Type: application/json",
                        "--data", PAYLOAD, f"http://127.0.0.1:{HTTP_PORT}/api/v1/level"], check=True)


srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print(f"payload {len(PAYLOAD)} B, N = {N} messages, {time.strftime('%Y-%m-%dT%H:%M:%S%z')}")
print(f"{'case':28} {'pkts/msg':>9} {'IP B/msg':>9} {'app B/msg':>10} {'IP overhead vs payload':>23}")
for name, port, fn in [("MQTT QoS0, one session", MQTT_PORT, mqtt_persistent), ("MQTT QoS0, connect per msg", MQTT_PORT, mqtt_per_msg),
                       ("HTTP/1.1 POST, keep-alive", HTTP_PORT, http_keepalive), ("HTTP/1.1 POST, connect per msg", HTTP_PORT, http_per_msg)]:
    n, ipb, appb = capture(port, fn)
    print(f"{name:28} {n / N:9.2f} {ipb / N:9.1f} {appb / N:10.1f} {ipb / N / len(PAYLOAD):22.2f}x")
srv.shutdown()
