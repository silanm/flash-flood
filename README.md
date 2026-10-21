# Canal Flood Monitor: Platform

Receives water-level readings from an ultrasonic sensor node over MQTT, cleans them up, stores them, and shows
them on a Grafana dashboard. Runs on **Node-RED + InfluxDB + Grafana**, plus an MQTT broker (Mosquitto) the three
tools sit behind. Until the real equipment is connected, a built-in simulator feeds it realistic data.

> Design reasoning and trade-offs are in [ARCHITECTURE.md](ARCHITECTURE.md); what was built, how it was verified and what is left is in
> [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md). This file is the operating manual.

**Status:** ingest, sensor filtering, temperature compensation, storage, dashboard, simulator, **offline-sensor detection, alert
levels (normal / warning / critical), acknowledgements and the notifier (log channel)** are built and running. **Out of scope:** an external push channel (LINE, email, SMS): people are told through the dashboard, the Node-RED log, retained MQTT
alert topics and the Pi's local alarm. **Not built yet:** a "simulated data" label on the dashboard, and a non-default Grafana login.

---

## 1. How it works

```
 sensor node (ESP32 + HC-SR04 + temp sensor)         ┌──────────────── one container ────────────────┐
   or the built-in simulator                          │                                                │
        │  MQTT, QoS 1, username/password             │   Mosquitto  ──▶  Node-RED  ──▶  InfluxDB      │
        └────────────────────────────────────────────▶│   (broker)        filter,         (storage)    │
                                                      │                   compensate,        │         │
                                                      │                   convert            ▼         │
                                                      │                                   Grafana      │
                                                      └───────────────────────────────── (dashboard) ──┘
```

| Part | Job |
|---|---|
| **Mosquitto** | Post office. Devices publish to it; Node-RED subscribes. Password + per-device topic rules are enabled. |
| **Node-RED** | The only place that processes data and makes decisions: validates, filters, compensates, converts, raises alerts, writes to InfluxDB. Also runs the simulator. |
| **InfluxDB** | Stores every reading with its verdict (accepted or rejected, and why). Keeps 30 days. |
| **Grafana** | Read-only dashboard. It never decides or alerts (one decision-maker avoids duplicate messages). |

### From distance to water level

The sensor only measures the **distance down to the water surface**. The water level comes from a height you measure
once at installation:

> **water level = sensor height − (temperature-corrected) distance**

`sensor_height_cm` (in `config/site.json`) is the distance from the sensor face to your zero point: the tank floor, or
the gauge zero in a canal. Calibrate it (section 5) rather than trusting a tape-measure guess: a 1 cm error moves
every level and alarm by 1 cm. The device sends only the raw distance; all conversion happens in the container.

### Handling an unreliable HC-SR04

Every reading goes through these stages (`src/pipeline.js`; thresholds in `config/site.json`):

| Stage | What it catches | Result |
|---|---|---|
| Schema, duplicates | malformed JSON, QoS 1 redelivery (by `seq`), a node restart | dropped (not stored) |
| Range | echo timeout (`null`), 0, below the sensor minimum, above the maximum | stored, `reject = timeout` / `range` |
| Stuck detector | the same distance 30 times in a row | `reject = stuck`, quality suspect |
| Spike gate | a single reading far from the recent median and physically too fast | `reject = spike` |
| Step | a spike that *stays* for 3 readings is a real change, not noise | accepted |
| Median of 5 | remaining jitter | `level_f`, the filtered level |
| Rate of rise | slope of `level_f` over 90 s (needs 45 s of data) | `rate_cm_min` |
| Step guard | a jump in `level_f` greater than 1 cm is a step, not a rise | slope history dropped |

Two principles: bad data never *raises* a flood level, and (once alerting exists) it never *clears* one. Rejected
readings are kept, so you can retune the filter from history.

### Alerts and notifications

Per node, the alert state is **NORMAL → WARNING → CRITICAL** (`src/alert.js`). A level at or above its threshold, **or** a rate of
rise at or above its threshold, raises it, so a fast rise warns you *before* the level threshold is reached.

| Rule | Why |
|---|---|
| Escalates only after 3 accepted readings in a row | one bad reading cannot alarm |
| Clears only after the value is 1 cm (0.3 cm/min) below the threshold for 30 s | no flapping around a threshold |
| Rejected readings neither raise nor clear an alert | bad data must not hide a flood |
| **Sensor fault** is a separate alert: no message for 90 s (`stale`), or over half of the last minute rejected (`degraded`) | a dead sensor must never look like "all clear" |
| A sensor fault does not change the flood state; a WARNING stays and the tile shows "WARNING + SENSOR FAULT" | the level is unknown, not safe |

