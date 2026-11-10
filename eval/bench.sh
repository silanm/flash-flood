#!/usr/bin/env bash
# Section V benchmarks, identical on the Pi hub and the platform container. Raw output goes to stdout; keep it.
# Usage: bench.sh <label> <dd-dir> [dd-MiB]     e.g. bench.sh container /var/lib/influxdb 1024
set -u
label=$1 dir=$2 mib=${3:-1024}
echo "=== $label  $(date -Is)  $(hostname)"
uname -srm; grep -m1 -E "model name|Model" /proc/cpuinfo; nproc; free -m | sed -n 2p; uptime
command -v vcgencmd >/dev/null && { vcgencmd measure_temp; vcgencmd get_throttled; }

echo; echo "=== sysbench cpu, 1 thread"
sysbench cpu --cpu-max-prime=20000 --threads=1 --time=30 run
echo; echo "=== sysbench cpu, $(nproc) threads"
sysbench cpu --cpu-max-prime=20000 --threads="$(nproc)" --time=30 run
echo; echo "=== sysbench memory, 1 thread, 1 KiB blocks, 10 GiB"
sysbench memory --memory-block-size=1K --memory-total-size=10G --threads=1 run

# dd: direct I/O so the page cache does not inflate the numbers; the file is removed afterwards
f="$dir/dd_bench.$$"
echo; echo "=== dd write ${mib} MiB, oflag=direct, conv=fdatasync -> $dir"
dd if=/dev/zero of="$f" bs=1M count="$mib" oflag=direct conv=fdatasync 2>&1 | tail -1
echo "=== dd read ${mib} MiB, iflag=direct"
dd if="$f" of=/dev/null bs=1M iflag=direct 2>&1 | tail -1
echo "=== dd write 4 KiB x 2000, oflag=dsync (small synced writes, like a database commit)"
dd if=/dev/zero of="$f" bs=4k count=2000 oflag=dsync 2>&1 | tail -1
rm -f "$f"
command -v vcgencmd >/dev/null && { echo; vcgencmd measure_temp; vcgencmd get_throttled; }
echo "=== done $(date -Is)"
