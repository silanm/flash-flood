# Evidence

Raw material for the report's evaluation section. Everything here was produced by the system in this repository; nothing is
edited by hand. **All data is simulated** (node `sim01`, site `demo`); no real sensor has been connected yet.
Times are Asia/Bangkok (UTC+7) unless a column says UTC.

## Automated checks

| File | What it shows | How to reproduce |
|---|---|---|
| `test-output.txt` | the 45 unit and scenario tests, all passing | `npm test` |
| `mutation-check-output.txt` | 10 deliberate breakages of single rules (spike gate, step guard, temperature correction, fail-safe, confirmation, hysteresis, four fallback rules); each one makes at least one test fail, so the tests really guard the rules | `node scripts/mutation-check.mjs` |

## Live data (exported from InfluxDB)

Produced by `node scripts/export-evidence.mjs`. The bucket keeps 30 days, so **re-run it before data ages out** if more is needed.

| File | Window (UTC) | What it contains |
|---|---|---|
| `data/2026-10-14-glitches.csv` | 2026-10-14 15:39 to 15:46 | calm until about 15:41:30 (`level_f` 5.7 to 6.1 cm), the `glitches` scenario until about 15:44:00 (true level 8.0 cm), then calm again. During the glitches the raw distance spikes up to 224 cm while `level_f` stays 7.7 to 8.1 cm (from 15:42:00, once settled); the `reject` column shows `range`, `spike`, `stuck` |
| `data/2026-10-18-level-step-rate-fix.csv` | 2026-10-18 02:27 to 02:34 | two 6 to 8 cm steps. After the first (step rule only) `rate_cm_min` peaks at 0.83; after the second (step rule plus the 45 s minimum) it stays between -0.22 and 0.0. Before the step rule the same step read +1.9 (screenshot 04) |
| `data/2026-10-18-temp-swing.csv` | 2026-10-18 03:03 to 03:09 | air warming 25.1 to 40.2 C with the true level held at 10 cm (the file also shows the step up from calm at the start and the return to calm at about 03:08); `temp_corr_cm` grows to 0.72; between 03:04:30 and 03:07:50 `level_f` stays 9.72 to 10.31 |
| `data/2026-10-18-alert-lifecycle.csv` | 2026-10-18 03:52 to 04:04 | `flash_rise`, acknowledgement, calm, silence (simulator off), `sensor_dead`; `alert_view` (0 normal, 1 warning, 2 critical, +3 sensor fault) exists only from 04:00:26Z, because it was added after the dead-sensor tile defect; the earlier states are in `alert-rows.csv` |
| `data/2026-10-18-fallback-tests.csv` | 2026-10-18 05:10 to 05:21 | the three fallback tests (A no Pi, B Pi covers, C Pi dead) |
| `data/alert-rows.csv` | all still stored | every alert state change, with `source` (platform / hub) |
| `data/notification-rows.csv` | all still stored | every notification decision: `sent` or `suppressed`, and why (`fallback: Pi did not send`, `covered by Pi`, `superseded`, `Pi offline`, ...) |

Columns in the reading files: `distance_cm` (as received), `level_cm` (from the temperature-corrected distance), `level_f` (filtered), `rate_cm_min`,
`quality` (0 good, 1 suspect, 2 bad), `alert_view`, `temp_c`, `temp_corr_cm`, `reject` (reason, only when rejected), `valid`.

## Dashboard screenshots (`screenshots/`)

Taken from the browser pane of the build tool on 2026-10-18, while the system was running on simulated data. Four are marked **DEFECT**: they
show a problem found during testing, *before* the fix, and are kept on purpose because the report can use them as before / after pairs.
The pane's width varied, so a few are in a narrow or phone-style layout.

| File | Shows |
|---|---|
| `01-dashboard-first-view-calm.jpg`, `02-...lower-panels.jpg` | the first review of the dashboard on calm data (level 6.2 cm, quality good) |
| `03-DEFECT-level-axis-stretched-by-rejected-spike.jpg` | one rejected -125 cm spike stretched the axis and flattened the real signal; fixed by fixed bounds of 0 to 28 cm |
| `04-DEFECT-rate-bump-after-level-step.jpg` | a level step read as a rise of about 1.9 cm/min for a minute (false-alarm risk); fixed by the step rule and a 45 s minimum |
| `05-glitches-rejects-table-and-quality-timeline.jpg` | rejects counted by reason (range 4, spike 2, stuck 2) and the quality timeline going suspect |
| `06-level-axis-fixed-with-threshold-lines.jpg` | after the axis fix: warning and critical lines visible |
| `07-temp-swing-40C-level-stays-flat.jpg` | air at 40 C, level tile still reads the true 10 cm |
| `08-DEFECT-alert-tile-NORMAL-while-sensor-silent.jpg` | the tile showed green NORMAL while the sensor had been silent for 2 minutes; fixed by the combined sensor-fault view |
| `09-sensor-dead-warning-plus-sensor-fault.jpg` | the fixed tile: "WARNING + SENSOR FAULT", quality bad |
| `10-DEFECT-history-tables-show-one-group.jpg` | history tables hid all but one group; fixed by merging them |
| `11-sensor-fault-tile-recovering.jpg`, `12-alert-timelines-and-history-tables.jpg` | recovery after the fault; alert timeline and history tables complete |
| `13-DEFECT-line-bridges-outage.png`, `14-outage-shown-as-gap-dots.jpg` | a connected line hid a 2.5-minute outage; as dots the outage is a visible gap |
| `15-final-dashboard-pi-hub-tile-phone-layout.jpg` | the current dashboard (with the "Pi hub last seen" tile) in the phone-style layout |

## Not here yet

Benchmarks (sysbench, dd, iPerf3), measured current draw, any real-sensor data, and anything involving the Raspberry Pi: none of these exist yet.
