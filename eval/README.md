# Evaluation: scripts, raw results and figures

This folder holds everything behind Section V of the manuscript. All numbers come from our own runs on the rig and the lab container. Host names, account names and IP addresses in the raw output are masked.

## Scripts

| File | What it does | Where it runs |
|---|---|---|
| `bench.sh` | sysbench CPU and memory, dd disk throughput (direct I/O, 4 KiB synced writes). Same script on both hosts. | Pi and container |
| `mqtt_vs_http.py` | Bytes on the wire for one real reading: MQTT (`mosquitto_pub`) against HTTP POST (`curl`), captured with tcpdump on loopback. Reads `MQTT_USER` / `MQTT_PASS` from the environment. | Container |
| `replay_latency.py` | Edge against cloud-only alarm latency. Replays the recorded rise (`replay_profile_take2.json`) as node01, sets the link condition on the Pi-to-platform path (clean, `tc netem` 200 ms + 10 % loss, or `nftables` drop) and counts the bridge bytes. The docstring has the usage and a manual cleanup line. | Pi, as root, ESP32 off |
| `run_replay.sh` | Runs all six cells (edge and cloud_only × clean, impaired, down), modes interleaved. | Pi |
| `figures/latency_plot.py` | Draws the latency figure from `results/replay_results_2026-11-10.csv`. Needs matplotlib. | Anywhere |
| `figures/wiring_schemdraw.py` | Draws the as-built wiring of the ESP32 node and the Pi hub. Needs `schemdraw==0.23` and matplotlib. | Anywhere |

## Results

| File | Content |
|---|---|
| `results/container_bench_2026-11-09.txt`, `results/pi_bench_2026-11-10.txt` | Raw `bench.sh` output (Xeon E5-2680 v4 LXC, Raspberry Pi 4) |
| `results/pi_iperf3_2026-11-10.txt` | Ping, iPerf3 TCP both ways and UDP 10 Mbit/s, Pi to container over Tailscale |
| `results/mqtt_vs_http_2026-11-09.txt` | IP bytes per message for MQTT and HTTP, with and without a persistent connection |
| `results/replay_results_2026-11-10.csv` | One row per replay run: WARNING and CRITICAL latency (ms) with the triggering sequence number, uplink and downlink bytes, rise duration |
| `results/power_2026-11-10.md` | USB power meter readings (whole rig, alarm, ESP32 alone) and the Pi throttle logs next to it |
| `results/take1_*.csv`, `results/take2_*.csv` | Demo runs of 7 Nov from InfluxDB: transport per sequence number (WiFi outage), level and latency per reading, the rise used for the replay |

Notes on `replay_results_2026-11-10.csv`:
- The 13:36 row is the smoke test.
- In rows before 14:21, `up_bytes` and `down_bytes` are cumulative over the runs of a cell (the counter reset was fixed after that). The latency in those rows is valid. The 15:0x rows re-ran the affected cells for the byte counts.
- With the link down, the byte counters see only the dropped send attempts.
