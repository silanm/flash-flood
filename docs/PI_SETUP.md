# Pi hub: setup (for Pongpada)

The Pi runs the same filter and alert code as the container. Node-RED flows that use core nodes only contain this code. The flows have two modes:
- `edge` (the proposed design): the Pi decides.
- `cloud_only` (baseline A for the evaluation): the Pi relays the readings and obeys the container.

`ARCHITECTURE.md` section 14 gives the design and the decisions. The flows never ran on a real Pi. The tests run them on a fake clock against the simulator.

## 1. Install
1. Install Mosquitto and Node-RED on the Pi. In Mosquitto, make a user for the flows and the ESP32. Enable passwords, as on the container (`scripts/mosquitto-auth.sh`).
2. In the Node-RED menu, choose Import and select `nodered/pi.flows.json`. Open the **hub broker** node. Enter the Mosquitto user and password. Deploy.
3. Bridge the Pi to the container. Copy `mosquitto/pi-bridge.conf.example` to `/etc/mosquitto/conf.d/flood-bridge.conf`. Set the `hub` password (Sila sends it). Restart Mosquitto.
4. The ESP32 publishes to the broker on the Pi. The topic is `farm/<site>/node/<nodeID>/level` (see `ARCHITECTURE.md` section 4). The gateway must republish RF readings on the same topic with `"transport":"rf"`.

## 2. What the flows publish
The flows publish on the Pi broker. The bridge sends the messages to the container.

| Topic | When | Payload |
|---|---|---|
| `farm/<site>/hub/heartbeat` | every 30 s | `{"ts":"...","mode":"edge"}` |
| `farm/<site>/hub/alert` | in edge mode, when the Pi raises a WARNING, a CRITICAL or a sensor fault | `{"severity":"warning","node":"sim01","kind":"rate","level":8.0,"rate":1.25,"seq":88,"ts":"..."}` |
| `farm/<site>/hub/state` | retained, at each change and at least every 10 s | see below |

Your GPIO and I2C flows must read `hub/state` and drive the hardware:
```json
{"node":"sim01","mode":"edge","sev":1,"sensor":"ok","led":"amber","blink":false,"buzzer":"warning",
 "lcd":["sim01 WARNING","Lvl 8.0cm +1.3/m","Sensor: ok","Press button to ack"],"level_cm":8.0,"rate_cm_min":1.25,"ts":1792576950000}
```
- `led` is `green`, `amber` or `red` for the RGB LED.
- `blink: true` means a sensor fault. Blink the LED. If the flood state is normal, the LED shows amber. It never looks safe.
- `buzzer` is `off`, `warning` (slow beep), `critical` (fast or continuous) or `fault` (a different pattern). The value changes to `off` after the button press.
- `lcd` has four lines of at most 20 characters. Write the lines as they are.
- The button must publish `farm/<site>/hub/ack` with `{"ackBy":"button"}`. The flows then silence the buzzer and keep the alert.

## 3. Switch the mode (baseline A)
- In the Node-RED editor, click the inject button **mode: cloud_only (baseline A)** or **mode: edge**. Or run this command in a shell:
  `mosquitto_pub -u <user> -P <pw> -r -t farm/demo/hub/mode -m cloud_only`
- The broker retains the choice, so it stays after a restart. A switch to `edge` starts with a clean alert memory.
- In `cloud_only` mode, the bridge relays the readings. The Pi publishes no `hub/alert`. The Pi drives the hardware from the container states `platform/alert` and `platform/sensor`.
- A `hub/state` message that follows a new alert has this field: `"trace":{"seq":88,"rx_ms":...}`. The value `ts - trace.rx_ms` is the time from the reading on the Pi to the alarm. The Pi measures it on one clock. This is the latency number for Section V.

## 4. Not done here
You must build these parts: the GPIO, I2C LCD and buzzer drivers, the RF receiver and the Mosquitto passwords on the Pi. The bridge never ran. The contract above is all that these parts need.
