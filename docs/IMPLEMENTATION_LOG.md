# Implementation log: platform build

Written 2026-10-21 from the build sessions of 2026-10-14 and 2026-10-18. Scope: everything on the Proxmox container
(Node-RED, InfluxDB, Grafana, Mosquitto) plus the simulator that stands in for the colleague's equipment. Not covered here:
the ESP32 firmware, the Raspberry Pi hardware and the nRF24L01 radio, which belong to the equipment owner.

Companion files: `README.md` (how to operate it), `ARCHITECTURE.md` (design and decisions), `config/site.json` (all numbers),
`test/` (the acceptance scenarios as executable checks). This file is the chronological account and the to-do list.

---

## 1. Where things stand

| Area | State | Evidence |
|---|---|---|
| Broker authentication (Mosquitto password + topic rules) | **Done** | `scripts/mosquitto-test.sh`, 6 checks pass |
| Simulator (10 scenarios, deterministic) | **Done** | `src/sim.js`, scenario tests |
| Ingest, HC-SR04 filtering, rate of rise | **Done** | `src/pipeline.js`, live `glitches` run |
| Temperature compensation | **Done**, mocked | live `temp_swing` run |
| Storage (InfluxDB bucket `flood`, scoped tokens) | **Done** | `scripts/deploy.mjs` |
| Dashboard (18 panels, every query validated) | **Done** | viewed in the browser pane |
| Offline-sensor detection, alert levels, acknowledgement | **Done** | `src/alert.js`, live runs |
| Container fallback notifier (Pi primary, container second) | **Done**, log channel only | `src/alert.js`, 3 live tests |
| One-command, repeatable deploy | **Done** | `node scripts/deploy.mjs` |
| REST API (alert history GET, site acknowledge POST) | **Deployed 2026-10-21**; unit and flow-level tests, 5 mutation checks, 16 HTTP checks on the container (all pass) | `src/rest.js`, `test/rest.test.js`, ARCHITECTURE.md §13 |
| Pi hub flows (edge / cloud_only for baseline A, hub/heartbeat, hub/alert, hub/state) | **Built, not deployed or run on a Pi**; 16 tests, 9 of 10 mutations caught | `nodered/pi.flows.json`, `src/hub.js`, `docs/PI_SETUP.md`, ARCHITECTURE.md §14 |
| Automated tests | **73 pass** (45 before REST, 57 before the Pi flows); key rules mutation-checked | `npm test` |
| External push notifications (LINE) | **Out of scope** (decided 2026-10-21) | see history item 14 |
| Flow file for the Raspberry Pi | **Not done** | see section 5 |
| Real sensor data, calibration, real thresholds | **Not done**: all data is simulated | see section 5 |
| Section V benchmarks (sysbench, dd, iPerf3, current draw) | **Not done** | see section 5 |
| Evidence (screenshots, data, test and mutation output) and the three diagrams saved as files | **Done** 2026-10-21 | `docs/evidence/`, `docs/figures/` |
| Nothing is committed to git yet | **Open** | `git status` shows everything untracked |

---

## 2. Build history

### 2026-10-14: discovery, access, broker, first working pipeline

1. **Read the brief and probed the container** (read-only). Verified: Ubuntu 24.04, 4 vCPU, 8 GB; Node-RED 5.0.7, InfluxDB 2.9.1,
   Grafana 13.2.2, Mosquitto 2.0.18, all native systemd services, no Docker. Mosquitto accepted anonymous clients. The container has **no outbound
   internet** (DNS resolves; HTTPS and ping time out). The existing Lab 7 flow talks to a different broker, so it is unaffected by anything below.
2. **SSH access.** Password-feeding scripts were refused by the tool's safety checks, so a dedicated key was created
   and the user installed it by typing the password themselves in a terminal. All later inspection used the key.
3. **Design written** (`ARCHITECTURE.md`): MQTT contract, schema, filter stages, alert rules, simulator plan, a portable-package approach.
   Decisions taken with the user: LINE as the channel (removed from scope on 2026-10-21), MQTT-only acknowledgement, a portable package, thresholds as placeholders until calibrated.
