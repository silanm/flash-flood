# Operating manual

This manual explains how to run, configure and troubleshoot the platform. For an overview with diagrams, read the [root README](../README.md).

The platform receives water-level readings from an ultrasonic sensor node over MQTT. It cleans the readings, stores them and shows them on a Grafana dashboard. It runs on **Node-RED, InfluxDB and Grafana**. An MQTT broker (Mosquitto) connects the three tools. Until you connect the real equipment, a built-in simulator sends realistic data.

> [ARCHITECTURE.md](../ARCHITECTURE.md) explains the design and the trade-offs. [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md) states what we built, how we verified it and what remains. This file is the operating manual.

**Status:** We built these parts and they run:
- ingest, sensor filtering and temperature compensation
- storage, the dashboard and the simulator
- offline-sensor detection, alert levels (normal, warning and critical) and acknowledgements
- the notifier (log channel)

The REST endpoints and the Pi hub flows (`nodered/pi.flows.json`) are also built. The Pi flows run on the rig's Pi (see `hardware/README.md`).

**Out of scope:** an external push channel (LINE, email or SMS). The platform tells people through the dashboard, the Node-RED log, the retained MQTT alert topics and the local alarm on the Pi.

**Not built yet:** a "simulated data" label on the dashboard and a non-default Grafana login.

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
| **Mosquitto** | The post office. Devices publish to it and Node-RED subscribes to it. Passwords and per-device topic rules are on. |
| **Node-RED** | The only part that processes data and makes decisions. It checks the data, filters it, compensates it, converts it, raises alerts and writes to InfluxDB. It also runs the simulator. |
| **InfluxDB** | Stores every reading with its verdict (accepted or rejected, and why). Keeps the data for 30 days. |
| **Grafana** | A read-only dashboard. It never decides or alerts. One decision-maker prevents duplicate messages. |

### From distance to water level

The sensor measures only the **distance down to the water surface**. You measure a height once at installation. The water level comes from that height:

> **water level = sensor height − (temperature-corrected) distance**

`sensor_height_cm` (in `config/site.json`) is the distance from the sensor face to your zero point. The zero point is the tank floor or the gauge zero in a canal. Calibrate this value (section 5). Do not trust a tape-measure guess. A 1 cm error moves every level and alarm by 1 cm. The device sends only the raw distance. The container does all the conversion.

### Handling an unreliable HC-SR04

Every reading goes through these stages (`src/pipeline.js`, thresholds in `config/site.json`):

| Stage | What it catches | Result |
|---|---|---|
| Schema, duplicates | malformed JSON, QoS 1 redelivery (by `seq`), a node restart | dropped (not stored) |
| Range | echo timeout (`null`), 0, below the sensor minimum, above the maximum | stored, `reject = timeout` or `range` |
| Spike gate | a single reading far from the recent median and physically too fast | `reject = spike` |
| Step | a spike that *stays* for 3 readings is a real change, not noise | accepted |
| Median of 5 | the remaining jitter | `level_f`, the filtered level |
| Rate of rise | slope of `level_f` over 90 s (needs 45 s of data) | `rate_cm_min` |
| Step guard | a jump in `level_f` of more than 1 cm is a step, not a rise | slope history dropped |

Two principles apply. Bad data never *raises* a flood level. Bad data never *clears* a flood level. The platform keeps rejected readings, so you can tune the filter from the history.

### Alerts and notifications

Each node has an alert state: **NORMAL → WARNING → CRITICAL** (`src/alert.js`). A level at or above its threshold raises the state. A rate of rise at or above its threshold also raises the state. A fast rise therefore warns you *before* the level threshold.

| Rule | Why |
|---|---|
| The state rises only after 3 accepted readings in a row | One bad reading cannot cause an alarm. |
| The state clears only after the value stays 1 cm (0.3 cm/min) below the threshold for 30 s | The state does not flap around a threshold. |
| Rejected readings neither raise nor clear an alert | Bad data must not hide a flood. |
| **Sensor fault** is a separate alert. It starts when no message arrives for 90 s (`stale`) or when the platform rejects more than half of the last minute (`degraded`) | A dead sensor must never look like "all clear". |
| A sensor fault does not change the flood state. A WARNING stays and the tile shows "WARNING + SENSOR FAULT" | The level is unknown, not safe. |

Each state change writes a row to InfluxDB (`alert`) and publishes a retained MQTT message. Notifications follow a **Pi-first, container-fallback** rule. In the table below, "send" means "record the notification and publish it".

