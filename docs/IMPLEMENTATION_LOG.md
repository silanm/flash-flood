# Implementation log: platform build

We wrote this log on 2026-10-21 from the build sessions of 2026-10-14, 2026-10-18 and 2026-10-21. The scope is everything on the Proxmox container (Node-RED, InfluxDB, Grafana and Mosquitto) and the simulator that replaces the equipment of the colleague. This log does not cover the ESP32 firmware, the Raspberry Pi hardware and the nRF24L01 radio. They belong to the equipment owner.

Companion files: `README.md` (how to operate the platform), `ARCHITECTURE.md` (the design and the decisions), `config/site.json` (all numbers) and `test/` (the acceptance scenarios as executable checks). This file is the chronological account and the to-do list.

---

## 1. Where things stand

| Area | State | Evidence |
|---|---|---|
| Broker authentication (Mosquitto password and topic rules) | **Done** | `scripts/mosquitto-test.sh`, 6 checks pass |
| Simulator (10 scenarios, deterministic) | **Done** | `src/sim.js`, scenario tests |
| Ingest, HC-SR04 filtering, rate of rise | **Done** | `src/pipeline.js`, live `glitches` run |
| Temperature compensation | **Done**, mocked | live `temp_swing` run |
| Storage (InfluxDB bucket `flood`, scoped tokens) | **Done** | `scripts/deploy.mjs` |
| Dashboard (18 panels, we tested every query) | **Done** | we viewed it in the browser pane |
| Offline-sensor detection, alert levels, acknowledgement | **Done** | `src/alert.js`, live runs |
| Container fallback notifier (the Pi is primary, the container is second) | **Done**, log channel only | `src/alert.js`, 3 live tests |
| One-command, repeatable deploy | **Done** | `node scripts/deploy.mjs` |
| REST API (alert history GET, site acknowledge POST) | **Deployed 2026-10-21.** Unit tests, flow-level tests, 5 mutation checks and 16 HTTP checks on the container all pass. | `src/rest.js`, `test/rest.test.js`, ARCHITECTURE.md §13 |
| Pi hub flows (edge and cloud_only modes for baseline A, hub/heartbeat, hub/alert, hub/state) | **Built. We did not deploy them and they never ran on a Pi.** 16 tests pass. Mutation checks caught 9 of 10 mutations. | `nodered/pi.flows.json`, `src/hub.js`, `docs/PI_SETUP.md`, ARCHITECTURE.md §14 |
| Automated tests | **73 pass** (45 before REST, 57 before the Pi flows). We mutation-checked the key rules. | `npm test` |
| External push notifications (LINE) | **Out of scope** (decided 2026-10-21) | history item 14 |
| Real sensor data, calibration, real thresholds | **Not done.** All data is simulated. | section 5 |
| Section V benchmarks (sysbench, dd, iPerf3, current draw) | **Not done** | section 5 |
| Evidence (screenshots, data, test and mutation output) and the three diagrams saved as files | **Done** 2026-10-21 | `docs/evidence/`, `docs/figures/` |
| First git commit | **Done locally** (the repo `flash-flood`). We did not push it. | `git log` |

---

## 2. Build history

### 2026-10-14: discovery, access, broker, first working pipeline

1. **We read the brief and probed the container** (read-only). We verified these facts: Ubuntu 24.04, 4 vCPU, 8 GB, Node-RED 5.0.7, InfluxDB 2.9.1, Grafana 13.2.2 and Mosquitto 2.0.18. All services are native systemd services. There is no Docker. Mosquitto accepted anonymous clients. The container has **no outbound internet** (DNS resolves, but HTTPS and ping time out). The existing Lab 7 flow talks to a different broker, so nothing below affects it.
2. **SSH access.** The safety checks of the tool refused scripts that feed a password. We created a dedicated key. The user typed the password in a terminal and installed the key. All later inspection used the key.
3. **We wrote the design** (`ARCHITECTURE.md`): the MQTT contract, the schema, the filter stages, the alert rules, the simulator plan and a portable-package approach. We took these decisions with the user: LINE as the channel (we removed it from the scope on 2026-10-21), MQTT-only acknowledgement, a portable package and placeholder thresholds until calibration.
4. **We enabled broker authentication.** Passwords and a topic ACL apply to the users `nodered`, `sim01`, `node01` and `hub`. The username of a device is its node ID, so one pattern rule confines each node to its own topics. *Mistake and fix:* Our first test run used a flag that this `mosquitto_pub` does not have. Every publish failed, so two "refused" results meant nothing. The tests now assert the specific "not authorised" message and a positive delivery before they trust the negative cases.
5. **Foundation and first slice**: the InfluxDB bucket and tokens, the Grafana datasource and dashboard, the simulator, the pipeline, ingest and `deploy.mjs`. We found and fixed these problems:
   - The plain `influxdb out` node cannot set a timestamp. We switched to the `influxdb batch` node.
   - InfluxDB never returns the value of a token after it creates the token, so a second deploy pushed empty tokens. The deploy now **replaces the two tokens on every run** and pushes the new values to both consumers in the same run.
   - A Flux `count()` on a time column fails only when the stream has data, so the empty-data check could not see the failure. We rewrote the check with `reduce`.
   - Our `.env` reader rejected lowercase names. Our verify step read the wrong CSV column.