4. **Broker authentication enabled.** Passwords and a topic ACL for users `nodered`, `sim01`, `node01`, `hub`. A device's username is its node ID,
   so one pattern rule confines each node to its own topics. *Mistake and fix:* my first test run used a flag this `mosquitto_pub` does not have,
   so every publish failed and two "refused" results meant nothing. The tests now assert the specific "not authorised" message and
   a positive delivery before trusting the negative cases.
5. **Foundation and first slice**: InfluxDB bucket and tokens, Grafana datasource and dashboard, simulator, pipeline, ingest, `deploy.mjs`.
   Problems and fixes:
   - The plain `influxdb out` node cannot set a timestamp: switched to the `influxdb batch` node.
   - InfluxDB never returns a token's value after creation, so a second deploy pushed empty tokens. The deploy now **rotates the two tokens
     on every run** and pushes the new values to both consumers in the same run.
   - A Flux `count()` on a time column errors only when the stream has data, so the empty-data check could not see it. Rewritten with `reduce`.
   - My `.env` reader rejected lowercase names; my verify step read the wrong CSV column.
6. **HC-SR04 handling** built as staged, pure functions with unit tests: schema and duplicate check, range gate, stuck detector, spike gate with a
   "sustained shift is real" rule, median of 5, windowed rate of rise. A deliberate break of the spike gate confirmed the tests catch it.

### 2026-10-18: refinement, temperature, alerting, fallback

7. **Dashboard review in the browser pane**, then fixes: alarm lines visible, rate tile unit, quality as a state timeline, clean empty states.
   One fix backfired (flexible axis limits let a rejected -125 cm spike flatten the chart) and became fixed bounds of 0 to 28 cm.
8. **A false-alarm risk found on the live dashboard.** A level step (for example the sensor bumped, or a scenario change from 6 to 8 cm) read as a
   rise of +1.9 cm/min for about a minute, above the 1.0 warning rate. My first fix (reset on an accepted step) did not cover steps equal to the spike
   threshold: a test caught that. Final fix: a jump in the *filtered* level larger than 1 cm drops the slope history, and a rate is reported only once 45 s of
   data exist. Result: -0.22 to -0.10 cm/min across the same step.
9. **Temperature compensation.** The simulator now models the physics (a firmware that assumes a fixed speed of sound reads short as air warms), so the
   correction is meaningful. A 25 to 40 degC swing gave a correction of up to 0.72 cm and the filtered level stayed within 9.72 to 10.31 cm (true 10.0).
   Missing, null or out-of-range temperature (including DS18B20 error codes) is ignored; the last good value is held for 5 minutes.
10. **Alert logic and offline-sensor detection** (`src/alert.js`). Normal / warning / critical on level or rate; escalate after 3 accepted readings; clear after
    1 cm of hysteresis for 30 s; rejected readings never raise or clear; a separate sensor-fault alert (silent 90 s, or over half of the last minute rejected)
    that never changes the flood state; reminders every 10 minutes; acknowledgement over MQTT; Pi alerts ingested. Mutation checks: removing the fail-safe,
    the confirmation count or the hysteresis each fails tests. (One mutation silently did not apply because my search pattern did not match; found and redone.)
11. **Problems found by watching the dashboard during the alert tests.**
    - The Alert tile showed a green NORMAL while the sensor had been silent for 2 minutes. Fixed with a combined `alert_view` value and a stale override,
      so a held WARNING reads "WARNING + SENSOR FAULT".
    - A chart line bridged a 2.5-minute outage and made it look calm. Two Grafana settings did not break it, so the charts now draw dots.
    - The history tables hid all but one group until a `group()` merged them.
12. **Notification ownership decided with the user**: the Raspberry Pi is the primary (it sounds the buzzer and publishes its own alerts); the container is
    historian, dashboard and fallback recorder. Three architecture diagrams were drawn in the chat (saved as files on 2026-10-21).
