# Evidence

This folder holds the raw material from the simulator phase (October 2026), before the rig was built. The system in this repository produced all of it. Nobody edited it by hand. **All data in this folder is simulated** (node `sim01`, site `demo`). The times are Asia/Bangkok (UTC+7), unless a column says UTC.

The data from the real rig (ESP32 node, Raspberry Pi gateway, November 2026) is in [`eval/results/`](../../eval/results/). [`eval/README.md`](../../eval/README.md) describes it.

## Automated checks

| File | What it shows | How to reproduce |
|---|---|---|
| `test-output.txt` | The 45 unit and scenario tests that existed on 2026-10-21. All of them pass. The repo now has more tests (`npm test`). | `npm test` |
| `mutation-check-output.txt` | 10 deliberate breakages of single rules: the spike gate, the step guard, the temperature correction, the fail-safe, the confirmation, the hysteresis and four fallback rules. Each breakage makes at least one test fail. The tests therefore guard the rules. | `node scripts/mutation-check.mjs` |

## Live data (exported from InfluxDB)

`node scripts/export-evidence.mjs` produces these files. The bucket keeps data for 30 days. If you need more data, **run the script again before the data expires**.

| File | Window (UTC) | What it contains |
|---|---|---|
| `data/2026-10-14-glitches.csv` | 2026-10-14 15:39 to 15:46 | The level is calm until about 15:41:30 (`level_f` 5.7 to 6.1 cm). The `glitches` scenario runs until about 15:44:00 (true level 8.0 cm). Then the level is calm again. During the glitches, the raw distance spikes up to 224 cm and `level_f` stays at 7.7 to 8.1 cm (from 15:42:00, after it settles). The `reject` column shows `range`, `spike` and `stuck`. |
| `data/2026-10-18-level-step-rate-fix.csv` | 2026-10-18 02:27 to 02:34 | Two steps from 6 to 8 cm. After the first step (step rule only), `rate_cm_min` peaks at 0.83. After the second step (step rule and the 45 s minimum), it stays between −0.22 and 0.0. Before the step rule, the same step read +1.9 (screenshot 04). |
| `data/2026-10-18-temp-swing.csv` | 2026-10-18 03:03 to 03:09 | The air warms from 25.1 to 40.2 °C while the true level stays at 10 cm. The file also shows the step up from calm at the start and the return to calm at about 03:08. `temp_corr_cm` grows to 0.72. Between 03:04:30 and 03:07:50, `level_f` stays at 9.72 to 10.31 cm. |
| `data/2026-10-18-alert-lifecycle.csv` | 2026-10-18 03:52 to 04:04 | The scenarios `flash_rise`, acknowledgement, calm, silence (simulator off) and `sensor_dead`. `alert_view` (0 normal, 1 warning, 2 critical, +3 sensor fault) exists only from 04:00:26Z. We added it after we found the dead-sensor tile defect. `alert-rows.csv` holds the earlier states. |
| `data/2026-10-18-fallback-tests.csv` | 2026-10-18 05:10 to 05:21 | The three fallback tests: A (no Pi), B (the Pi covers) and C (the Pi is dead). |
| `data/alert-rows.csv` | all rows that InfluxDB still stores | Every alert state change, with `source` (platform or hub). |
| `data/notification-rows.csv` | all rows that InfluxDB still stores | Every notification decision: `sent` or `suppressed`, and the reason (`fallback: Pi did not send`, `covered by Pi`, `superseded`, `Pi offline` and others). |

The reading files have these columns:
- `distance_cm` (as received)
- `level_cm` (from the temperature-corrected distance)
- `level_f` (filtered)
- `rate_cm_min`
- `quality` (0 good, 1 suspect, 2 bad)
- `alert_view`
- `temp_c`
- `temp_corr_cm`
- `reject` (the reason, only for a rejected reading)
- `valid`

## Dashboard screenshots (`screenshots/`)

We took the screenshots from the browser pane of the build tool on 2026-10-18, while the system ran on simulated data. Four screenshots have the label **DEFECT**. They show a problem that we found during testing, *before* the fix. We kept them on purpose. The report can use them as before-and-after pairs. The width of the pane changed, so a few screenshots show a narrow or phone-style layout.

| File | Shows |
|---|---|
| `01-dashboard-first-view-calm.jpg`, `02-...lower-panels.jpg` | The first review of the dashboard on calm data (level 6.2 cm, quality good). |
| `03-DEFECT-level-axis-stretched-by-rejected-spike.jpg` | One rejected −125 cm spike stretched the axis and flattened the real signal. Fixed bounds of 0 to 28 cm fixed the defect. |
| `04-DEFECT-rate-bump-after-level-step.jpg` | A level step read as a rise of about 1.9 cm/min for a minute (a false-alarm risk). The step rule and a minimum of 45 s fixed the defect. |
| `05-glitches-rejects-table-and-quality-timeline.jpg` | The rejects by reason (range 4, spike 2, stuck 2) and the quality timeline that goes to suspect. |
| `06-level-axis-fixed-with-threshold-lines.jpg` | The dashboard after the axis fix, with visible warning and critical lines. |
| `07-temp-swing-40C-level-stays-flat.jpg` | The air is at 40 °C. The level tile still shows the true 10 cm. |
| `08-DEFECT-alert-tile-NORMAL-while-sensor-silent.jpg` | The tile showed a green NORMAL while the sensor was silent for 2 minutes. The combined sensor-fault view fixed the defect. |
| `09-sensor-dead-warning-plus-sensor-fault.jpg` | The fixed tile: "WARNING + SENSOR FAULT", quality bad. |
| `10-DEFECT-history-tables-show-one-group.jpg` | The history tables hid all but one group. Merging the groups fixed the defect. |
| `11-sensor-fault-tile-recovering.jpg`, `12-alert-timelines-and-history-tables.jpg` | The recovery after the fault. The alert timeline and the history tables are complete. |
| `13-DEFECT-line-bridges-outage.png`, `14-outage-shown-as-gap-dots.jpg` | A connected line hid an outage of 2.5 minutes. With dots, the outage shows as a gap. |
| `15-final-dashboard-pi-hub-tile-phone-layout.jpg` | The dashboard at that time (with the tile "Pi hub last seen") in the phone-style layout. |

## Rig data and benchmarks

These items are in [`eval/results/`](../../eval/results/), not in this folder: the benchmarks (sysbench, dd and iPerf3), the measured current draw, the demonstration runs with the real sensor and the edge against cloud-only latency runs on the Raspberry Pi.

The ruler calibration of the level (MAE 0.25 cm in the report) has no raw file in the repository yet.