6. **HC-SR04 handling.** We built staged, pure functions with unit tests: the schema and duplicate check, the range gate, the stuck detector, the spike gate with a "sustained shift is real" rule, the median of 5 and the windowed rate of rise. A deliberate break of the spike gate showed that the tests catch the defect.

### 2026-10-18: refinement, temperature, alerting, fallback

7. **Dashboard review in the browser pane**, then fixes: visible alarm lines, a unit on the rate tile, quality as a state timeline and clean empty states. One fix backfired. Flexible axis limits let a rejected −125 cm spike flatten the chart. We replaced them with fixed bounds of 0 to 28 cm.
8. **We found a false-alarm risk on the live dashboard.** A level step (for example a bumped sensor, or a scenario change from 6 to 8 cm) read as a rise of +1.9 cm/min for about a minute. This is above the warning rate of 1.0. Our first fix (reset on an accepted step) did not cover steps equal to the spike threshold. A test caught that gap. The final fix: a jump of more than 1 cm in the *filtered* level drops the slope history, and the platform reports a rate only after 45 s of data. Result: −0.22 to −0.10 cm/min across the same step.
9. **Temperature compensation.** The simulator now models the physics. A firmware that assumes a constant speed of sound reads short when the air warms. The correction is therefore meaningful. A swing from 25 to 40 °C gave a correction of up to 0.72 cm. The filtered level stayed within 9.72 to 10.31 cm (true level 10.0). The platform ignores a missing, null or out-of-range temperature (including the DS18B20 error codes). It holds the last good value for 5 minutes.
10. **Alert logic and offline-sensor detection** (`src/alert.js`):
    - The state is normal, warning or critical. It depends on the level or the rate.
    - The state rises after 3 accepted readings.
    - The state clears after 1 cm of hysteresis for 30 s.
    - Rejected readings never raise or clear a state.
    - A separate sensor-fault alert starts when the sensor is silent for 90 s or when the platform rejects more than half of the last minute. It never changes the flood state.
    - Reminders arrive every 10 minutes.
    - Acknowledgement works over MQTT.
    - The platform ingests Pi alerts.

    Mutation checks: when we removed the fail-safe, the confirmation count or the hysteresis, tests failed each time. One mutation did not apply, because our search pattern did not match. We found this and repeated the mutation.
11. **We found problems when we watched the dashboard during the alert tests.**
    - The Alert tile showed a green NORMAL while the sensor was silent for 2 minutes. We fixed it with a combined `alert_view` value and a stale override. A held WARNING now reads "WARNING + SENSOR FAULT".
    - A chart line crossed a 2.5-minute outage and made the outage look calm. Two Grafana settings did not break the line, so the charts now draw dots.
    - The history tables hid all but one group until a `group()` call merged the groups.
12. **We decided the notification ownership with the user.** The Raspberry Pi is the primary. It sounds the buzzer and publishes its own alerts. The container is the historian, the dashboard and the fallback recorder. We drew three architecture diagrams in the chat. We saved them as files on 2026-10-21.
13. **Container fallback notifier** (`handle`, `onHub`, `notifyTick`). It holds its own alert for 30 s. It cancels the alert if the Pi covers it. It sends the alert if the Pi is silent or dead. It announces PI OFFLINE and PI OK. It ignores a stale node when the Pi death caused the stale state. Four mutation checks (no wait, Pi alerts ignored, Pi never dead, follow-ups always sent) all made tests fail. We caught two slips of our own before the deploy: a slice edit deleted two code constants, and two functions shared a name.