13. **Container fallback notifier** (`handle`, `onHub`, `notifyTick`): holds its own alert for 30 s, cancels if the Pi covers it, sends if the Pi is silent or dead,
    announces PI OFFLINE / PI OK, ignores a node-stale caused by the Pi dying. Four mutation checks (no wait, Pi alerts ignored, Pi never dead, follow-ups always
    sent) all fail the tests. Two of my own slips were caught before deploy (a slice edit deleted two code constants; two functions shared a name).

### 2026-10-21: scope change, evidence

14. **Scope change: external push notifications (LINE) removed.** The notification system stays: alert decisions, the dashboard Alerts and Notifications tables,
    the Node-RED log, retained MQTT topics (`platform/alert|sensor/<node>`) and the Pi's local alarm. No LINE sender, account, token or relay will be built, and
    the request to the Proxmox admin for outbound access is no longer needed for notifications (it would still be needed to install benchmark tools on the
    container). The Pi-first / container-fallback rules are kept: they now decide which side *records* a notification, and would decide who pushes if a channel
    were ever added. README, ARCHITECTURE.md, the code comment and the architecture figure were updated; the diagram's "LINE" and "phone" boxes became "Officer".
15. **Evidence and figures saved.** `docs/figures/` has the three diagrams as SVG; `docs/evidence/` has 15 dashboard screenshots (four of them defects, kept as
    before / after pairs), CSV exports of the live test windows plus every alert and notification row still in InfluxDB, the 45-test output, and
    `scripts/mutation-check.mjs` with its output (10 of 10 mutations caught). *Correction made while doing this:* several figures I first put in the evidence index
    were wrong for the wider export windows (for example a rate range of 0.57 where the file reaches 0.83, and a level range that included calm periods).
    They were recomputed from the CSVs and the index now states what each phase of each file shows.

---

## 3. Live results (simulated data, real stack)

| Scenario | What the system did | Approx. run time |
|---|---|---|
| `glitches` | raw readings spiked to 224 cm; filtered level stayed 7.7 to 8.1 cm (true 8.0); rejects stored as `range` / `spike` / `stuck` | 2.5 min |
| step 6 to 8 cm | rate stayed -0.22 to -0.10 cm/min (before the fix: +1.9 / -1.65) | 2.3 min |
| `temp_swing` 26.7 to 40.2 degC | correction up to 0.72 cm; level 9.72 to 10.31 cm (true 10.0) | 4 min |
| `flash_rise` | WARNING at 44 s (rate 1.25 cm/min, level only 8.0 cm); CRITICAL at 72 s (rate 2.68, level 9.5). The 14 cm level line was never reached | 75 s |
| acknowledgement, then calm | ack by "somchai" recorded; alert cleared about 35 s after the water returned to normal | 1.5 min |
| node silent (simulator off) | "no data for 92 s" fault; sensor OK 31 s after data resumed | 3 min |
| `sensor_dead` mid-WARNING | tile read "WARNING + SENSOR FAULT"; WARNING held, never cleared | 1 min |
| Fallback A, no Pi ever seen | WARNING replaced by CRITICAL; CRITICAL sent 36 s after raised, marked `fallback: Pi did not send` | 2 min |
| Fallback B, Pi alerts within 30 s | both container alerts `covered by Pi`; nothing sent twice | 3 min |
| Fallback C, Pi heartbeat stops | PI OFFLINE after 96 s; alert sent immediately (`Pi offline`); PI OK on return | 2 min |

These runs and the 45 automated tests are the material for the report's results section. The raw data, screenshots and test outputs from these runs
are saved in `docs/evidence/` (see its `README.md` for what each file shows).

---

## 4. Decisions and deviations from the interim report

| Item | Interim PDF | What was built | Why |
|---|---|---|---|
| Who decides alerts | the Pi, platform only stores | **both** run the same logic; the Pi is the primary sender, the container the fallback | the Pi side is not ours yet; fallback covers a dead Pi |
| Containers | several LXCs | **one** LXC for all four services | the lab provided one; a Grafana crash can take the broker down with it |
| Broker access | decided, not deployed | **deployed** (passwords + ACL) | done 2026-10-14 |
| `level` retained | guide says yes, PDF says no | **not retained** | a retained reading replays after a restart and defeats stale detection |
| Rate calculation | "last N filtered samples" | slope over 90 s, needs 45 s, history dropped at a level jump | found by the false-alarm test |
| Temperature | not in the design | compensation added, node must send `temp_c` | accuracy; the user expects to read it |
| Dashboard lines | n/a | dots, not lines | a line across an outage makes a dead sensor look calm |

