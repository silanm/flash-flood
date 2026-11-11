#!/usr/bin/env bash
# Demo "WiFi setup from scratch": make the ESP32 node AND the Pi hub forget their WiFi (Build_Log section 21).
# Run on the Pi:   ~/ff-hub/forget_wifi.sh            (asks you to type FORGET first)
#   --node-only    only the ESP32 (over USB serial: "wififorget" = holding BOOT 3-10 s)
#   --pi-only      only the Pi (ff-wifi-reset.service = holding the ack button 8 s)
# Kept: the ESP32's broker / site / node / MQTT login, and everything on the Pi except its saved WiFi.
# Afterwards:
#   ESP32  AP "FlashFlood-Node-XXXX", password floodnode, page 192.168.4.1. Pick the WiFi, leave the MQTT
#          fields as they are and the MQTT password EMPTY (keeps the saved one). Its portal closes after 3 min
#          and reopens after a reboot, until a WiFi is set. There is no automatic restore.
#   Pi     AP "FF-Hub-Setup", password floodhub, page http://10.42.0.1; the LCD shows the steps.
#          If nobody finishes the setup within 10 min, the Pi restores the WiFi it forgot.
# The ESP32 is done first, while the Pi is still online; the Pi's SSH session drops when its WiFi goes.
# The ESP32 must be on the Pi's USB (/dev/ttyUSB0). Opening the port resets it once.
set -euo pipefail
mode=${1:-all}

case $mode in --node-only) who="the ESP32" ;; --pi-only) who="the Pi" ;; *) who="BOTH the ESP32 and the Pi" ;; esac
read -rp "This makes $who forget the WiFi. Type FORGET to continue: " ans
[[ $ans == FORGET ]] || { echo "cancelled"; exit 1; }

if [[ $mode != --pi-only ]]; then
  ~/ff-hub/.venv/bin/python - <<'PY'
import serial, sys, time
s = serial.Serial("/dev/ttyUSB0", 115200, timeout=0.2)
time.sleep(6)                                  # the port open resets the ESP32; let it boot
s.reset_input_buffer()
s.write(b"wififorget\n")
t, buf = time.time(), b""
while time.time() - t < 6 and b"WiFi forgotten" not in buf:
    buf += s.read(4096)
ok = b"WiFi forgotten" in buf
print("[esp32]", "WiFi forgotten, rebooting into the portal (AP FlashFlood-Node-XXXX)" if ok
      else "no confirmation: is the ESP32 on /dev/ttyUSB0 and running firmware v3.3+?")
sys.exit(0 if ok else 1)
PY
fi

if [[ $mode != --node-only ]]; then
  echo "[pi] forgetting all saved WiFi and opening the FF-Hub-Setup portal (SSH drops now)"
  sudo systemctl start --no-block ff-wifi-reset.service
fi
