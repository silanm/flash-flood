# Pi hub: setup (for Pongpada)

The Pi runs the **same filter and alert code as the container**, packaged as Node-RED flows (core nodes only). It has two modes:
`edge` (the proposed design: the Pi decides) and `cloud_only` (baseline A for the evaluation: the Pi relays and obeys the container).
Design and decisions: `ARCHITECTURE.md` section 14. Nothing here has run on a real Pi yet; it is tested on a fake clock against the simulator.

## 1. Install
1. Mosquitto and Node-RED on the Pi. In Mosquitto, make a user for the flows (and the ESP32) and enable passwords, as on the container (`scripts/mosquitto-auth.sh`).
2. Node-RED menu > Import > `nodered/pi.flows.json`. Open the **hub broker** node, enter that Mosquitto user and password. Deploy.
3. Bridge to the container: copy `mosquitto/pi-bridge.conf.example` to `/etc/mosquitto/conf.d/flood-bridge.conf`, set the `hub` password (Sila sends it), restart Mosquitto.
4. The ESP32 publishes to the **Pi's** broker, topic `farm/<site>/node/<nodeID>/level`, as in `ARCHITECTURE.md` section 4. RF readings must be republished onto the same topic with `"transport":"rf"`.

## 2. What the flows publish (all on the Pi's broker, bridged to the container)
| Topic | When | Payload |
|---|---|---|
| `farm/<site>/hub/heartbeat` | every 30 s | `{"ts":"...","mode":"edge"}` |
| `farm/<site>/hub/alert` | edge mode: a WARNING / CRITICAL / sensor fault is raised | `{"severity":"warning","node":"sim01","kind":"rate","level":8.0,"rate":1.25,"seq":88,"ts":"..."}` |
| `farm/<site>/hub/state` | retained; on any change and at least every 10 s | below |

`hub/state` is what **your GPIO / I2C flows should drive**:
```json
{"node":"sim01","mode":"edge","sev":1,"sensor":"ok","led":"amber","blink":false,"buzzer":"warning",
 "lcd":["sim01 WARNING","Lvl 8.0cm +1.3/m","Sensor: ok","Press button to ack"],"level_cm":8.0,"rate_cm_min":1.25,"ts":1792576950000}
```
- `led`: `green` / `amber` / `red` for the RGB LED. `blink: true` means a sensor fault: blink it (amber when the flood state is normal, so it never looks safe).
- `buzzer`: `off` / `warning` (slow beep) / `critical` (fast or continuous) / `fault` (a distinct pattern). It goes `off` after the button press.
- `lcd`: four lines of at most 20 characters, write them as they are.
- The **button** should publish `farm/<site>/hub/ack` with `{"ackBy":"button"}`. The flows silence the buzzer and keep the alert.

## 3. Switching modes (baseline A)
- In the Node-RED editor, click the inject button **mode: cloud_only (baseline A)** or **mode: edge**, or from a shell:
  `mosquitto_pub -u <user> -P <pw> -r -t farm/demo/hub/mode -m cloud_only`
- The choice is retained, so it survives a restart. Switching to `edge` starts with clean alert memory.
- `cloud_only`: readings are only relayed (by the bridge); the Pi publishes no `hub/alert` and drives the hardware from the container's `platform/alert|sensor` states.
- Each `hub/state` that follows a new alert carries `"trace":{"seq":88,"rx_ms":...}`: `ts - trace.rx_ms` is the time from that reading reaching the Pi to the alarm
  being set, measured on the Pi's one clock. This is the latency number for Section V.

## 4. Not done here
GPIO, I2C LCD and buzzer drivers; the RF receiver; Mosquitto passwords on the Pi; the bridge has never been run. Those are yours; the contract above is all they need.
