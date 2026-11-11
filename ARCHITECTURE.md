# ARCHITECTURE — Canal Flood Early-Warning: Platform Container

Status: **We built steps 1 to 4 of §12 and they run on the container.** Step 5 (go-live) remains. Where this design differs from the interim report (the manuscript's Sections I to IV, kept outside this repo), §11 lists the difference.

> The chronological build history, the live test results and the to-do list are in [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md).

## 0. Current state

| Built and verified | Where |
| --- | --- |
| Broker authentication and ACL (6 checks pass) | `mosquitto/acl`, `scripts/mosquitto-{auth,test}.sh` |
| InfluxDB bucket `flood` (30 days), scoped write and read tokens | `scripts/deploy.mjs` |
| A seeded simulator that publishes as `sim01` through the authenticated broker | `src/sim.js`, tab `flood: simulator` |
| HC-SR04 conditioning stages 0 to 5, and ingest to InfluxDB | `src/pipeline.js`, tab `flood: ingest` |
| Grafana datasource `flood` and the dashboard "Flood Monitor" (we tested every query) | `grafana/dashboard.js` |
| Offline-sensor detection (watchdog), alert levels NORMAL, WARNING and CRITICAL with confirmation and hysteresis, reminders, MQTT acknowledgement, ingest of `hub/alert` from the Pi, notifier on the `log` channel, retained state topics | `src/alert.js`, tab `flood: ingest` |
| Container fallback notifier. It holds its own alert for 30 s. It cancels the alert if the Pi covers it. It records its own notification if the Pi is silent or dead. It sends the notices `PI OFFLINE` and `PI OK`. The dashboard shows a Pi heartbeat tile. | `src/alert.js` (`handle`, `onHub`, `notifyTick`), tab `flood: ingest` |
| REST endpoints (§13) | `src/rest.js`, `test/rest.test.js` |
| Pi hub flows (§14). They run on the rig's Pi; the drivers are in `hardware/`. | `src/hub.js`, `nodered/pi.flows.json`, `hardware/` |
| 73 unit and scenario tests. Mutation checks showed that tests fail when we remove the spike gate, the fail-safe, the confirmation, the hysteresis or the temperature correction. | `test/` |

```bash
npm test                 # logic tests, no network
node scripts/deploy.mjs  # idempotent: bucket, tokens, flows, datasource, dashboard, then end-to-end check
# switch the scenario live (credentials from .env):  mosquitto_pub -u sim01 -P <pw> -t farm/demo/sim/control -m glitches
```

Live evidence (scenario `glitches`, real stack): The raw readings spiked to 224 cm. The filtered level stayed within 7.7 to 8.1 cm (true level 8 cm). The platform stored the rejects as `range`, `spike` and `stuck`. The quality reached `suspect`.

**Testing on the live dashboard found a defect.** A level step read as a rise of 1.9 cm/min for about a minute. A bumped sensor or a scenario change from 6 to 8 cm causes such a step. This reading would raise a false WARNING. We fixed it in `src/pipeline.js`. Stage 5 now has a step rule and a minimum span of 45 s. The same step now gives −0.22 to −0.10 cm/min. The fix has two side effects. After a step or a restart, the rate is unavailable for 45 s. Also, `min_step_cm` fell from 2 to 1 cm, so the filter treats 2 cm steps as steps.

**The build differed from the plan in three ways:**
1. The plain `influxdb out` node cannot set a timestamp, so the flows use the `influxdb batch` node.
2. InfluxDB never returns the value of a token after it creates the token. **`deploy.mjs` therefore replaces the two `flood-*` tokens on every run.** It pushes the new values to Node-RED and Grafana in the same run. The platform stores nothing in git or in `.env`.
3. The stuck detector (`stuck_n` = 30 identical readings) assumes that the firmware sends distances with full resolution. If the firmware rounds to whole centimetres, the detector triggers falsely in calm water. Ask the colleague.

**Running the alert logic on the live dashboard found three defects:**
1. The Alert tile showed a green NORMAL while the sensor was silent for 2 minutes. The logic correctly held the last flood state. We fixed the tile with `alert_view` (flood state, plus 3 if the sensor is faulty) and a client-side stale override. A held WARNING now shows "WARNING + SENSOR FAULT".
2. A chart line crossed a 2.5-minute outage and made the outage look calm. We could not make Grafana break Flux series (the threshold and min-interval settings had no effect). The charts now draw dots.
3. The history tables hid all but one group until a `group()` call merged the groups.

**Out of scope (decided 2026-10-21):** an external push channel. We planned LINE and removed it. We never planned email and SMS. Notifications reach people through these channels:
- the dashboard (alert tile, Alerts table and Notifications table)
- the Node-RED log
- the retained MQTT topics `platform/alert|sensor/<node>`
- the local buzzer, LED and LCD on the Pi
 **Not built:** a visible "simulated data" label and a non-default Grafana admin login.

## 1. Scope

**We build (everything on container 107, 192.168.0.26):** MQTT ingest, signal conditioning, InfluxDB storage, the Grafana dashboard, the alert decision and the notification. We also build a **simulator** that replaces the equipment of the colleague until the equipment is ready.

**We do not build:** the ESP32 firmware, the nRF24L01 failover and the Raspberry Pi hub I/O (buzzer, LED, LCD and button). Those parts belong to the equipment colleague. The MQTT contract in §4 is our only interface to them.

**Stack (fixed):** Node-RED, InfluxDB and Grafana. The MQTT broker on `:1883` already existed. We did not add it. See §10 for what we must still check about the broker.

## 2. Environment (from `ENVIRONMENT.md`, which this document does not repeat for credentials)

| Item | Value | Verified |
| --- | --- | --- |
| Container | Proxmox LXC 107, `192.168.0.26`, ports 22, 1880, 1883, 3000 and 8086 open | yes |
| Node-RED | 5.0.7, admin authentication on. Installed: `node-red-contrib-influxdb` 0.7.0, `node-red-dashboard` 3.6.6 (unused), `node-red-node-pi-gpio`, serialport and others. The tab "Flow 1" from Lab 7 exists. | yes |
| InfluxDB | OSS **v2.9.1** (Flux, tokens). Org `ait-iot-lab7`. Buckets `iot_lab7` (Lab 7), `_monitoring` and `_tasks`. | yes |
| Grafana | 13.2.2. One existing datasource `influxdb`. | yes (we did not inspect the type and query language) |
| MQTT broker | **Mosquitto 2.0.18** on `:1883`. It was anonymous (Lab 5). **We enabled password authentication and the ACL on 2026-10-14** (§4a). The original `lab5.conf` is kept as `lab5.conf.pre-flood` and in `/root/flood-setup/`. | yes (SSH) |
| Host | Ubuntu 24.04, 4 vCPU, 8 GB RAM, 14 GB free. All four services run natively under systemd (`nodered`, `influxdb`, `grafana-server` and `mosquitto`). **No Docker.** Node.js 24, time zone Asia/Bangkok. | yes (SSH) |
| Node-RED settings | `functionExternalModules: true`, `credentialSecret: false` (the stored credentials are unencrypted on disk) | yes (SSH) |
| Outbound internet from the LXC | **No.** DNS resolves. HTTPS to external hosts (for example `registry.npmjs.org`) times out and ICMP is dropped. A lab firewall is the likely cause. Consequence: we cannot install `sysbench`, `iperf3` or new Node-RED palette modules on the container. | yes (SSH, 2026-10-14) |

Lab 7 artifacts (Flow 1, `iot_lab7` and the existing datasource) stay untouched. We use the namespace `flood` for everything of ours.

## 3. System overview

```
 colleague's equipment                       container 107 (192.168.0.26)
 ┌──────────────────┐   MQTT QoS1   ┌─────────────────────────────────────────────────────────┐
 │ ESP32 + HC-SR04  │──(wifi|rf)───▶│ broker :1883                                            │
 │  (via Pi hub)    │               │   │                                                     │
 └──────────────────┘               │   ▼            Node-RED :1880                           │
        ▲ swapped out while         │  [ingest] → [validate] → [filter+rate] → [alert FSM]    │
        │ mocking                   │                │               │             │          │
 ┌──────────────────┐  same topics  │                ▼               ▼             ▼          │
 │ Simulator flow   │──────────────▶│          InfluxDB :8086 ◀──────┘        [notify] ──▶ phone│
 │ (Node-RED tab)   │               │          bucket `flood`                  (+ ack in)     │
 └──────────────────┘               │                │                                        │
                                    │                ▼                                        │
                                    │          Grafana :3000  (read-only view)                │
                                    └─────────────────────────────────────────────────────────┘
```

Principles:

1. **The simulator publishes to the real broker on the real topics.** Nothing downstream knows if a reading is simulated. To go live, stop the simulator and point the colleague at the broker.
2. **Node-RED is the only part that decides.** Grafana shows the data. It does not alert. One source of truth prevents conflicts (§8).
3. **Fail safe on bad data.** Bad data never raises a flood alert. Bad data never *clears* a flood alert.
4. **Keep the raw data.** The platform stores every reading with its verdict. You can tune the filter again from the history.

## 4. MQTT contract (what the colleague must publish)

The topic tree is the tree in the interim report (`farm/<siteID>/<role>/<id>/<type>`, QoS 1). We add the payload details:

| Topic | Dir | Payload | Notes |
| --- | --- | --- | --- |
| `farm/<site>/node/<node>/level` | in | `{"seq":1042,"ts":"2026-10-14T15:02:03.120Z","distance_cm":37.4,"temp_c":28.5,"transport":"wifi"}` | **Not retained** (see below). `distance_cm` is the distance from the sensor to the surface. It is **null** if the echo timed out. |
| `farm/<site>/node/<node>/status` | in | `online` or `offline` | Retained. It is the Last Will of the node. |
| `farm/<site>/node/<node>/rate` | in | optional | **Ignored.** The container calculates the authoritative rate (§6). |
| `farm/<site>/hub/heartbeat` | in | any payload, every 30 s | From the Pi. If it is absent for `pi_dead_after_s` (90 s), the container sends for the Pi. |
| `farm/<site>/hub/ack` | in | `{"ackBy":"name","ts":...}` | It clears or mutes the alert. This is the ack path of the Pi. An operator can also acknowledge over REST (§13). The REST call acts on the platform only. |
| `farm/<site>/hub/alert` | in | `{severity,node,level,rate,seq,ts}` (see §14) | The Pi can raise alerts too. The platform ingests them, stores them with `source=hub` and shows them on the dashboard. The notification logic de-duplicates them against our alerts (§8). |
| `farm/<site>/platform/alert/<node>` | out | `{alertID,site,node,severity,kind,state,level,rate,seq,ts}` | Retained. It holds the flood state (`WARNING`, `CRITICAL`, `NORMAL` or `ACKED`). `seq` is the reading that triggered a new alert. |
| `farm/<site>/platform/sensor/<node>` | out | `{site,node,severity:"sensor",kind:"sensor",state,reason,ts}` | Retained. It holds `SENSOR_FAULT` (`reason` is stale or degraded) or `SENSOR_OK`. |

We ask the colleague for these items. Each item has a reason. We negotiate the items and do not assume them.

- **Send the raw single echo, not only the median of 5.** Our outlier handling must see the outliers. An optional `filtered_cm` field (the median of the colleague) is welcome. We store it for comparison and never trust it.
- **Send `null`, not nothing, when an echo fails.** Silence is ambiguous. `null` is a data point about the health of the sensor.
- **Send a heartbeat at least every 30 s, also when the level is flat.** With publish-on-change, a quiet topic can mean "level steady". It can also mean "sensor or link dead". The heartbeat removes this doubt.
- **Use a monotonic `seq` for each node.** QoS 1 is at-least-once. `seq` lets us drop duplicates and detect gaps.
- **Send `temp_c` (the air temperature near the sensor, in °C). Tell us the speed of sound that the firmware assumes** (typically 343 m/s, which is about 20 °C, or 340 m/s). The speed of sound changes by about 0.17 % per °C. At a range of 20 cm, an uncompensated reading drifts by about 0.7 cm between 25 and 40 °C. The platform compensates for this drift (§6). If the temperature sensor fails, send `null` (or omit the field). The platform ignores the DS18B20 error codes (−127 and 85). If the firmware already compensates, set `temperature.enabled=false`.
- **Send the `transport` field** (`wifi` or `rf`), as the interim report specifies. We store it as a tag, so the dashboard shows failovers.
- **Do not retain `level`.** This resolves an open question of the design guide. A retained reading replays after a Node-RED restart, looks fresh and defeats the stale detection. `status` stays retained.

### 4a. Broker access (enabled 2026-10-14)

Passwords and the ACL are on. The broker refuses anonymous clients. `mosquitto/acl` limits each user:

| User | Who | May read | May write |
| --- | --- | --- | --- |
| `nodered` | this platform | `farm/+/node/+/#`, `farm/+/hub/#`, `farm/+/platform/#` | `farm/+/platform/#` |
| `hub` | the Pi | `farm/+/hub/#`, `farm/+/platform/#` | `farm/+/hub/#`, `farm/+/node/+/#` (RF republish) |
| `node01` | the ESP32 of the colleague | its own subtree `farm/+/node/node01/#` | the same subtree |
| `sim01` | the simulator | `farm/+/node/sim01/#`, `farm/demo/sim/#` | the same topics |

The **username of a device is its nodeID**. One `pattern` rule therefore confines every node to its own subtree. A new node needs one `mosquitto_passwd` line and no ACL edit. The deploy generates the passwords into the gitignored `.env`. Give `MQTT_PW_node01` and `MQTT_PW_hub` to the colleague by another channel. The Mosquitto on the container served Lab 5 anonymously before. The broker now refuses Lab 5 clients. `scripts/mosquitto-auth.sh` applies this setup on any Mosquitto 2.x host. `scripts/mosquitto-test.sh` proves it: The broker refuses anonymous clients and wrong passwords. The broker delivers messages in the own subtree of a node. The broker blocks cross-node writes and reads. The broker blocks a forged `hub/ack`.

The container derives the level: `level_cm = sensor_height_cm − distance_cm`. The colleague therefore never needs the tank geometry or the thresholds. The LWT `offline` means "the WiFi path is dead". It does **not** mean "the sensor is dead". The platform judges liveness only from the arrival of data (§6, stage 6).

## 5. InfluxDB schema (org `ait-iot-lab7`, new bucket `flood`, 30-day retention)

The tokens have minimum permissions: one write-only token for Node-RED and one read-only token for Grafana. We create them through the Influx API. We store them in the Node-RED credentials and in the secure datasource settings of Grafana. We never store them in git.

| Measurement | Tags | Fields |
| --- | --- | --- |
| `level` (one row for each accepted message, valid or not) | `site`, `node`, `transport` | `distance_cm` (as received), `level_cm` (from the temperature-corrected distance), `level_f` (filtered), `rate_cm_min`, `quality` (0 good, 1 suspect, 2 bad), `reject` (the reason, only when we reject the reading), `valid`, `latency_ms`, `seq`, `seq_gap`, `temp_c`, `temp_ok`, `temp_corr_cm`, `alert_sev` (flood state 0, 1 or 2), `alert_view` (0 to 5, adds 3 for a faulty sensor) |
| `node_status` | `site`, `node`, `source` (`lwt`) | `online` (bool). Watchdog faults are `alert` rows with `kind=sensor`. |
| `alert` (state transitions only) | `site`, `node`, `severity`, `kind` (`level`, `rate`, `sensor` or `hub`), `source` (`platform` or `hub`) | `state`, `sev`, `level_cm`, `rate_cm_min`, `alertID`, `acked`, `reason` |
| `notification` (every notify decision) | `site`, `node`, `severity`, `kind`, `channel` (`log`) | `text`, `status` (`sent` or `suppressed`), `reason`. Reasons for `sent`: `fallback: Pi did not send`, `Pi offline`. Reasons for `suppressed`: `covered by Pi`, `Pi owns this alert`, `superseded`, `resolved before sent`, `acknowledged before sent`, `Pi offline explains it`, `sent by the Pi`, `dedupe`. |
| `hub` (one row for each Pi heartbeat) | `site` | `beat` |

The row timestamp is the `ts` of the node if it is within ±5 min of the container time. Otherwise it is the receive time, and the platform records `latency_ms`. A node with a wrong clock must not write into the past.

## 6. Handling HC-SR04 inaccuracy (the core technical piece)

The pipeline must absorb these failure modes:
- an echo timeout (`null` or 0)
- a false echo from a specular or soft surface (a single-sample spike)
- a reading below the usable minimum range of the module
- drift and jitter
- a stuck repeating value
- a slow temperature-dependent error (about 0.17 % per °C of the speed of sound)

The pipeline has stages. Each stage is one Node-RED function. Each stage is pure and unit-testable:

| # | Stage | Rule (all thresholds are in one config object, §9) | Outcome |
| --- | --- | --- | --- |
| 0 | Schema | Parse the JSON. Require `seq` and a numeric or null `distance_cm`. Drop a duplicate `(node,seq)`. Note `seq` gaps. | A malformed message is counted and dropped. |
| 1 | Range gate | The reading is valid if `valid_min_cm ≤ distance ≤ valid_max_cm`. The interim report gives a usable minimum of 20 cm. The datasheet gives a maximum of about 400 cm. | A `null`, 0 or out-of-range reading gets `reject=range` and the platform does not use it. |
| 2 | Spike gate (Hampel) | Reject if `|x − median(last 5 valid)| > max(k·MAD, min_step_cm)` **and** the implied rate exceeds the physical `max_rate_cm_min`. | `reject=spike`. **The platform accepts a sustained shift** after `confirm_n` agreeing samples (a real step is not a spike). |
| 3 | Stuck detector | The distance is exactly identical for `stuck_n` samples (a live sensor jitters by ±0.3 cm). | `quality=suspect`, `reject=stuck` |
| 4 | Smooth | `level_f` is the median of the last 5 accepted `level_cm` values. We do not use an EMA, because it lags when speed matters. | It feeds stage 5. |
| 5 | Rate of rise | The least-squares **slope over a time window** (default 90 s) of `level_f`, in cm/min. The platform **reports it only when 45 s of history or more exist** (`rate_min_span_s`). A slope over 20 s has a noise of ±0.6 cm/min. A two-point difference amplifies the noise by about 10 times. **A jump in `level_f` of more than `min_step_cm` (1 cm) between consecutive samples is a step, not a rise. The platform then drops the slope history.** A real rise moves about 0.1 cm for each sample, so a real rise never triggers this rule. | `rate_cm_min` |
| 6 | Node health (built in `src/alert.js`) | A watchdog tick every 10 s. If no message of any kind arrives for `stale_after_s` (90 s), including duplicates and rejected readings, the sensor fault is `stale`. If quality 2 (more than 50 % of the last minute rejected) lasts for `confirm_n` messages, the sensor fault is `degraded`. The fault clears after `sensor_clear_s` (30 s) of messages with quality below 2. | An `alert` row with `kind=sensor`, and `alert_view` +3 |

`quality` has three values: `good`, `suspect` (stuck, or more than 25 % invalid in 60 s) and `bad` (more than 50 % invalid, or stale).

We use two layers (a median on the node and a filter on the container) for these reasons. The filter on the node protects the radio-failover rule and the local alarm on the Pi. Our filter protects the platform view and the notifications. It also keeps working if the colleague tunes the filter wrongly. **Temperature compensation (built):** true distance = reported distance × (331.3 + 0.606·T) / `assumed_sound_mps`. The reported distance stays in `distance_cm`. The platform stores the correction in `temp_corr_cm`. The platform ignores a temperature outside −10 to 60 °C, a `null` and a non-numeric value (`temp_ok=false`). It holds the last good value for `hold_s` (300 s), because the air temperature drifts slowly. After that, it uses the readings without compensation.

## 7. Mock data and the simulator

One Node-RED tab, `flood-sim`, publishes as site `demo` and node `sim01` through a normal MQTT-out node. The cadence is 2 s. A seeded random number generator makes every run reproducible. A scenario is a timeline of segments. An inject node or the topic `farm/demo/sim/control` selects the scenario.

| Scenario | What it injects | What must happen (acceptance) |
| --- | --- | --- |
| `calm` | a steady level, ±0.3 cm jitter | no alert, `quality=good` |
| `slow_rise` | +0.4 cm/min up to the warning level | WARNING at the level threshold, not before |
| `flash_rise` | +3 cm/min | The rate alert fires **before** the absolute level threshold (the claim about time to react). |
| `recede` | a falling level | The alert de-escalates only after the hysteresis and the hold time. |
| `glitches` | isolated `null` values, zeros, +150 cm spikes and one stuck run of 30 samples | zero flood alerts, and the stuck run gives `SENSOR_FAULT` |
| `sensor_dead` | all `null` for 60 s during a warning | A SENSOR_FAULT notification. **The existing WARNING stays. It is not cleared.** |
| `failover` | `transport` changes from `wifi` to `rf`, +1 s latency, duplicate `seq` values and an LWT `offline` while data continues | no gap, no false "node offline", duplicates dropped |
| `silence` | publishing stops completely | `STALE` after `stale_after_s` and a node-offline notification |

The same table is the test plan. Each row becomes a headless check (run the scenario and assert the Influx `alert` rows). One switch turns the simulator on or off. Real nodes use their own `nodeID`, so real nodes and the simulator can run together during integration.

## 8. Alerting and notification

The **alert FSM** runs for each node. Its states are `NORMAL → WARNING → CRITICAL` (they match the green, amber and red LED of the Pi). The two-stage rule of the interim report drives it: a level threshold OR a rate threshold.

- The FSM escalates only after the condition holds for `confirm_n` consecutive *accepted* samples (default 3, about 6 s).
- The FSM de-escalates only after the value stays below `threshold − hysteresis` for `clear_hold_s`.
- Invalid or stale data neither escalates nor de-escalates. It raises a separate `kind=sensor` alert instead.
- At each transition, the platform writes an `alert` row to Influx, publishes the retained topic `platform/alert/<node>` (or `platform/sensor/<node>`) and calls the notifier.
- A sensor fault **never changes the flood state**. If a WARNING is active when the sensor goes blind, the FSM holds the WARNING and the tile shows "WARNING + SENSOR FAULT". Escalation needs `confirm_n` accepted readings in a row. Clearing needs a value below `threshold − hysteresis` (1 cm, 0.3 cm/min) for `clear_hold_s` (30 s).
- **To acknowledge over MQTT**, publish `{"ackBy":"name"}` to `farm/<site>/hub/ack`. This silences the reminders for everything that is active at the site. A later *escalation* alerts again. The platform stores **Pi alerts** (`farm/<site>/hub/alert`, severity warning, critical, amber or red) with `source=hub`.

**The notifier** (`handle`, `onHub`, `notifyTick`, `message` and `rows` in `src/alert.js`, one function node) follows these rules:
- It notifies on transitions only.
- It sends reminders every `remind_min` (10 min) while nobody acknowledges the alert.
- It holds opening alerts and de-duplicates them for each `(site,node,severity)` within `dedupe_window_s` (60 s).
- Resolutions, acknowledgements and reminders follow the rules in the box below.

In this document, "send" means "record and publish the notification". The only channel is **`log`**. The platform writes the message to the Node-RED log (`journalctl -u nodered | grep "notify (log)"`), to the `notification` measurement and to the dashboard table. It publishes the alert state as retained MQTT messages. Other systems (the Pi, a future integration) can subscribe to these messages.

**Scope decision (2026-10-21): an external push channel is out of scope.** LINE was the planned channel. We removed it. We never planned email and SMS. The notifier stays one function node, so you can add a channel later without a change to the decision rules. The Pi-first and container-fallback rules still decide *which side records a notification*. They would also decide who pushes if we ever add a channel.

**Two sources of alerts** (the container and the Pi): Both write `alert` rows with `source=platform` or `source=hub`. See "Notification ownership" below for who records what.

**Grafana does not run alert rules.** This avoids a second decision-maker that can disagree. We can consider one exception later: a single rule "no data from Node-RED for 2 min". Nothing notifies when Node-RED itself dies.

### Notification ownership (decided 2026-10-18, external push channel removed from scope 2026-10-21)

- **The Raspberry Pi is primary.** It runs the same filter and alert code. It sounds the buzzer and drives the LED and LCD. It publishes `hub/alert` and `hub/heartbeat`. It works while the container and the link to the container are down (the claim of the interim report about edge autonomy). We build the "edge" flow set from this repo (§14). The colleague owns the radio, the GPIO, the broker and the bridge. The colleague imports the flows.
- **The Proxmox container is the historian, the dashboard and the fallback recorder.** It keeps its own copy of the alert logic. It records its own notification in two cases only. In the first case, the Pi is dead (no Pi message for a set time). In the second case, the Pi did not alert within a grace period after the container raised the same alert. The `hub/alert` message of the Pi is the "already handled" signal. We built this and verified it live: the container holds the alert, then cancels it if the Pi alert arrives.
- The ESP32 must publish to the **broker on the Pi**. The Mosquitto on the Pi bridges the readings and the alerts to the broker on the container.
- The buzzer belongs to the Pi only (local hardware).

## 9. Dashboard (Grafana, provisioned from JSON in git)

The variables are `site` and `node`. The refresh interval is 5 s. The time zone is Asia/Bangkok. The panels are:

1. The current level (stat, colored by threshold) and the current severity, with the age of the last accepted reading.
2. The level over time: raw readings as points, `level_f` as a line and the threshold lines on top.
3. The rate of rise (cm/min) with warning and critical bands.
4. The alert timeline (state-timeline panel) and a table of recent alerts.
5. The link and transport timeline (`wifi`, `rf` or stale) and the `status` LWT.
6. The sensor health: valid ratio, rejected count for each reason, quality and `seq` gaps.
7. A simulation indicator, so nobody mistakes demo data for real data.

## 10. Portable package and deployment

**Goal: you run `git clone`, enter the values in `.env` and run one command. You get the same system on any container.** The package assumes that the target has **Node-RED, InfluxDB 2.x, Grafana and an MQTT broker that Node-RED can reach**. This container has the same four services. The package installs *into* them through their own HTTP APIs, so it works from your laptop. You need no SSH and no Docker. You do not need to know how the target installed the services. `docs/OPERATING.md` section 9 shows the file layout.

`scripts/deploy.mjs` does these steps in order. Each step is safe to repeat:

1. **Preflight:** It reaches all services, logs in and reports the versions. It stops on a mismatch (Influx 1.x, Node-RED older than 4).
2. **InfluxDB:** It creates the bucket `flood` and the two scoped tokens (write and read) in the configured org.
3. **Node-RED:** It checks that `node-red-contrib-influxdb` exists. If the module is absent, the script tries to install it (admin API `POST /nodes`). This needs npm access, which is **not possible on this container**. In that case the preflight fails with a clear message. Then it **merges** our `flood-*` tabs into the live flows. It never replaces other tabs, so the Flow 1 of Lab 7 survives. A new run replaces only our own tabs.
4. **Grafana:** It creates the `flood` datasource (Flux) and imports the dashboard.
5. **Verification:** It waits for simulated readings in InfluxDB and runs every dashboard query.

Only the deploy-time inputs differ for each container (`.env`). The thresholds and the site geometry travel with the package in `config/site.json`. If a target has no broker, the fallback is `node-red-contrib-aedes` inside Node-RED. This keeps us within the three tools, but it ties the life of the broker to Node-RED restarts. We do not build it unless we need it.

We generate the flows from `src/` for this reason. Function-node code that you edit in the browser is untestable and unreviewable. Also, `functionExternalModules` is not guaranteed on another container. The cost is one small build script.

## 11. Open decisions and deviations

**Deviations from the interim report** (deliberate, in the development stage):

1. The interim report makes the **Pi** take the alarm decision, and the platform only stores it. Here the container also decides and notifies, because the Pi side is not ours yet. The Pi can keep alerting too (§8 de-duplicates). The local alarm of the Pi is not affected. Our alert topic is `platform/alert`, not `hub/alert`, so the two cannot collide.
2. The interim report splits Mosquitto, InfluxDB, Grafana and Node-RED across several LXCs. The lab gave us **one**. A Grafana crash can therefore take the broker down. We accept this for development and we note it for the report.
3. The interim report describes the IAM (per-device Mosquitto users and ACLs) as "decided, not deployed". We deployed it on 2026-10-14.

**Decisions from the team:**
- We expected internet access on the container. This was false (see §2).
- Alerts can come from the Pi too.
- The colleague must accept the §4 contract.
- MQTT is the ack path of the Pi and REST (§13) is the ack path of the operator (decided 2026-10-21).
- The whole system must be a portable package (§10).
- LINE was the channel on 2026-10-14. We **removed it from the scope on 2026-10-21**.

**The tank geometry has a consequence. We must check it now.** The sensor is about 30 cm above the floor. The interim report gives the usable minimum range of the HC-SR04 as 20 cm or more. The datasheet of the manufacturer gives 2 cm. With a mounting height of 30 cm, the measurable water depth is about **10 cm** (minimum range 20 cm) or about **28 cm** (minimum range 2 cm). Mount the sensor higher, or confirm the real minimum on your own module with a ruler test. Set `valid_min_cm` in `config/site.json` from the answer. No alarm levels exist yet. `site.json` therefore contains **placeholders**: a warning at 50 % and a critical level at 75 % of the usable depth, and rate thresholds that match the tank. The simulator uses them. The real values come from the aquarium calibration. We implemented temperature compensation and mocked the temperature input (the `temperature` block in `site.json`). The simulator models the physics. A swing from 25 to 40 °C drifts an uncompensated reading by about 0.7 cm. The colleague must send `temp_c`.

**Still open:**

- **The role of the broker, for the record:** MQTT is publish-subscribe, so devices never talk to Node-RED directly. The broker is the middleman. It accepts the publishes of the colleague and passes them to every subscriber (Node-RED here). Node-RED does not include a broker, so a separate process listens on :1883.

## 12. Build order (each step leaves something to demonstrate)

1. **Foundation (done):** the bucket and the scoped tokens, the Grafana datasource, the broker authentication check, the repo skeleton and `deploy.mjs`.
2. **Vertical slice (done):** the simulator (`calm` and `slow_rise`), ingest, Influx and a minimal dashboard.
3. **Conditioning (done):** stages 0 to 6 with the scenarios `glitches`, `sensor_dead`, `failover` and `silence`, and the tests.
4. **Alerting (done):** the FSM, the notifier in `log` mode, the MQTT ack, the retained state topics and the watchdog.
5. **Go-live readiness:** This step has four parts:
   - the Pi flow set (built, §14)
   - the dashboard polish (simulated-data label and Grafana admin login, not built)
   - a contract handoff for the colleague (`docs/PI_SETUP.md`)
   - a cut-over checklist

   The checklist says: stop the simulator, check the first real `seq` stream and calibrate the thresholds on the aquarium.

## 13. REST API (built and deployed 2026-10-21)

Two endpoints run on the Node-RED of the container, on the `flood: ingest` tab. They read the alert state of that flow. The code is in `src/rest.js` (pure, tested). The flows are in `nodered/build.js`. The tests are in `test/rest.test.js`.

| Request | Answer |
| --- | --- |
| `GET /api/v1/alerts?siteID=<id>[&since=<iso8601>]` | `200` with an array, newest first, at most 200 items: `{alertID?, node, kind, severity, state, level_cm?, rate_cm_min?, source, reason?, ts}`. The items are state *transitions* (`WARNING`, `ACKED`, `NORMAL`, `SENSOR_FAULT` and others). The platform reads them from the `alert` measurement. `since` defaults to 24 h ago and needs a time zone (`Z`, or `%2B07:00` in a URL). `400` means a bad `siteID` or `since`. `500` means that InfluxDB cannot answer the query. |
| `POST /api/v1/sites/<siteID>/ack` with the body `{"ackBy":"name"}` | `200 {siteID, acked, count, ackTs}`. `count` is the number of silenced alerts. `acked:false` means that no alert was active. `400` means a bad site or name. `404` means that no node of that site ever reported. |

Decisions and limits:

- **The acknowledgement is per site**, like the MQTT acknowledgement. It silences the reminders for every active alert at the site. A later escalation alerts again.
- **It acts on the platform only.** The ack events go to the notifier exactly like an MQTT ack. The platform publishes nothing on `hub/ack` (only the Pi can, §4a) and does not mark the Pi as alive. The own button or the flows of the Pi silence the buzzer on the Pi.
- **Authentication:** HTTP Basic with one operator account (`REST_USER`, default `operator`, and `REST_PASSWORD`). The flow stores only the SHA-256 hash of the password. Without `REST_PASSWORD`, the platform does not deploy the REST nodes. Basic authentication over plain HTTP is readable on the lab network. Put TLS in front of the endpoints before any use outside the lab.
- **The platform reads the history with the read-only InfluxDB token.** Node-RED therefore holds both tokens. `deploy.mjs` passes the read token in.
- The endpoints need `functionExternalModules: true` (for `crypto`). This container has it.
- Validation: unit tests, the generated flows run with a fake context, five mutation checks and **16 HTTP checks against the deployed container**.
  - The HTTP checks cover 401 with and without a wrong password.
  - They cover 400 for a missing or injected `siteID` and for a `since` without a time zone.
  - They also cover 404 for an unknown site and 200 for the history in newest-first order.
  - A real alert from the `flash_rise` scenario showed as an `ACKED` row after the REST acknowledgement. A second acknowledgement reported `acked:false`.
  - The live run found that the InfluxDB pivot returns `""` for a missing string field. The unit tests used `null`. The platform now drops empty strings and a test covers this case.

## 14. Pi hub flows and baseline A (built 2026-10-21)

`nodered/pi.flows.json` runs the pipeline and the alert code of the container on the Pi. `nodered/build-pi.js` generates it. It uses core nodes only and contains no secrets. It has these parts:
- one function node (`hub logic`, with the glue in `build-pi.js` and the output rules in `src/hub.js`)
- five MQTT inputs
- a tick every 10 s and a heartbeat
- two mode buttons

 `docs/PI_SETUP.md` gives the setup steps for the equipment owner. `mosquitto/pi-bridge.conf.example` is the bridge template.

| | `edge` (proposed design) | `cloud_only` (baseline A) |
| --- | --- | --- |
| Readings | The Pi filters them and runs the alert state machine. | The Pi records the arrival time and the bridge relays the readings. The Pi decides nothing. |
| `hub/alert` | The Pi publishes it when it raises a WARNING, a CRITICAL or a sensor fault. | The Pi never publishes it. |
| `hub/state` (LED, LCD, buzzer) | It comes from the own state of the Pi. | It comes from the retained `platform/alert|sensor` states of the container. |
| Button | It acknowledges on the Pi. | It goes to the container, which answers with ACKED. |

Decisions:
- The mode is a retained `farm/<site>/hub/mode` message (or the editor buttons). A/B runs therefore need no new deploy. A switch to `edge` drops the old alert memory.
- A dead sensor never shows green.
- The Pi publishes only `hub/heartbeat|alert|state|mode`. All of them are inside the ACL of the `hub` user.
- **Latency instrumentation:** Alert events carry `seq` (the triggering reading). The Pi records the arrival time of each reading. A `hub/state` message after a new alert carries `trace {seq, rx_ms}`. The value `ts - rx_ms` is the time from the reading to the alarm on one clock, in both modes.

Verified: 16 tests on a fake clock against the simulator. They show that the Pi escalates in the same second as the container. They show that the `hub/alert` reader of the container accepts our payload. They show that the state payloads of the container drive `cloud_only`. They also cover mode switches, acknowledgements and a silent node. Mutation checks caught 9 of 10 mutations. The tenth mutation changes nothing that we can observe. The container runs the current flows, so its alert states carry `seq`. **Verified on the rig (November 2026):** a real Pi with the imported flows, the bridge, the GPIO and the RF link (`hardware/README.md`). The latency trace for baseline A and the edge mode is in `eval/results/replay_results_2026-11-10.csv`.

## Not yet verified

The content of the existing Lab 7 flow (`/root/.node-red/flows.json`) and the query language of the Grafana datasource. We can read both now over SSH or the API. We need them only at deploy-script time.