Each state change writes a row to InfluxDB (`alert`) and publishes a retained MQTT message. Notifications follow a **Pi-first, container-fallback** rule ("send" below means "record the notification and publish it"):

| Situation | What the container does |
|---|---|
| Pi healthy | holds its own alert for 30 s; **cancels it** if the Pi's `hub/alert` covers it (same site, at least as severe, within 2 min), or the alert is acknowledged or clears first |
| Pi did not alert within 30 s | **sends** it, marked `[fallback: Pi did not send]` |
| Pi dead (no Pi message for 90 s) | sends one `[PI OFFLINE]` notice, then sends every alert **at once** (`[Pi offline]`); a node that goes silent because the Pi died is not reported separately |
| Pi back | sends `[PI OK]` |

Follow-ups (clear, acknowledgement, 10-minute reminders) are sent only for alerts the container itself sent; for the rest the Pi owns them.
A worse alert arriving while one is held replaces it. A notification is recorded in the Node-RED log and the Notifications table on the dashboard,
and the alert state is published as a retained MQTT message that other systems can subscribe to. An external push channel (LINE, email, SMS) is
out of scope; the notifier is one function node, so a channel could be added later without changing the decision rules.

**Acknowledge** by publishing `{"ackBy":"your name"}` to `farm/<site>/hub/ack` (see section 3). It silences reminders; a worse alert alerts
again.

### Temperature compensation

Sound travels faster in warmer air (about +0.17 % per °C), so a firmware that assumes a fixed speed reads long or
short as the air warms. If the device sends `temp_c`, the container corrects it:

> true distance = reported distance × (331.3 + 0.606 × T) / `assumed_sound_mps`

Example: at 40 °C and a 20 cm reading, the correction is about 0.7 cm. The raw value stays in `distance_cm`; the size of
the correction is stored in `temp_corr_cm` and plotted. A missing, `null`, non-numeric or out-of-range temperature
(including DS18B20 error codes −127 and 85) is ignored; the last good temperature is held for 5 minutes, then
readings are used uncompensated.

---

## 2. Deploy

**Prerequisites** (on the target; they already exist on our lab container): Node-RED 4+, InfluxDB 2.x, Grafana, and an
MQTT broker reachable from Node-RED. Your machine needs **Node.js 20+** and network access to the three web UIs. No
SSH or Docker is required for deploying.

```bash
cp .env.example .env      # fill in hosts, logins, org; keep it out of git (already in .gitignore)
npm test                  # logic tests, no network needed
node scripts/deploy.mjs   # safe to re-run
```

`deploy.mjs` does, in order: checks all services and versions; creates the InfluxDB bucket `flood` (30-day retention)
and two least-privilege tokens; merges the `flood-*` flows into Node-RED **without touching existing flows**; creates the
Grafana datasource and dashboard; then waits until simulated readings land in InfluxDB and runs every dashboard query.
It prints the dashboard URL and exits non-zero if anything fails.

**Things to know about redeploying**
- InfluxDB never returns a token after creating it, so each deploy **replaces the two `flood-*` tokens** and pushes the
  new values to Node-RED and Grafana in the same run. Nothing is stored in git or `.env`.
- The simulator returns to `calm` on every deploy. Filter and alert memory can also reset (the rate then shows nothing for ~45 s,
  and an active alert may need to be re-detected). Stored data is untouched.
- If `node-red-contrib-influxdb` is missing, deploy tries to install it, which needs npm access from the Node-RED host.
- Enabling broker passwords (once per broker) is separate: see section 7.

---

## 3. Connect a device

Ask the broker admin for a username and password. **The username must equal the node ID** (e.g. `node01`); the broker
rule then lets that device write only under `farm/<site>/node/<its username>/#`.

| Topic | Payload | Notes |
|---|---|---|
| `farm/<site>/node/<node>/level` | `{"seq":1042,"ts":"2026-10-14T15:02:03.120Z","distance_cm":22.4,"temp_c":28.5,"transport":"wifi"}` | QoS 1, **not retained** |
| `farm/<site>/node/<node>/status` | `online` / `offline` | QoS 1, **retained**, set `offline` as the Last Will |

Other topics on the same broker:

| Topic | Who | Meaning |
|---|---|---|
| `farm/<site>/hub/ack` | the Pi (`hub`) | `{"ackBy":"name"}`: acknowledge active alerts at the site |
| `farm/<site>/hub/alert` | the Pi (`hub`) | `{"severity":"warning"\|"critical"\|"sensor","node":"node01","level":..}`: an alert the Pi **sent**. Tells the container not to send its own. Include `node` if you can; without it the alert covers the whole site |
| `farm/<site>/hub/heartbeat` | the Pi (`hub`) | any payload, **every 30 s**. Without it the container cannot tell a quiet Pi from a dead one, and declares it dead after 90 s of silence |
| `farm/<site>/platform/alert/<node>` | read by anyone | retained flood state `WARNING` / `CRITICAL` / `NORMAL` / `ACKED` |
| `farm/<site>/platform/sensor/<node>` | read by anyone | retained `SENSOR_FAULT` (`reason` stale / degraded) or `SENSOR_OK` |

Firmware checklist (agreed with the equipment owner; each item exists for a reason in ARCHITECTURE.md §4):
- Send the **raw single reading** in `distance_cm`, not only a median, and **`null` when the echo times out**.
- Send a message **at least every 30 s**, even if the level hasn't changed, so silence means a problem.
- Increase `seq` by 1 per message (survives duplicates; a reset to 0 after reboot is fine).
- Send `temp_c` (air temperature at the sensor, °C) and tell us the speed of sound your code assumes (default 343 m/s).
- `transport` is `wifi` normally and `rf` when the reading arrives via the radio fallback.

Test from any machine with `mosquitto_pub`:

```bash
mosquitto_pub -h <broker-host> -u node01 -P '<password>' -q 1 \
  -t farm/demo/node/node01/level \
  -m '{"seq":1,"distance_cm":22.4,"temp_c":28.5,"transport":"wifi"}'

# acknowledge (as the Pi hub user)
mosquitto_pub -h <broker-host> -u hub -P '<password>' -q 1 -t farm/demo/hub/ack -m '{"ackBy":"somchai"}'
```

Set the node name and site in the dashboard drop-downs (they list whatever is in InfluxDB). Stop the simulator when the
real device is live (section 4) so demo data doesn't mix in.

---

## 4. The simulator

A Node-RED tab, `flood: simulator`, publishes as node `sim01` of site `demo` every 2 s through the real broker, exactly as
a device would. It is seeded, so runs are repeatable, and it models the temperature physics.

The simulator stays running until you send `off` (a node that goes silent raises a sensor fault, which is also how you can demo one).
Switch scenario by clicking its inject node in the Node-RED editor, or publish its name to `farm/demo/sim/control`
(user `sim01`). Publish `off` / `on` to stop and start it.

| Scenario | What it does |
|---|---|
| `calm` | steady 6 cm, normal jitter (default) |
| `slow_rise` / `flash_rise` | +0.4 / +3 cm per minute (`flash_rise` raises a rate alert about a minute in, long before the level threshold) |
| `recede` | falling from 20 cm: starts in WARNING, clears after the level is below 13 cm for 30 s |
| `glitches` | timeouts, zeros, +100–300 cm spikes, a stuck run |
| `sensor_dead` | level 16 cm (WARNING), then no echo for 60 s: WARNING is held, sensor fault raised |
| `failover` | WiFi → RF transport, duplicate messages, `offline` status while data keeps coming |
| `silence` | publishes nothing for 2 min: stale-sensor fault after 90 s |
| `temp_swing` | air warms 25 → 40 °C with the level constant (watch the correction grow) |
| `temp_fault` | temperature sensor drops out, then sends −127 |

The same scenarios drive the automated tests (`npm test`).

---

## 5. Configure

Everything tunable is in **`config/site.json`**. Change it, then run `node scripts/deploy.mjs`. Don't edit the generated
nodes in the Node-RED editor; the next deploy overwrites them.

