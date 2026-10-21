# ARCHITECTURE — Canal Flood Early-Warning: Platform Container

Status: **steps 1–3 of §12 built and running on the container** (2026-10-14); alerting, notifier and dashboard polish remain. Where this differs from the interim report
(the manuscript's Sections I to IV, kept outside this repo), the difference is listed in §11.

> Chronological build history, live test results and the to-do list: [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md).

## 0. Current state

| Built and verified | Where |
| --- | --- |
| Broker auth + ACL (6 checks pass) | `mosquitto/acl`, `scripts/mosquitto-{auth,test}.sh` |
| InfluxDB bucket `flood` (30 d), scoped write/read tokens | `scripts/deploy.mjs` |
| Simulator (8 scenarios, seeded) publishing as `sim01` through the authenticated broker | `src/sim.js`, tab `flood: simulator` |
| HC-SR04 conditioning stages 0–5 + ingest to InfluxDB | `src/pipeline.js`, tab `flood: ingest` |
| Grafana datasource `flood` + dashboard "Flood Monitor" (9 panels; every query validated) | `grafana/dashboard.js` |
| Offline-sensor detection (watchdog), alert levels NORMAL / WARNING / CRITICAL with confirmation and hysteresis, reminders, MQTT acknowledgement, Pi `hub/alert` ingest, notifier on the `log` channel, retained state topics | `src/alert.js`, tab `flood: ingest` |
| Container fallback notifier: holds its own alert 30 s, cancels if the Pi covers it, records its own notification if the Pi is silent or dead, `PI OFFLINE` / `PI OK` notices; Pi heartbeat tile | `src/alert.js` (`handle`, `onHub`, `notifyTick`), tab `flood: ingest` |
| 45 unit/scenario tests (mutation checks confirmed they fail when the spike gate, fail-safe, confirmation, hysteresis or temperature correction is removed) | `test/` |

```bash
npm test                 # logic tests, no network
node scripts/deploy.mjs  # idempotent: bucket, tokens, flows, datasource, dashboard, then end-to-end verify
# switch scenario live (credentials from .env):  mosquitto_pub -u sim01 -P <pw> -t farm/demo/sim/control -m glitches
```

Live evidence (scenario `glitches`, real stack): raw readings spiked to 224 cm while the filtered level stayed within
7.7–8.1 cm (true 8 cm); rejects were stored as `range`, `spike`, `stuck`; quality reached `suspect`.

**Found by testing on the live dashboard:** a level step (e.g. sensor bumped, or a scenario change 6 → 8 cm) read as a 1.9 cm/min rise for about a minute, which would have raised a false WARNING. Fixed in `src/pipeline.js` with the step rule and 45 s minimum span in stage 5; the same step now gives −0.22…−0.10 cm/min. Side effects: after a step or restart the rate is unavailable for 45 s, and `min_step_cm` fell from 2 to 1 cm so 2 cm steps are caught as steps.

**Where the build differed from this plan:** (1) the plain `influxdb out` node cannot set a timestamp, so flows use the
`influxdb batch` node. (2) InfluxDB never returns a token's value after creation, so **`deploy.mjs` rotates the two `flood-*`
tokens on every run** and pushes the new values to Node-RED and Grafana in the same run (nothing is stored in git or `.env`).
(3) The stuck detector (`stuck_n`=30 identical readings) assumes the firmware sends full-resolution distances; if it rounds to
whole centimetres it will false-trigger in calm water. Ask the colleague.

**Found by running the alert logic on the live dashboard:** (a) the Alert tile read a green NORMAL while the sensor had been
silent for 2 minutes (the logic correctly held the last flood state). Fixed with `alert_view` (flood state + 3 if the sensor is
faulty) plus a client-side stale override, so a held WARNING shows "WARNING + SENSOR FAULT". (b) A chart line bridged a 2.5-minute
outage and made it look calm; Grafana could not be made to break Flux series (threshold and min-interval settings had no effect),
so charts now draw dots. (c) History tables hid all but one group until a `group()` merged them.

**Out of scope (decided 2026-10-21):** an external push channel (LINE was planned; email and SMS were never planned). Notifications reach people
through the dashboard (alert tile, Alerts and Notifications tables), the Node-RED log, the retained MQTT topics `platform/alert|sensor/<node>`,
and the Pi's local buzzer / LED / LCD. **Not built:** a visible "simulated data" label and a non-default Grafana admin login.

## 1. Scope

**We build (everything on container 107 / 192.168.0.26):** MQTT ingest → signal conditioning →
InfluxDB storage → Grafana dashboard → alert decision → notification. Plus a **simulator** that
stands in for the colleague's equipment until it is ready.

**We do not build:** ESP32 firmware, nRF24L01 failover, Raspberry Pi hub I/O (buzzer/LED/LCD/button).
Those belong to the equipment colleague. Our interface to them is the MQTT contract in §4 and nothing else.

**Stack (fixed):** Node-RED, InfluxDB, Grafana. The MQTT broker already listening on `:1883` is
pre-existing infrastructure, not something we add (see §10 for what we still need to confirm about it).

## 2. Environment (from `ENVIRONMENT.md`, credentials deliberately not repeated here)

| Item | Value | Verified |
| --- | --- | --- |
| Container | Proxmox LXC 107, `192.168.0.26`, ports 22, 1880, 1883, 3000, 8086 open | yes |
| Node-RED | 5.0.7, admin-auth on. Installed: `node-red-contrib-influxdb` 0.7.0, `node-red-dashboard` 3.6.6 (unused), `node-red-node-pi-gpio`, serialport, etc. Existing tab "Flow 1" from Lab 7 | yes |
| InfluxDB | OSS **v2.9.1** (Flux, tokens). Org `ait-iot-lab7`; buckets `iot_lab7` (Lab 7), `_monitoring`, `_tasks` | yes |
| Grafana | 13.2.2. One existing datasource `influxdb` | yes (type/query language not inspected) |
| MQTT broker | **Mosquitto 2.0.18** on `:1883`. Was anonymous (Lab 5); **password auth + ACL enabled 2026-10-14** (§4a). Original `lab5.conf` kept as `lab5.conf.pre-flood` and in `/root/flood-setup/` | yes (SSH) |
| Host | Ubuntu 24.04, 4 vCPU, 8 GB RAM, 14 GB free. All four services run natively under systemd (`nodered`, `influxdb`, `grafana-server`, `mosquitto`); **no Docker**. Node.js 24, TZ Asia/Bangkok | yes (SSH) |
| Node-RED settings | `functionExternalModules: true`, `credentialSecret: false` (stored credentials are unencrypted on disk) | yes (SSH) |
| Outbound internet from the LXC | **No.** DNS resolves, but HTTPS to external hosts (for example `registry.npmjs.org`) times out and ICMP is dropped. Likely a lab firewall. Consequence: no installing `sysbench` / `iperf3` or new Node-RED palette modules on the container | yes (SSH, 2026-10-14) |

Lab 7 artifacts (Flow 1, `iot_lab7`, the existing datasource) stay untouched. Everything of ours is namespaced `flood`.

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

1. **The simulator publishes to the real broker on the real topics.** Nothing downstream knows or cares
   whether a reading is simulated. Going live = stop the simulator, point the colleague at the broker.
2. **Node-RED is the only place that decides.** Grafana renders; it does not alert (one source of truth, §8).
3. **Fail safe on bad data.** Garbage never raises a flood alert, and garbage never *clears* one.
4. **Raw is kept.** Every reading is stored with its verdict, so filter tuning can be redone from history.

## 4. MQTT contract (what the colleague must publish)

Topic tree is the one already fixed in the PDF (`farm/<siteID>/<role>/<id>/<type>`, QoS 1). We add payload detail:

| Topic | Dir | Payload | Notes |
| --- | --- | --- | --- |
| `farm/<site>/node/<node>/level` | in | `{"seq":1042,"ts":"2026-10-14T15:02:03.120Z","distance_cm":37.4,"temp_c":28.5,"transport":"wifi"}` | **not retained** (see below). `distance_cm` = sensor-to-surface, **null** if the echo timed out |
| `farm/<site>/node/<node>/status` | in | `online` / `offline` | retained, node's LWT |
| `farm/<site>/node/<node>/rate` | in | optional | **ignored**: the container computes the authoritative rate (§6) |
| `farm/<site>/hub/heartbeat` | in | any, every 30 s | from the Pi; its absence for `pi_dead_after_s` (90 s) makes the container send for it |
| `farm/<site>/hub/ack` | in | `{"ackBy":"name","ts":...}` | clears/mutes the alert; the Pi's ack path. An operator can also acknowledge over REST (§13), which acts on the platform only |
| `farm/<site>/hub/alert` | in | PDF shape `{level,rate,severity,ts,transport}` | the Pi may raise alerts too; ingested, stored with `source=hub`, shown on the dashboard, notification-deduped against ours (§8) |
| `farm/<site>/platform/alert/<node>` | out | `{alertID,site,node,severity,kind,state,level,rate,ts}` | retained; flood state (`WARNING`, `CRITICAL`, `NORMAL`, `ACKED`) |
| `farm/<site>/platform/sensor/<node>` | out | `{site,node,severity:"sensor",kind:"sensor",state,reason,ts}` | retained; `SENSOR_FAULT` (`reason` stale/degraded) or `SENSOR_OK` |

Asks of the colleague, each with its reason (to negotiate, not assume):

- **Send the raw single echo, not only the median-of-5.** Our outlier handling needs to see the outliers. An optional
  `filtered_cm` field (their median) is welcome and is stored for comparison but never trusted.
- **Send `null`, not nothing, on a failed echo.** Silence is ambiguous; `null` is a data point about sensor health.
- **Heartbeat at least every 30 s even if the level is flat.** The PDF's publish-on-change means a quiet topic could be
  "level steady" or "sensor/link dead". The heartbeat removes that ambiguity.
- **Monotonic `seq` per node.** QoS 1 is at-least-once; `seq` lets us drop duplicates and detect gaps.
- **Send `temp_c` (air temperature near the sensor, °C), and tell us the speed of sound the firmware assumes** (typically 343 m/s ≈ 20 °C, or 340). Sound speed changes ~0.17 %/°C, so an uncompensated reading drifts ~0.7 cm at 20 cm range between 25 and 40 °C. We correct it here (§6). Send `null` (or omit) if the temperature sensor fails; DS18B20 error codes (−127, 85) are ignored. If the firmware already compensates, set `temperature.enabled=false`.
- **`transport` field** (`wifi`|`rf`), as the PDF specifies. Stored as a tag so failovers show on the dashboard.
- **`level` not retained.** (Resolves the PDF guide's open question 4.) A retained reading replays after a Node-RED
  restart looking fresh and defeats staleness detection. `status` stays retained.

### 4a. Broker access (enabled 2026-10-14)

Passwords + ACL are on; anonymous clients are refused. Each user is scoped by `mosquitto/acl`:

| User | Who | May read | May write |
| --- | --- | --- | --- |
| `nodered` | this platform | `farm/+/node/+/#`, `farm/+/hub/#`, `farm/+/platform/#` | `farm/+/platform/#` |
| `hub` | the Pi | `farm/+/hub/#`, `farm/+/platform/#` | `farm/+/hub/#`, `farm/+/node/+/#` (RF republish) |
| `node01` | colleague's ESP32 | own subtree `farm/+/node/node01/#` | same |
| `sim01` | simulator | `farm/+/node/sim01/#`, `farm/demo/sim/#` | same |

A device's **username is its nodeID**, so one `pattern` rule confines every node to its own subtree, and a new node is one
`mosquitto_passwd` line, with no ACL edit. Passwords are generated into the gitignored `.env`; hand `MQTT_PW_node01` and
`MQTT_PW_hub` to the colleague out of band. The container's Mosquitto previously served Lab 5 anonymously: Lab 5 clients
will now be refused. `scripts/mosquitto-auth.sh` applies this on any Mosquitto 2.x host and `scripts/mosquitto-test.sh`
proves it (anonymous and wrong-password refused, own-subtree delivered, cross-node write/read and `hub/ack` forgery blocked).

Derived level is computed here: `level_cm = sensor_height_cm − distance_cm`, so the colleague never needs to know
tank geometry or thresholds. LWT `offline` means "WiFi path dead", **not** "sensor dead": liveness is judged only from
data arrival (§6, stage 6).

## 5. InfluxDB schema (org `ait-iot-lab7`, new bucket `flood`, 30-day retention)

Least-privilege tokens: one write-only for Node-RED, one read-only for Grafana. Created via the Influx API, stored in
Node-RED credentials and Grafana's secure datasource settings, never in git.

| Measurement | Tags | Fields |
| --- | --- | --- |
| `level` (one row per accepted message, valid or not) | `site`, `node`, `transport` | `distance_cm` (as received), `level_cm` (from the temperature-corrected distance), `level_f` (filtered), `rate_cm_min`, `quality` (0 good / 1 suspect / 2 bad), `reject` (reason, present only when rejected), `valid`, `latency_ms`, `seq`, `seq_gap`, `temp_c`, `temp_ok`, `temp_corr_cm`, `alert_sev` (0/1/2 flood state), `alert_view` (0-5, adds 3 for a faulty sensor) |
| `node_status` | `site`, `node`, `source` (`lwt`) | `online` (bool); watchdog faults are `alert` rows with `kind=sensor` instead |
| `alert` (state transitions only) | `site`, `node`, `severity`, `kind` (`level`/`rate`/`sensor`/`hub`), `source` (`platform`/`hub`) | `state`, `sev`, `level_cm`, `rate_cm_min`, `alertID`, `acked`, `reason` |
| `notification` (every notify decision) | `site`, `node`, `severity`, `kind`, `channel` (`log`) | `text`, `status` (`sent`/`suppressed`), `reason` (sent: `fallback: Pi did not send`, `Pi offline`; suppressed: `covered by Pi`, `Pi owns this alert`, `superseded`, `resolved before sent`, `acknowledged before sent`, `Pi offline explains it`, `sent by the Pi`, `dedupe`) |
| `hub` (one row per Pi heartbeat) | `site` | `beat` |

Row timestamp = the node's `ts` when it is within ±5 min of container time, else receive time (with `latency_ms`
recorded). A node whose clock is wrong must not write into the past.

## 6. Handling HC-SR04 inaccuracy (the core technical piece)

Known failure modes this must absorb: echo timeout (`null`/0), specular or soft-surface false echoes (single-sample
spikes), readings below the module's usable minimum range, drift/jitter, a stuck repeating value, and slow
temperature-dependent error (~0.17 %/°C speed-of-sound).

A staged pipeline, one Node-RED function per stage, each pure and unit-testable:

| # | Stage | Rule (all thresholds in one config object, §9) | Outcome |
| --- | --- | --- | --- |
| 0 | Schema | Parse JSON; require `seq`, numeric-or-null `distance_cm`; drop duplicate `(node,seq)`; note `seq` gaps | malformed → counted, dropped |
| 1 | Range gate | valid iff `valid_min_cm ≤ distance ≤ valid_max_cm` (PDF: ≥20 cm usable minimum; datasheet max ~400) | `null`/0/out-of-range → `reject=range`, not used |
| 2 | Spike gate (Hampel) | Reject if `|x − median(last 5 valid)| > max(k·MAD, min_step_cm)`, **and** the implied rate exceeds the physical `max_rate_cm_min` | `reject=spike`; **a sustained shift is accepted** after `confirm_n` agreeing samples (real step ≠ spike) |
| 3 | Stuck detector | Exactly identical distance for `stuck_n` samples (a live sensor jitters ±0.3 cm) | `quality=suspect`, `reject=stuck` |
| 4 | Smooth | `level_f` = median of last 5 accepted `level_cm`. No EMA: it lags exactly when speed matters | feeds stage 5 |
| 5 | Rate of rise | Least-squares **slope over a time window** (default 90 s) of `level_f`, in cm/min, **reported only once ≥45 s of history exist** (`rate_min_span_s`; a 20 s slope is ±0.6 cm/min noise). A two-point difference amplifies noise ~10×. **A jump in `level_f` greater than `min_step_cm` (1 cm) between consecutive samples is a step, not a rise: the slope history is dropped.** Real rises move ~0.1 cm per sample, so this never triggers on one | `rate_cm_min` |
| 6 | Node health (built in `src/alert.js`) | A 10 s watchdog tick: no message of any kind (even a duplicate or rejected one) for `stale_after_s` (90 s) → sensor fault `stale`. Quality 2 (>50 % of the last minute rejected) for `confirm_n` messages → sensor fault `degraded`. Clears after `sensor_clear_s` (30 s) of messages with quality < 2 | `alert` row `kind=sensor`, `alert_view` +3 |

`quality` summarises: `good`; `suspect` (stuck, or >25 % invalid in 60 s); `bad` (>50 % invalid, or stale).

Why two layers (node median + container filter): the node filter protects the radio-failover rule and the Pi's local
alarm; ours protects the platform view and notifications, and it keeps working if the colleague's filter is
mis-tuned. **Temperature compensation (built):** true distance = reported × (331.3 + 0.606·T) / `assumed_sound_mps`. The reported distance stays in `distance_cm`; the correction is stored in `temp_corr_cm`. A temperature outside −10…60 °C, `null` or non-numeric is ignored (`temp_ok=false`), and the last good value is held for `hold_s` (300 s) because air temperature drifts slowly; after that, readings are used uncompensated.

## 7. Mock data and the simulator

One Node-RED tab, `flood-sim`, publishing as site `demo`, node `sim01` via a normal MQTT-out node, 2 s cadence,
seeded RNG so every run is reproducible. A scenario is a timeline of segments, selected by an inject node or by
`farm/demo/sim/control`:

| Scenario | What it injects | What must happen (acceptance) |
| --- | --- | --- |
| `calm` | steady level, ±0.3 cm jitter | no alert, `quality=good` |
| `slow_rise` | +0.4 cm/min to the warning level | WARNING at the level threshold, not before |
| `flash_rise` | +3 cm/min | rate alert fires **before** the absolute level threshold (the "time to react" claim) |
| `recede` | falling back | de-escalates only after hysteresis + hold time |
| `glitches` | isolated `null`, 0, +150 cm spikes, one 30-sample stuck run | zero flood alerts; stuck → `SENSOR_FAULT` |
| `sensor_dead` | all `null` for 60 s mid-warning | SENSOR_FAULT notification; **existing WARNING is held, not cleared** |
| `failover` | `transport` flips `wifi`→`rf`, +1 s latency, duplicate `seq`s, LWT `offline` while data continues | no gap, no false "node offline", dups dropped |
| `silence` | publishing stops entirely | `STALE` after `stale_after_s`, node-offline notification |

The same table is the test plan: each row becomes a headless check (run scenario, assert the Influx `alert` rows).
Simulator on/off is a single switch; real nodes use their own `nodeID`, so both can coexist during integration.

## 8. Alerting and notification

**Alert FSM** per node, states `NORMAL → WARNING → CRITICAL` (matches the Pi's green/amber/red LED), driven by the PDF's
two-stage rule: level threshold OR rate threshold.

- Escalate only after the condition holds for `confirm_n` consecutive *accepted* samples (default 3 ≈ 6 s).
- De-escalate only after the value stays below `threshold − hysteresis` for `clear_hold_s`.
- Invalid/stale data neither escalates nor de-escalates. It raises a separate `kind=sensor` alert instead.
- Each transition: write an `alert` row to Influx, publish retained `platform/alert/<node>` (or `platform/sensor/<node>`), call the notifier.
- A sensor fault **never changes the flood state**: a WARNING that is active when the sensor goes blind is held, and the tile shows
  "WARNING + SENSOR FAULT". Escalation needs `confirm_n` accepted readings in a row; clearing needs the value below
  `threshold − hysteresis` (1 cm, 0.3 cm/min) for `clear_hold_s` (30 s).
- **Acknowledge** over MQTT only: `farm/<site>/hub/ack` `{"ackBy":"name"}` silences reminders for everything active at the site;
  a later *escalation* alerts again. **Pi alerts** (`farm/<site>/hub/alert`, severity warning/critical/amber/red) are stored with `source=hub`.

**Notifier** (`handle` / `onHub` / `notifyTick` / `message` / `rows` in `src/alert.js`, one function node): notify on transitions only;
reminders every `remind_min` (10 min) while unacknowledged; opening alerts are held and de-duplicated per `(site,node,severity)` within
`dedupe_window_s` (60 s); resolutions, acks and reminders follow the rules in the box below. In this document "send" means "record and publish the
notification". The only channel is **`log`**: the message is written to the Node-RED log (`journalctl -u nodered | grep "notify (log)"`),
to the `notification` measurement and to the dashboard table, and the alert state is published as retained MQTT messages that any other system
(the Pi, a future integration) can subscribe to.

**Scope decision (2026-10-21): an external push channel is out of scope.** LINE was the planned channel; it is removed, and email / SMS were never
planned. The notifier stays one function node, so a channel could be added later without touching the decision rules. The Pi-first,
container-fallback rules still decide *which side records a notification*, and would decide who pushes if a channel were ever added.

**Two alert sources** (container and Pi): both write `alert` rows with `source=platform|hub`. See "Notification ownership" below for who records what.

**Grafana does not run alert rules**, to avoid a second, divergent decision-maker. One exception worth considering later:
a single "no data from Node-RED for 2 min" rule, because nothing notifies when Node-RED itself dies.

### Notification ownership (decided 2026-10-18; external push channel removed from scope 2026-10-21)

- **Raspberry Pi = primary.** It runs the same filter and alert code, sounds the buzzer / LED / LCD, and publishes `hub/alert` and `hub/heartbeat`.
  It works with the container and the link to it down (the PDF's edge-autonomy claim). Built from this repo as an "edge" flow set (**not built
  yet**); the colleague owns the radio, GPIO, broker and bridge, and imports the flows.
- **Proxmox container = historian, dashboard and fallback recorder.** It keeps its own copy of the alert logic. It records its own notification only if
  (1) the Pi is dead (no Pi message for a set time) or (2) the Pi has not alerted within a grace period after the container raised the same alert.
  The Pi's `hub/alert` is the "already handled" signal (built and verified live: hold, then cancel if the Pi alert arrives).
- The ESP32 should publish to the **Pi's broker**; the Pi's Mosquitto bridges readings and alerts to the container's broker.
- The buzzer is Pi-only (local hardware).

## 9. Dashboard (Grafana, provisioned from JSON in git)

Variables: `site`, `node`. Refresh 5 s, timezone Asia/Bangkok. Panels:

1. Current level (stat, threshold-coloured) and current severity, with age since last accepted reading.
2. Level over time: raw as points, `level_f` as a line, threshold lines overlaid.
3. Rate of rise (cm/min) with warning/critical bands.
4. Alert timeline (state-timeline panel) plus a recent-alerts table.
5. Link/transport timeline (`wifi`/`rf`/stale) and `status` LWT.
6. Sensor health: valid ratio, rejected count by reason, quality, `seq` gaps.
7. Simulation indicator (so nobody mistakes demo data for real).

## 10. Portable package and deployment

**Goal: `git clone`, fill in `.env`, run one command, get the same system on any container.** The package assumes only
that the target already has **Node-RED, InfluxDB 2.x, Grafana and a reachable MQTT broker** (the same four things this
container has). It installs *into* them through their own HTTP APIs, so it works from your laptop with no SSH, no Docker
and no knowledge of how the target installed them.

```
.env.example                every host, port and secret the target needs (real .env and ENVIRONMENT.md gitignored)
config/site.json            thresholds, tank geometry, filter parameters: the only place numbers live
src/*.js                    pure logic: validate, hampel, rate, fsm  (tested with `node --test`)
test/*.test.js              scenario + unit tests
nodered/build.js            inlines src/*.js into function nodes → nodered/flood.flows.json
grafana/dashboards/*.json   provisioned via the Grafana HTTP API
scripts/deploy.sh           idempotent, safe to re-run
scripts/verify.sh           post-deploy smoke test (runs a simulator scenario, asserts rows in Influx)
```

`deploy.sh` does, in order, and each step skips if already done:

1. **Preflight:** reach all four services, log in, report versions, refuse to continue on a mismatch (Influx 1.x, Node-RED < 4).
2. **InfluxDB:** create bucket `flood` and the two scoped tokens (write / read) in the configured org.
3. **Node-RED:** check that `node-red-contrib-influxdb` is present. If absent, install it (admin API `POST /nodes`, which
   needs npm access: **not possible on this container**, so preflight fails with a clear message and the package ships
   the module's tarball as a fallback). Then **merge** our `flood-*` tabs
   into the live flows. It never replaces existing tabs, so Lab 7's Flow 1 survives; re-running replaces only our own.
4. **Grafana:** create the `flood` datasource (Flux) and import the dashboards.
5. **Smoke test** via `verify.sh`.

Only deploy-time inputs differ per container (`.env`); thresholds and site geometry travel with the package in
`config/site.json`. If a target has no broker at all, the fallback is `node-red-contrib-aedes` inside Node-RED, which
keeps us within the three tools but ties the broker's lifetime to Node-RED restarts. Not built unless needed.

Why generate flows from `src/`: function-node code edited in the browser is untestable and unreviewable, and
`functionExternalModules` is not guaranteed on another container. The cost is one small build script.

Why generate flows from `src/`: function-node code edited in the browser is untestable and unreviewable, and
`functionExternalModules` is not guaranteed on the container. The cost is one small build script.

## 11. Open decisions and deviations

**Deviations from the interim PDF** (deliberate, dev-stage):

1. The PDF has the **Pi** make the alarm decision with the platform persisting it. Here the container also decides and
   notifies, since the Pi side isn't ours yet, and the Pi may keep alerting too (§8 dedupes). The Pi's local alarm is
   unaffected. Our alert topic is `platform/alert`, not `hub/alert`, so the two cannot collide.
2. The PDF splits Mosquitto/InfluxDB/Grafana/Node-RED across several LXCs; the lab gave us **one**. A Grafana crash can
   therefore take the broker down with it. Accepted for development, noted for the report.
3. The PDF's IAM (per-device Mosquitto users + ACLs) is "decided, not deployed", and the broker may still accept
   anonymous clients. Enabling it is broker administration outside our three tools.

**Decided (from you):** container has internet (found false, see §2) · alerts may come from the Pi too · colleague is expected to accept the §4
contract · MQTT is the Pi's ack path and REST (§13) the operator's, decided 2026-10-21 · the whole thing must be a portable package (§10) · LINE was the channel on 2026-10-14 and
was **removed from scope on 2026-10-21**.

**Tank geometry (sensor ≈ 30 cm above the floor) has a consequence to check now.** Your PDF states the HC-SR04's usable
minimum range as ≥20 cm, while the manufacturer datasheet figure is 2 cm. With a 30 cm mounting height that is the
difference between **~10 cm** and **~28 cm** of measurable water depth. Either mount the sensor higher, or confirm the
real minimum on your own module with a ruler test. `valid_min_cm` in `config/site.json` is set from the answer.
No alarm levels exist yet, so `site.json` ships **placeholders** (warning at 50 % and critical at 75 % of usable depth,
rate thresholds scaled to the tank) and the simulator uses them; real values come from aquarium calibration. Temperature
compensation is implemented and mocked (`temperature` block in `site.json`; the simulator models the physics, so a swing from 25 to 40 °C drifts an uncompensated reading by ~0.7 cm). It needs the colleague to send `temp_c`.

**Still open:**

- **Broker role, for the record:** MQTT is publish/subscribe, so devices never talk to Node-RED directly. The broker is the
  middleman that accepts the colleague's publishes and hands them to whoever subscribed (Node-RED here). Node-RED does
  not ship one, hence a separate process on :1883.

## 12. Build order (each step leaves something demoable)

1. **Foundation (done):** bucket + scoped tokens, Grafana datasource, broker auth check, repo skeleton, `deploy.sh`.
2. **Vertical slice (done):** simulator (`calm`, `slow_rise`) → ingest → Influx → minimal dashboard.
3. **Conditioning (done):** stages 0–6 with the `glitches`/`sensor_dead`/`failover`/`silence` scenarios and tests.
4. **Alerting (done):** FSM, notifier in `log` mode, MQTT ack, retained state topics, watchdog.
5. **Go live-ready:** Pi flow set, dashboard polish (simulated-data label, Grafana admin login), one-page contract handoff for the colleague,
   cut-over checklist (stop simulator, verify first real `seq` stream, calibrate thresholds on the aquarium).

## 13. REST API (built and deployed 2026-10-21)

Two endpoints on the container's Node-RED, on the `flood: ingest` tab (they read that flow's alert state). Code: `src/rest.js` (pure, tested), flows in `nodered/build.js`, tests in `test/rest.test.js`.

| Request | Answer |
| --- | --- |
| `GET /api/v1/alerts?siteID=<id>[&since=<iso8601>]` | `200` array, newest first, at most 200: `{alertID?, node, kind, severity, state, level_cm?, rate_cm_min?, source, reason?, ts}`. These are state *transitions* (`WARNING`, `ACKED`, `NORMAL`, `SENSOR_FAULT` ...), read from the `alert` measurement. `since` defaults to 24 h ago and needs a zone (`Z`, or `%2B07:00` in a URL). `400` bad `siteID` or `since`; `500` if InfluxDB cannot be queried |
| `POST /api/v1/sites/<siteID>/ack` body `{"ackBy":"name"}` | `200 {siteID, acked, count, ackTs}`: `count` alerts silenced, `acked:false` if none were active. `400` bad site or name; `404` no node of that site has ever reported |

Decisions and limits:

- **Acknowledgement is per site**, like the MQTT one: it silences reminders for every active alert there; a later escalation alerts again.
- **It acts on the platform only.** The ack events go to the notifier exactly as an MQTT ack would, but nothing is published on `hub/ack` (only the Pi may, §4a) and the Pi is not marked alive. The Pi's buzzer is silenced by its own button or flows.
- **Auth:** HTTP Basic, one operator account (`REST_USER`, default `operator`; `REST_PASSWORD`). Only the SHA-256 of the password is stored in the flow. Without `REST_PASSWORD` the REST nodes are not deployed at all. Basic auth over plain HTTP is readable on the lab network: put TLS in front before any use beyond the lab.
- **History is read with the read-only InfluxDB token**, so Node-RED now holds the read token as well as the write token (`deploy.mjs` passes it in).
- Needs `functionExternalModules: true` (for `crypto`), which this container has.
- Validated: unit tests, the generated flows run with a fake context, five mutation checks, and **16 HTTP checks against the deployed container** (401 with and without a wrong password, 400 on a missing or injected `siteID` and on a `since` without a zone, 404 on an unknown site, 200 history newest first, and a real alert raised by the simulator's `flash_rise`, acknowledged over REST, shown as an `ACKED` row, and a second acknowledge reporting `acked:false`). The live run found that InfluxDB's pivot returns `""` for a missing string field; the unit tests had used `null`, so empty strings are now dropped and tested.

## 14. Pi hub flows and baseline A (built 2026-10-21, not deployed)

`nodered/pi.flows.json` (generated by `nodered/build-pi.js`, core nodes only, no secrets) runs the container's pipeline and alert code on the Pi: one function node (`hub logic`, glue in `build-pi.js`, output rules in `src/hub.js`), five MQTT inputs, a 10 s tick, a heartbeat and two mode buttons. Setup for the equipment owner: `docs/PI_SETUP.md`. Bridge template: `mosquitto/pi-bridge.conf.example`.

| | `edge` (proposed design) | `cloud_only` (baseline A) |
| --- | --- | --- |
| Readings | filtered, alert state machine runs on the Pi | recorded (arrival time) and relayed by the bridge; nothing decided |
| `hub/alert` | published when WARNING / CRITICAL / sensor fault is raised | never |
| `hub/state` (LED, LCD, buzzer) | from the Pi's own state | from the container's retained `platform/alert|sensor` states |
| Button | acknowledges on the Pi | travels to the container, which answers ACKED |

Decisions: the mode is a retained `farm/<site>/hub/mode` message (or the editor buttons), so A/B runs need no redeploy; switching to `edge` drops old alert memory. A dead sensor never shows green. The Pi publishes only `hub/heartbeat|alert|state|mode`, all inside the `hub` user's ACL. **Latency instrumentation:** alert events now carry `seq` (the triggering reading), the Pi records each reading's arrival time, and a `hub/state` after a new alert carries `trace {seq, rx_ms}`; `ts - rx_ms` is reading-to-alarm on one clock, in both modes.

Verified: 16 tests on a fake clock against the simulator (same escalation second as the container, the container's own `hub/alert` reader accepts our payload, the container's own state payloads drive `cloud_only`, mode switches, ack, silent node) and 9 of 10 mutations caught; the tenth changes nothing observable. **Not verified:** a real Pi, real Node-RED import, the bridge, GPIO, RF. The container still runs the previous flows (`seq` is not deployed there, so baseline A needs one redeploy to get `trace`).

## Not yet verified

Content of the existing Lab 7 flow (`/root/.node-red/flows.json`) and the Grafana datasource's query language. Both are
readable now over SSH/API, but only needed at deploy-script time.