| Situation | What the container does |
|---|---|
| Pi healthy | The container holds its own alert for 30 s. It **cancels** the alert if the Pi's `hub/alert` covers it (same site, at least as severe, within 2 min). It also cancels the alert if someone acknowledges it or if it clears first. |
| Pi did not alert within 30 s | The container **sends** the alert and marks it `[fallback: Pi did not send]`. |
| Pi dead (no Pi message for 90 s) | The container sends one `[PI OFFLINE]` notice. Then it sends every alert **at once** (`[Pi offline]`). It does not report a node that goes silent because the Pi died. |
| Pi back | The container sends `[PI OK]`. |

The container sends follow-ups (clear, acknowledgement and 10-minute reminders) only for alerts that it sent itself. For all other alerts, the Pi owns the follow-ups. A worse alert replaces a held alert. The platform records each notification in the Node-RED log and in the Notifications table on the dashboard. It also publishes the alert state as a retained MQTT message that other systems can subscribe to. An external push channel (LINE, email or SMS) is out of scope. The notifier is one function node, so you can add a channel later without a change to the decision rules.

To **acknowledge**, publish `{"ackBy":"your name"}` to `farm/<site>/hub/ack` (see section 3). The acknowledgement silences reminders. A worse alert alerts again.

### Temperature compensation

Sound travels faster in warmer air (about +0.17 % per °C). A firmware that assumes a constant speed reads the distance too long or too short when the air temperature changes. If the device sends `temp_c`, the container corrects the distance:

> true distance = reported distance × (331.3 + 0.606 × T) / `assumed_sound_mps`

Example: at 40 °C and a 20 cm reading, the correction is about 0.7 cm. The raw value stays in `distance_cm`. The platform stores the size of the correction in `temp_corr_cm` and plots it. The platform ignores a temperature that is missing, `null`, not a number or out of range. DS18B20 error codes −127 and 85 are also ignored. The platform keeps the last good temperature for 5 minutes. After that, it uses the readings without compensation.

---

## 2. Deploy

**Prerequisites** (they exist on our lab container): Node-RED 4 or later, InfluxDB 2.x, Grafana and an MQTT broker that Node-RED can reach. Your machine needs **Node.js 20 or later** and network access to the three web UIs. You do not need SSH or Docker to deploy.

```bash
cp .env.example .env      # enter hosts, logins and org. Keep it out of git (it is in .gitignore)
npm test                  # logic tests, no network needed
node scripts/deploy.mjs   # safe to run again
```

`deploy.mjs` does these steps in order:
1. It checks all services and versions.
2. It creates the InfluxDB bucket `flood` (30-day retention) and two tokens with minimum permissions.
3. It merges the `flood-*` flows into Node-RED **without a change to existing flows**.
4. It creates the Grafana datasource and the dashboard.
5. It waits until simulated readings arrive in InfluxDB. Then it runs every dashboard query.

The script prints the dashboard URL. It exits with a non-zero code if a step fails.

**Before you deploy again**
- InfluxDB never returns a token after it creates the token. Each deploy therefore **replaces the two `flood-*` tokens**. It pushes the new values to Node-RED and Grafana in the same run. The platform stores no token in git or in `.env`.
- The simulator returns to `calm` at each deploy. The filter and alert memory can also reset. The rate then shows nothing for about 45 s, and the platform can need time to detect an active alert again. The stored data does not change.
- If `node-red-contrib-influxdb` is missing, the deploy tries to install it. This needs npm access from the Node-RED host.
- Broker passwords are a separate task. You enable them once for each broker (section 7).

---

## 3. Connect a device

Ask the broker admin for a username and password. **The username must equal the node ID** (for example `node01`). The broker rule then lets that device write only under `farm/<site>/node/<its username>/#`.

| Topic | Payload | Notes |
|---|---|---|
| `farm/<site>/node/<node>/level` | `{"seq":1042,"ts":"2026-10-14T15:02:03.120Z","distance_cm":22.4,"temp_c":28.5,"transport":"wifi"}` | QoS 1, **not retained** |
| `farm/<site>/node/<node>/status` | `online` or `offline` | QoS 1, **retained**. Set `offline` as the Last Will. |

Other topics on the same broker:

| Topic | Who | Meaning |
|---|---|---|
| `farm/<site>/hub/ack` | the Pi (`hub`) | `{"ackBy":"name"}` acknowledges the active alerts at the site. |
| `farm/<site>/hub/alert` | the Pi (`hub`) | `{"severity":"warning"\|"critical"\|"sensor","node":"node01","level":..}` is an alert that the Pi **sent**. It tells the container not to send its own alert. Include `node` if you can. Without `node`, the alert covers the whole site. |
| `farm/<site>/hub/heartbeat` | the Pi (`hub`) | Any payload, **every 30 s**. Without it, the container cannot tell a quiet Pi from a dead Pi. The container declares the Pi dead after 90 s of silence. |
| `farm/<site>/platform/alert/<node>` | read by anyone | Retained flood state: `WARNING`, `CRITICAL`, `NORMAL` or `ACKED`. |
| `farm/<site>/platform/sensor/<node>` | read by anyone | Retained `SENSOR_FAULT` (`reason` is stale or degraded) or `SENSOR_OK`. |

Firmware checklist (we agreed it with the equipment owner, and ARCHITECTURE.md §4 gives the reason for each item):
- Send the **raw single reading** in `distance_cm`, not only a median. Send **`null` when the echo times out**.
- Send a message **at least every 30 s**, also when the level does not change. Then silence means a problem.
- Increase `seq` by 1 for each message. This survives duplicates. A reset to 0 after a reboot is fine.
- Send `temp_c` (the air temperature at the sensor, in °C). Tell us the speed of sound that your code assumes (default 343 m/s).
- Set `transport` to `wifi` normally. Set it to `rf` when the reading arrives through the radio fallback.

Test from any machine with `mosquitto_pub`:

```bash
mosquitto_pub -h <broker-host> -u node01 -P '<password>' -q 1 \
  -t farm/demo/node/node01/level \
  -m '{"seq":1,"distance_cm":22.4,"temp_c":28.5,"transport":"wifi"}'

# acknowledge (as the Pi hub user)
mosquitto_pub -h <broker-host> -u hub -P '<password>' -q 1 -t farm/demo/hub/ack -m '{"ackBy":"somchai"}'
```

Select the node name and the site in the dashboard drop-downs. They list the data in InfluxDB. Stop the simulator when the real device is live (section 4). Then demo data does not mix with real data.

---

## 4. The simulator

The Node-RED tab `flood: simulator` publishes as node `sim01` of site `demo` every 2 s. It publishes through the real broker, exactly as a device does. A seed makes the runs repeatable. The simulator also models the temperature physics.

The simulator runs until you send `off`. A node that goes silent raises a sensor fault, so `off` is also a way to demonstrate a fault. To switch the scenario, click its inject node in the Node-RED editor. Or publish the scenario name to `farm/demo/sim/control` (user `sim01`). Publish `off` or `on` to stop and start the simulator.

| Scenario | What it does |
|---|---|
| `calm` | steady 6 cm with normal jitter (default) |
| `slow_rise`, `flash_rise` | +0.4 and +3 cm per minute. `flash_rise` raises a rate alert about one minute in, long before the level threshold. |
| `recede` | The level falls from 20 cm. The scenario starts in WARNING. The alert clears after the level stays below 13 cm for 30 s. |
| `glitches` | timeouts, zeros, +100 to +300 cm spikes and a stuck run |
| `sensor_dead` | The level is 16 cm (WARNING). Then no echo arrives for 60 s. The WARNING stays and a sensor fault starts. |
| `failover` | The transport changes from WiFi to RF. Duplicate messages arrive. The status is `offline` while data keeps arriving. |
| `silence` | no messages for 2 min. A stale-sensor fault starts after 90 s. |
| `temp_swing` | The air warms from 25 to 40 °C with a constant level. The correction grows. |
| `temp_fault` | The temperature sensor drops out. Then it sends −127. |

The same scenarios drive the automated tests (`npm test`).

---

## 5. Configure

You can tune everything in **`config/site.json`**. Change the file. Then run `node scripts/deploy.mjs`. Do not edit the generated nodes in the Node-RED editor. The next deploy overwrites them.