| Key | Meaning |
|---|---|
| `site` | site ID used in topics and the dashboard default |
| `tank.sensor_height_cm` | sensor face to zero point. **Calibrate this.** |
| `tank.valid_min_cm` / `valid_max_cm` | readings outside this are rejected. The HC-SR04 datasheet minimum is 2 cm; our design doc says 20 cm. Measure your own module. Usable depth = `sensor_height_cm − valid_min_cm`. |
| `levels.warning_cm` / `critical_cm` | level thresholds. **Placeholders** (50 % / 75 % of usable depth) until the tank is calibrated |
| `rates.warning_cm_min` / `critical_cm_min` | rate-of-rise thresholds, same status |
| `temperature.enabled` | set `false` if the firmware already compensates |
| `temperature.assumed_sound_mps` | speed of sound the firmware uses (343 ≈ 20 °C; some code uses 340) |
| `temperature.valid_*_c`, `hold_s` | accepted range, and how long to keep the last good temperature |
| `alerts.confirm_n` | readings in a row needed to escalate (and to declare a degraded sensor) |
| `alerts.clear_hold_s`, `hysteresis_cm`, `hysteresis_cm_min` | how long and how far below the threshold before an alert clears |
| `alerts.stale_after_s` | silence before a node counts as offline (set it to about 3 × the device's message interval) |
| `alerts.sensor_clear_s` | clean readings needed to clear a sensor fault |
| `alerts.remind_min`, `dedupe_window_s` | reminder interval; de-duplication window |
| `alerts.fallback.grace_s` | how long the container waits for the Pi to send first (30) |
| `alerts.fallback.pi_dead_after_s` | silence before the Pi counts as dead (90, i.e. three missed heartbeats) |
| `alerts.fallback.cover_s` | how recent a Pi alert must be to cover ours (120) |
| `filter.*` | spike, step, stuck and rate parameters; defaults suit a 2 s sample interval |
| `sim.*` | simulated node name, autostart, start scenario, seed |

**Calibrating `sensor_height_cm`:** fill the tank to a mark you trust (read with a ruler), note the `distance_cm` the sensor
reports, and set `sensor_height_cm = marked level + reported distance`. Check at a second mark.

The thresholds drive both the dashboard lines and the alerts. There is no live adjustment: changing them means editing the file
and redeploying.

---

## 6. Monitor

Open the dashboard (the deploy prints the URL, `<grafana>/d/flood-main/flood-monitor`). Pick `site` and `node` at the top.

| Panel | Read it as |
|---|---|
| **Alert state** | NORMAL / WARNING / CRITICAL, or the same plus **SENSOR FAULT**. A silent node also shows SENSOR FAULT, even before a new row arrives |
| **Level** | filtered water level; orange / red at the thresholds |
| **Rate of rise** | cm per minute over the last 90 s (blank for 45 s after a restart or a level jump) |
| **Last reading** | seconds since the node last sent anything: green, orange at 30 s, red at 90 s |
| **Sensor quality** | good / suspect / bad, from the share of rejected readings in the last minute |
| **Air temp** | last temperature reading |
| **Pi hub last seen** | seconds since the Pi's last heartbeat (green, orange, red at 90 s). `NO PI SEEN` until it sends its first one |
| **Node** | which device, and whether data came over WiFi or RF |
| **Water level chart** | small dots are raw readings, yellow dots filtered; horizontal lines are warning and critical |
| **Rate chart**, **Temperature and its correction**, **Transport** | rate with its thresholds; °C and the cm correction applied; WiFi vs RF |
| **Alert state / Sensor quality timelines** | coloured bands over time. A gap is a period with no data |
| **Alerts, Notifications** (24 h, not tied to the time picker) | every state change and what was sent or suppressed |
| **Rejected readings** | how many readings were dropped and why. Many `stuck` or `spike` rows mean a sensor or aiming problem |
| **Device status messages** | the device's own online / offline messages |

Charts use dots, not lines, on purpose: a line across a silent period makes a dead sensor look calm.

Quick health checks on the container:

```bash
journalctl -u nodered -f                          # Node-RED log; "Write to InfluxDB failed" = token or bucket problem
tail -f /var/log/mosquitto/mosquitto.log          # connections; "not authorised" = wrong credentials
journalctl -u nodered | grep "notify (log)"      # every notification sent (Node-RED shortens long lines; full text is in the Notifications table)
```

In the Node-RED editor, the `flood: ingest` tab shows a status badge under the filter node: green with the current level
means data is flowing; yellow shows the latest rejection reason; grey shows dropped duplicates.

### REST API (optional)

Set `REST_PASSWORD` (and optionally `REST_USER`, default `operator`) in `.env` before deploying; without it these endpoints do not exist.

```bash
curl -u operator:$REST_PASSWORD "http://HOST:1880/api/v1/alerts?siteID=demo"                      # last 24 h, newest first
curl -u operator:$REST_PASSWORD "http://HOST:1880/api/v1/alerts?siteID=demo&since=2026-10-21T00:00:00Z"
curl -u operator:$REST_PASSWORD -X POST -H 'content-type: application/json' -d '{"ackBy":"somchai"}' "http://HOST:1880/api/v1/sites/demo/ack"
```

An acknowledgement silences reminders for every active alert of the site on the platform; it does not publish `hub/ack`, so the Pi's buzzer is
not affected. Basic auth is sent in clear text over HTTP: lab use only. Details: [ARCHITECTURE.md §13](ARCHITECTURE.md).

---

## 7. Broker security

Mosquitto requires a password and a topic ACL (`mosquitto/acl`). Users: `nodered` (this platform), `sim01` (simulator),
`node01` (the first real node), `hub` (the Raspberry Pi). Passwords are generated into `.env` as `MQTT_PW_<user>`.

To enable it on a broker, or to add a node (add a name to `USERS` in the script and a `MQTT_PW_<name>` to `.env`), run on the
broker host as root: `scripts/mosquitto-auth.sh /path/to/acl` with the `MQTT_PW_*` variables in the environment, then
`scripts/mosquitto-test.sh` to prove it (anonymous and wrong passwords refused, devices confined to their own topics, no
forged acknowledgements). The script backs up each config it edits as `*.pre-flood`; restore those and restart Mosquitto to
roll back.

---

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Deploy: `cannot reach ...` | wrong URL/port in `.env`, or a firewall |
| Deploy step 5 fails, no readings | broker credentials in `.env` don't match the broker; check `journalctl -u nodered` |
| `Write to InfluxDB failed ... unauthorized` | a deploy ran partly; run it again (tokens are replaced each run) |
| Dashboard panels blank for 10–20 s after opening | normal on first load while queries run |
| A real device sends but nothing appears | wrong topic (`farm/<site>/node/<node>/level`), username ≠ node ID, or payload isn't JSON |
| Level looks 1–2 cm off | `sensor_height_cm` not calibrated, or the firmware's assumed sound speed differs from `assumed_sound_mps` |
| Many `stuck` rejections in calm water | firmware rounds distance to whole cm; raise `filter.stuck_n` or send finer values |
| Rate shows nothing | under 45 s of data since start, a restart, or a level jump |
| Lab 5 clients refused by the broker | passwords are now required; give them a user |
| Alert tile shows SENSOR FAULT but readings look fine | the fault clears after 30 s of good readings (`alerts.sensor_clear_s`) |
| Sensor fault the moment a real device is idle | `alerts.stale_after_s` is shorter than the device's message interval |
| An alert won't clear | the level has to stay at least 1 cm below the threshold for 30 s, with valid readings |
| No message arrives on a phone | there is no push channel (out of scope); alerts appear on the dashboard, in the Node-RED log and on the `platform/alert/<node>` MQTT topics |
| Every notification says `fallback: Pi did not send` | the Pi isn't sending `hub/alert` (or isn't connected), so the container is the only sender |
| `PI OFFLINE` although the Pi is up | no `hub/heartbeat` every 30 s, or the Pi's bridge to this broker is down |