### 2026-10-21: scope change, evidence, REST, Pi flows

14. **Scope change: we removed external push notifications (LINE).** The notification system stays:
    - the alert decisions
    - the dashboard tables Alerts and Notifications
    - the Node-RED log
    - the retained MQTT topics (`platform/alert|sensor/<node>`)
    - the local alarm on the Pi

    We will not build a LINE sender, a LINE account, a token or a relay. We no longer need the request to the Proxmox admin for outbound access for notifications. We still need it to install the benchmark tools on the container. We keep the Pi-first and container-fallback rules. They now decide which side *records* a notification. They would decide who pushes if we ever add a channel. We updated the README, ARCHITECTURE.md, the code comment and the architecture figure. The "LINE" and "phone" boxes of the diagram became "Officer".
15. **We saved the evidence and the figures.** `docs/figures/` has the three diagrams as SVG. `docs/evidence/` has these files:
    - 15 dashboard screenshots (four of them show defects, and we kept them as before-and-after pairs)
    - CSV exports of the live test windows and every alert and notification row that InfluxDB still held
    - the output of the 45 tests that existed then
    - `scripts/mutation-check.mjs` with its output (10 of 10 mutations caught)

    *Correction:* We first put several wrong figures in the evidence index for the wider export windows. One example is a rate range of 0.57 where the file reaches 0.83. Another example is a level range that included calm periods. We recalculated them from the CSVs. The index now states what each phase of each file shows.
16. **REST endpoints.** We built `GET /api/v1/alerts` and `POST /api/v1/sites/<siteID>/ack`, deployed them and ran 16 HTTP checks. The live run found a defect that the unit tests missed. InfluxDB returns empty strings for missing string fields, and the unit tests used `null`. We fixed this and added a test.
17. **Pi hub flows.** We built `nodered/pi.flows.json`. It has an `edge` mode and a `cloud_only` mode (baseline A). We added `seq` to the alert events and redeployed the container, so the alert states carry `seq`. The Pi flows never ran on a real Pi.
18. **First commit.** We made the first commit in the repo `flash-flood`. We did not push it.

---

## 3. Live results (simulated data, real stack)

| Scenario | What the system did | Approximate run time |
|---|---|---|
| `glitches` | The raw readings spiked to 224 cm. The filtered level stayed at 7.7 to 8.1 cm (true level 8.0). The platform stored the rejects as `range`, `spike` and `stuck`. | 2.5 min |
| step 6 to 8 cm | The rate stayed at −0.22 to −0.10 cm/min (before the fix: +1.9 and −1.65). | 2.3 min |
| `temp_swing` 26.7 to 40.2 °C | The correction reached 0.72 cm. The level stayed at 9.72 to 10.31 cm (true level 10.0). | 4 min |
| `flash_rise` | WARNING at 44 s (rate 1.25 cm/min, level only 8.0 cm). CRITICAL at 72 s (rate 2.68, level 9.5). The level never reached the 14 cm line. | 75 s |
| acknowledgement, then calm | The platform recorded the ack by "somchai". The alert cleared about 35 s after the water returned to normal. | 1.5 min |
| node silent (simulator off) | The fault "no data for 92 s" appeared. The sensor was OK 31 s after the data resumed. | 3 min |
| `sensor_dead` during a WARNING | The tile read "WARNING + SENSOR FAULT". The WARNING stayed and never cleared. | 1 min |
| Fallback A, no Pi ever seen | A CRITICAL replaced the WARNING. The container sent the CRITICAL 36 s after it raised the alert and marked it `fallback: Pi did not send`. | 2 min |
| Fallback B, the Pi alerts within 30 s | Both container alerts were `covered by Pi`. Nothing was sent twice. | 3 min |
| Fallback C, the Pi heartbeat stops | PI OFFLINE appeared after 96 s. The container sent the alert at once (`Pi offline`). PI OK appeared when the Pi returned. | 2 min |

These runs and the automated tests are the material for the results section of the report. We saved the raw data, the screenshots and the test outputs from these runs in `docs/evidence/`. Its `README.md` explains each file.