| Key | Meaning |
|---|---|
| `site` | The site ID in topics. It is also the dashboard default. |
| `tank.sensor_height_cm` | The distance from the sensor face to the zero point. **Calibrate this value.** |
| `tank.valid_min_cm`, `valid_max_cm` | The platform rejects readings outside this range. The HC-SR04 datasheet minimum is 2 cm. Our design document says 20 cm. Measure your own module. Usable depth = `sensor_height_cm − valid_min_cm`. |
| `levels.warning_cm`, `critical_cm` | The level thresholds. They are **placeholders** (50 % and 75 % of the usable depth) until you calibrate the tank. |
| `rates.warning_cm_min`, `critical_cm_min` | The rate-of-rise thresholds. They are also placeholders. |
| `temperature.enabled` | Set it to `false` if the firmware already compensates. |
| `temperature.assumed_sound_mps` | The speed of sound that the firmware uses (343 is about 20 °C). Some code uses 340. |
| `temperature.valid_*_c`, `hold_s` | The accepted range, and the time to keep the last good temperature. |
| `alerts.confirm_n` | The number of readings in a row that raise the state. It also declares a degraded sensor. |
| `alerts.clear_hold_s`, `hysteresis_cm`, `hysteresis_cm_min` | The time and the distance below the threshold before an alert clears. |
| `alerts.stale_after_s` | The silence before a node counts as offline. Set it to about 3 times the message interval of the device. |
| `alerts.sensor_clear_s` | The time of clean readings that clears a sensor fault. |
| `alerts.remind_min`, `dedupe_window_s` | The reminder interval and the de-duplication window. |
| `alerts.fallback.grace_s` | The time that the container waits for the Pi to send first (30). |
| `alerts.fallback.pi_dead_after_s` | The silence before the Pi counts as dead (90, which is three missed heartbeats). |
| `alerts.fallback.cover_s` | The maximum age of a Pi alert that covers our alert (120). |
| `filter.*` | The spike, step and rate parameters. The defaults suit a 2 s sample interval. |
| `hub.*` | The Pi hub: default mode, state refresh time and heartbeat time. |
| `sim.*` | The simulated node name, autostart, start scenario and seed. |

**Calibrate `sensor_height_cm`:** Fill the tank to a mark that you trust. Read the mark with a ruler. Note the `distance_cm` that the sensor reports. Set `sensor_height_cm = marked level + reported distance`. Check the result at a second mark.

The thresholds drive both the dashboard lines and the alerts. You cannot change them live. To change them, edit the file and deploy again.

---

## 6. Monitor

Open the dashboard. The deploy prints the URL (`<grafana>/d/flood-main/flood-monitor`). Select `site` and `node` at the top.

| Panel | How to read it |
|---|---|
| **Alert state** | NORMAL, WARNING or CRITICAL, or the same with **SENSOR FAULT**. A silent node also shows SENSOR FAULT, before a new row arrives. |
| **Level** | The filtered water level. It is orange and red at the thresholds. |
| **Rate of rise** | cm per minute over the last 90 s. It is blank for 45 s after a restart or a level jump. |
| **Last reading** | Seconds since the node last sent a message. It is green, orange at 30 s and red at 90 s. |
| **Sensor quality** | good, suspect or bad. It comes from the share of rejected readings in the last minute. |
| **Air temp** | The last temperature reading. |
| **Pi hub last seen** | Seconds since the last heartbeat of the Pi (green, orange, and red at 90 s). It shows `NO PI SEEN` until the first heartbeat arrives. |
| **Node** | The device, and whether the data came over WiFi or RF. |
| **Water level chart** | The small dots are raw readings. The yellow dots show the filtered readings. The horizontal lines are the warning and critical levels. |
| **Rate chart**, **Temperature and its correction**, **Transport** | The rate with its thresholds. The temperature in °C and the correction in cm. WiFi against RF. |
| **Alert state and Sensor quality timelines** | Colored bands over time. A gap is a period with no data. |
| **Alerts, Notifications** (24 h, not tied to the time picker) | Every state change, and what the platform sent or suppressed. |
| **Rejected readings** | The number of dropped readings and the reasons. Many `spike` rows mean a sensor problem or an aiming problem. |
| **Device status messages** | The online and offline messages of the device. |

The charts use dots, not lines, on purpose. A line across a silent period makes a dead sensor look calm.

Quick health checks on the container:

```bash
journalctl -u nodered -f                          # Node-RED log. "Write to InfluxDB failed" means a token or bucket problem
tail -f /var/log/mosquitto/mosquitto.log          # connections. "not authorised" means wrong credentials
journalctl -u nodered | grep "notify (log)"      # every notification sent. Node-RED shortens long lines. The Notifications table has the full text
```

In the Node-RED editor, the `flood: ingest` tab shows a status badge under the filter node. Green with the current level means that data arrives. Yellow shows the latest rejection reason. Grey shows dropped duplicates.

### REST API (optional)

Set `REST_PASSWORD` in `.env` before you deploy. You can also set `REST_USER` (default `operator`). Without a password, these endpoints do not exist.

```bash
curl -u operator:$REST_PASSWORD "http://HOST:1880/api/v1/alerts?siteID=demo"                      # last 24 h, newest first
curl -u operator:$REST_PASSWORD "http://HOST:1880/api/v1/alerts?siteID=demo&since=2026-10-21T00:00:00Z"
curl -u operator:$REST_PASSWORD -X POST -H 'content-type: application/json' -d '{"ackBy":"somchai"}' "http://HOST:1880/api/v1/sites/demo/ack"
```