---

## 9. Repository layout

```
config/site.json         every number you may want to change
src/pipeline.js          filtering, temperature, rate (pure; tested)
src/alert.js             alert levels, sensor-fault watchdog, reminders, de-duplication (pure; tested)
src/rest.js              REST auth, request checks, history query (pure; tested)
src/hub.js               Pi hub: LED / LCD / buzzer state, hub alert payload, edge | cloud_only (pure; tested)
src/sim.js               the simulator (pure; tested)
nodered/build.js         builds the Node-RED flows from src/ (generated; do not edit nodes by hand)
nodered/build-pi.js      builds nodered/pi.flows.json, the same logic for the Raspberry Pi (npm run build:pi); setup in docs/PI_SETUP.md
grafana/dashboard.js     the dashboard as code, thresholds taken from config/site.json
scripts/deploy.mjs       idempotent deploy to Node-RED, InfluxDB, Grafana + end-to-end check
scripts/mosquitto-*.sh   enable and test broker auth (run on the broker host)
mosquitto/acl            topic permissions
test/                    unit and scenario tests (npm test)
.env.example             what .env needs; never commit .env or ENVIRONMENT.md
docs/                    project report drafts, figures, evidence (screenshots, data, test output) and the build log
```

## 10. Not built yet

- **External push notifications (LINE, email, SMS): out of scope** (decided 2026-10-21).
- A visible "simulated data" label on the dashboard, and a non-default Grafana admin login (it still uses the default).
- A live way to change thresholds (today: edit `config/site.json` and redeploy).