---

## 4. Decisions and deviations from the interim report

| Item | Interim report | What we built | Why |
|---|---|---|---|
| Who decides alerts | The Pi decides and the platform only stores. | **Both** run the same logic. The Pi is the primary sender and the container is the fallback. | The Pi side was not ours yet. The fallback covers a dead Pi. |
| Containers | several LXCs | **One** LXC for all four services | The lab provided one. A Grafana crash can take the broker down. |
| Broker access | decided, not deployed | **Deployed** (passwords and ACL) | We did it on 2026-10-14. |
| `level` retained | The design guide says yes. The interim report says no. | **Not retained** | A retained reading replays after a restart and defeats the stale detection. |
| Rate calculation | "last N filtered samples" | The slope over 90 s. It needs 45 s of data. The history drops at a level jump. | The false-alarm test found the problem. |
| Temperature | not in the design | We added compensation. The node must send `temp_c`. | accuracy |
| Dashboard lines | not applicable | dots, not lines | A line across an outage makes a dead sensor look calm. |

---

## 5. What is left

**Out of scope:** external push notifications (LINE, email, SMS).

### Needs the Proxmox admin (only for Section V)
1. **Outbound internet for the container**, or another way to install the benchmark tools. We cannot install `sysbench` and `iperf3` while HTTPS to external hosts times out (item 5).

### Needs the equipment owner (the colleague)
2. Confirm the **MQTT contract**: the raw `distance_cm` with `null` on a timeout, a message at least every 30 s, a rising `seq`, `temp_c`, the speed of sound that the firmware assumes, and whether the firmware rounds the distance to whole centimetres. Rounding makes the stuck detector false-alarm. Its limit is 30 identical readings.
3. On the Pi: import `nodered/pi.flows.json` (`docs/PI_SETUP.md`). Bridge the readings to the container with the `hub` user. The ESP32 publishes to the **broker on the Pi**, not the broker on the container. Confirm the Node-RED version on the Pi. Confirm that the gateway republishes RF readings on the same topics. Own the buzzer, LED, LCD, button and the nRF24L01 failover.
4. Agree the real node ID (the broker user `node01` is a placeholder).

### Needs you
5. **Section V of the report**: sysbench, dd and iPerf3 on the Pi and on the container, with raw logs. Measure the current of the ESP32, the HC-SR04 and the nRF24L01. Make a power budget. This needs the Pi, the hardware and item 1.
6. **Calibrate on the aquarium.** Measure the real minimum range of the sensor (datasheet 2 cm, interim report 20 cm). At a mounting height of 30 cm, the usable depth is about 10 cm or about 28 cm. Set `sensor_height_cm`. Replace the placeholder alarm levels (14 and 21 cm, 1.0 and 2.5 cm/min) with real values.
7. **Dashboard:** a visible "simulated data" label, a viewer-only login and a non-default Grafana admin login. Nobody explained or measured the first-load time (10 to 25 s).
8. Report items: a hand-drawn Fig. 1, the Pi wiring schematic, the demo video, the benchmark discussion and a numeric target for Objective 2.

### Known limits to state in the report
- All results come from **simulated** data. The behaviour with a real, noisy sensor is untested.
- After a restart or a level jump, the rate of rise can wobble by up to about 0.5 cm/min for about a minute (warning threshold 1.0).
- A new deploy resets the simulator. It can also reset the filter and alert memory.
- The system has one container with no redundancy. The Grafana login is still the default `admin` account.
- The Pi flows and the bridge from the Pi to the container **never ran end to end**. We always simulated the Pi by publishing its messages by hand.
- There is no push notification. Someone must look at the dashboard, hear the alarm on the Pi or subscribe to the MQTT alert topics.

---

## 6. Mapping to the report sections

| Report section | Take material from |
|---|---|
| I Introduction, II Literature | the manuscript (kept outside this repo) |
| III System design and interoperability | `ARCHITECTURE.md` sections 3 to 5 and 8, and the architecture diagram |
| IV Methodology and implementation | this file, section 2. `ARCHITECTURE.md` sections 6, 7, 9 and 10. `README.md`. |
| V Evaluation | this file, section 3 (flood-specific results). The tests in `test/`. **The benchmarks are still to do (item 5).** |
| VI Limitations and future work | this file, sections 4 and 5 |