---

## 5. What is left

**Out of scope:** external push notifications (LINE, email, SMS).

### Needs no one else (can be done in the repo now)
1. **The Raspberry Pi flow file**: the same filter and alert code as importable Node-RED flows (core nodes only), publishing `hub/alert`, `hub/heartbeat` and a state message
   for the LED / LCD / buzzer, plus a one-page setup note for the colleague. Test on the container first.
2. **Dashboard**: a visible "simulated data" label; a viewer-only login; the first-load time (10 to 25 s) is unexplained and unmeasured.
3. **First git commit** (nothing is committed; `.env` and `ENVIRONMENT.md` are already ignored).
4. A one-page **contract handoff** for the colleague (topics, payloads, heartbeat, credentials).

### Needs the Proxmox admin (only for Section V)
5. **Outbound internet for the container**, or the benchmark tools installed another way: `sysbench` and `iperf3` cannot be installed while HTTPS to external hosts times out (item 9).

### Needs the equipment owner (your colleague)
6. Confirm the **MQTT contract**: raw `distance_cm` with `null` on timeout, a message at least every 30 s, a rising `seq`, `temp_c`, the speed of sound the
   firmware assumes, and whether distance is rounded to whole centimetres (that would make the stuck detector false-alarm; its limit is 30 identical readings).
7. On the Pi: publish `hub/heartbeat` every 30 s and `hub/alert` when it raises an alert; bridge readings to the container using the `hub` user; the ESP32
   publishes to the **Pi's broker**, not the container's; confirm the Node-RED version on the Pi and that RF readings are republished onto the same topics;
   own the buzzer, LED, LCD, button and the nRF24L01 failover.
8. Agree the real node ID (the broker user `node01` is a placeholder).

### Needs you
9. **Section V of the report**: sysbench, dd and iPerf3 on the Pi versus the container, with raw logs; measured current draw of the ESP32, HC-SR04 and nRF24L01;
   a power budget. Needs the Pi and the hardware (and item 5).
10. **Calibrate on the aquarium**: measure the sensor's real minimum range (datasheet 2 cm, the PDF says 20 cm, at a 30 cm mounting height that is the difference
    between about 10 cm and 28 cm of usable depth), set `sensor_height_cm`, and replace the placeholder alarm levels (14 and 21 cm, 1.0 and 2.5 cm/min) with real ones.
11. Report items from your guide: hand-drawn Fig. 1, Pi wiring schematic, demo video, benchmark discussion, a numeric target for Objective 2.

### Known limits to state in the report
- All results are on **simulated** data; behaviour on a real, noisy sensor is untested.
- Rate of rise can wobble up to about 0.5 cm/min for about a minute after a restart or a level jump (warning threshold 1.0).
- A redeploy resets the simulator and may reset filter and alert memory.
- The system has one container, no redundancy, and the Grafana login is still the default `admin` account.
- The Pi flows and the Pi-to-container bridge have **never run end to end**; the Pi was always simulated by publishing its messages by hand.
- There is no push notification: someone has to look at the dashboard, hear the Pi's alarm, or subscribe to the MQTT alert topics.

---

## 6. Mapping to the report sections

| Report section | Take material from |
|---|---|
| I Introduction, II Literature | the manuscript (kept outside this repo) |
| III System design and interoperability | `ARCHITECTURE.md` sections 3 to 5, 8; the architecture diagram |
| IV Methodology and implementation | this file section 2; `ARCHITECTURE.md` sections 6, 7, 9, 10; `README.md` |
| V Evaluation | this file section 3 (flood-specific results); tests in `test/`; **benchmarks still to do (item 12)** |
| VI Limitations and future work | this file sections 4 and 5 |