An acknowledgement silences reminders for every active alert of the site on the platform. It does not publish `hub/ack`, so the buzzer on the Pi does not change. Basic auth sends the password in clear text over HTTP. Use it in the lab only. For details, read [ARCHITECTURE.md §13](../ARCHITECTURE.md).

---

## 7. Broker security

Mosquitto requires a password and a topic ACL (`mosquitto/acl`). The users are `nodered` (this platform), `sim01` (the simulator), `node01` (the first real node) and `hub` (the Raspberry Pi). The deploy generates the passwords into `.env` as `MQTT_PW_<user>`.

To enable security on a broker, run the script on the broker host as root: `scripts/mosquitto-auth.sh /path/to/acl`. Put the `MQTT_PW_*` variables in the environment. To add a node, add a name to `USERS` in the script and a `MQTT_PW_<name>` to `.env`. Then run `scripts/mosquitto-test.sh` to prove the result. The test checks that:
- the broker refuses anonymous clients and wrong passwords
- each device writes only to its own topics
- nobody can forge an acknowledgement

The script saves each config that it edits as `*.pre-flood`. To roll back, restore those files and restart Mosquitto.

---

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Deploy: `cannot reach ...` | The URL or port in `.env` is wrong, or a firewall blocks the connection. |
| Deploy step 5 fails and no readings arrive | The broker credentials in `.env` do not match the broker. Check `journalctl -u nodered`. |
| `Write to InfluxDB failed ... unauthorized` | A deploy ran only in part. Run it again, because each run replaces the tokens. |
| Dashboard panels stay blank for 10 to 20 s after you open them | This is normal on the first load while the queries run. |
| A real device sends but nothing appears | The topic is wrong (it must be `farm/<site>/node/<node>/level`), the username is not the node ID, or the payload is not JSON. |
| The level is 1 to 2 cm wrong | `sensor_height_cm` is not calibrated, or the sound speed in the firmware differs from `assumed_sound_mps`. |
| The rate shows nothing | Less than 45 s of data since the start, a restart or a level jump. |
| The broker refuses Lab 5 clients | Passwords are now required. Give each client a user. |
| The alert tile shows SENSOR FAULT but the readings look fine | The fault clears after 30 s of good readings (`alerts.sensor_clear_s`). |
| A sensor fault starts when a real device is idle | `alerts.stale_after_s` is shorter than the message interval of the device. |
| An alert does not clear | The level must stay at least 1 cm below the threshold for 30 s, with valid readings. |
| No message arrives on a phone | There is no push channel (out of scope). Alerts appear on the dashboard, in the Node-RED log and on the `platform/alert/<node>` MQTT topics. |
| Every notification says `fallback: Pi did not send` | The Pi does not send `hub/alert` or is not connected. The container is the only sender. |
| `PI OFFLINE` appears but the Pi is up | The heartbeat `hub/heartbeat` does not arrive every 30 s, or the bridge from the Pi to this broker is down. |

---

## 9. Repository layout

```
config/site.json         every number that you can change
src/pipeline.js          filtering, temperature, rate (pure, tested)
src/alert.js             alert levels, sensor-fault watchdog, reminders, de-duplication (pure, tested)
src/rest.js              REST auth, request checks, history query (pure, tested)
src/hub.js               Pi hub: LED, LCD and buzzer state, hub alert payload, edge and cloud_only modes (pure, tested)
src/sim.js               the simulator (pure, tested)
nodered/build.js         builds the Node-RED flows from src/ (generated, do not edit nodes by hand)
nodered/build-pi.js      builds nodered/pi.flows.json, the same logic for the Raspberry Pi (npm run build:pi). Setup is in docs/PI_SETUP.md
grafana/dashboard.js     the dashboard as code, with thresholds from config/site.json
scripts/deploy.mjs       idempotent deploy to Node-RED, InfluxDB and Grafana, plus an end-to-end check
scripts/mosquitto-*.sh   enable and test broker security (run on the broker host)
mosquitto/acl            topic permissions
test/                    unit and scenario tests (npm test)
.env.example             what .env needs. Never commit .env or ENVIRONMENT.md
docs/OPERATING.md        this manual
docs/                    figures, evidence (screenshots, data, test output), the Pi setup guide and the build log
```

## 10. Not built yet

- **External push notifications (LINE, email, SMS): out of scope** (decided 2026-10-21).
- A visible "simulated data" label on the dashboard, and a non-default Grafana admin login (it still uses the default).
- A live way to change thresholds. Today you edit `config/site.json` and deploy again.
