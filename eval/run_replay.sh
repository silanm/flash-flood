#!/usr/bin/env bash
# All six cells of the edge vs cloud_only replay, modes interleaved. Run on the Pi as root, detached, with the ESP32 off:
#   sudo PLATFORM_IP=<ip> setsid nohup ./run_replay.sh [runs=3] >> ~/ff-hub/replay.log 2>&1 < /dev/null &
cd "$(dirname "$0")"
runs=${1:-3}
for cond in clean impaired down; do
  for mode in edge cloud_only; do
    echo "### $(date -Is) $mode $cond"
    /home/pi/ff-hub/.venv/bin/python replay_latency.py "$mode" "$cond" "$runs"
  done
done
echo "### ALL DONE $(date -Is)"
