# Hardware tier: ESP32 sensor node and Raspberry Pi hub

This folder holds the part of the system that runs next to the water: the ESP32 sensor node, and the Raspberry Pi hub with its local alarm.
The platform side (filtering, alerts, dashboard) lives in the rest of this repo. The Pi runs the same filter and alert code in Node-RED (`nodered/build-pi.js`).

```
hardware/
  esp32_node/ESP32_Node/ESP32_Node.ino   node firmware v3.4 (Arduino)
  rpi_hub/hub_io.py                       LCD, buzzer, RGB LED and ack button, driven by hub/state
  rpi_hub/rf_gateway.py                   nRF24L01 receiver: republishes an RF reading when its WiFi copy is missing
  rpi_hub/ff_wifi_portal.py               WiFi setup portal for the Pi (own access point + web page)
  rpi_hub/forget_wifi.sh                  makes the node and the Pi forget their WiFi (for a setup demo)
  rpi_hub/build_pi_flows.js               builds pi.flows.ait.json for this rig (site, sensor height, LCD refresh)
  rpi_hub/systemd/                        the four services
  rpi_hub/tools/                          failover test and nRF24L01 link test
```

Comments in the code that cite "Build_Log section N" refer to the team's lab build log. It is kept with the manuscript, not in this repo.

## Parts and wiring

**Sensor node**

| Part | ESP32 pins |
|---|---|
| HC-SR04 | TRIG GPIO27, ECHO GPIO26 through a 10 kΩ / 20 kΩ divider (5 V → 3.3 V), VCC 5 V |
| SHT30 (air temperature) | SDA GPIO21, SCL GPIO22, 3.3 V, address 0x44 or 0x45 |
| nRF24L01 | VSPI: SCK 18, MISO 19, MOSI 23; CE GPIO4, CSN GPIO5; 3.3 V with a decoupling capacitor |
| BOOT button (on board) | hold 3–10 s: forget WiFi; hold more than 10 s: factory reset |

**Pi hub** (Raspberry Pi 4, Raspberry Pi OS Lite 64-bit)

| Part | Pi pins |
|---|---|
| LCD 20×4, PCF8574 backpack | I²C bus 3: SDA GPIO4 (pin 7), SCL GPIO5 (pin 29), address 0x27, 3.3 V |
| Buzzer, MH-FMD module | GPIO18, **active-low** (LOW = sound), 3.3 V |
| RGB LED, HW-479 | R/G/B GPIO22/23/24, common cathode |
| Ack button | GPIO17 to GND, internal pull-up |
| nRF24L01 | SPI0: CE GPIO25 (pin 22), CSN GPIO8/CE0 (pin 24), SCK 23, MOSI 19, MISO 21; 3.3 V with a decoupling capacitor |

Add to `/boot/firmware/config.txt`: `dtparam=spi=on`, `dtparam=i2c_arm=on`, `dtoverlay=i2c3`, and `gpio=18=op,dh` (the buzzer stays silent from boot).

## 1. Flash the node

Libraries: WiFiManager (tzapu) 2.0.17 or later, PubSubClient 2.8, RF24 (TMRh20) 1.6.x. Board: "ESP32 Dev Module" (Espressif core).

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir build hardware/esp32_node/ESP32_Node
esptool --port /dev/ttyUSB0 write-flash 0x10000 build/ESP32_Node.ino.bin   # app only: keeps the saved settings
```

The node starts a portal on first boot: join the WiFi `FlashFlood-Node-XXXX` (password `floodnode`) and open `192.168.4.1`.
Pick the WiFi, then fill in the broker (default `ff-hub.local`, the Pi over mDNS), port, site ID, node ID and the MQTT login.
Over USB serial (115200) the node also takes `status`, `mqtthost`, `mqttuser`, `mqttpass`, `wifi` + `wifipass` and `wififorget`.

The node samples every 2 s. It sends every reading twice: MQTT QoS 0 over WiFi to `farm/<site>/node/<node>/level`, and a raw nRF24L01 packet on channel 108.
While WiFi is down it asks to rejoin every 20 s.

## 2. Set up the Pi

```bash
sudo apt install mosquitto mosquitto-clients python3-gpiozero python3-smbus2 python3-paho-mqtt python3-venv
mkdir -p ~/ff-hub && cp hardware/rpi_hub/*.py hardware/rpi_hub/*.sh ~/ff-hub/
python3 -m venv ~/ff-hub/.venv && ~/ff-hub/.venv/bin/pip install pyrf24 paho-mqtt pyserial esptool
```

1. **Broker.** Turn on passwords and topic rules as on the container (`scripts/mosquitto-auth.sh`), with a user for the hub and one per node, and no anonymous access.
   Copy `mosquitto/pi-queue.conf.example` to `/etc/mosquitto/conf.d/00-queue.conf`. Without it, readings from an uplink outage are lost.
2. **Bridge.** Copy `mosquitto/pi-bridge.conf.example` to `/etc/mosquitto/conf.d/flood-bridge.conf`. Set the container address and the `hub` password.
3. **Login file.** Create `~/ff-hub/hub.env` (mode 600) with `MQTT_USER`, `MQTT_PASS`, `NODERED_USER` and `NODERED_PASS`. Never commit it.
4. **Flows.** Run `node hardware/rpi_hub/build_pi_flows.js`. Import `hardware/rpi_hub/pi.flows.ait.json` into Node-RED on the Pi, enter the broker login in the **hub broker** node, and deploy.
   The script sets this rig's sensor height (36.6 cm) and thresholds (16 / 24 cm). It also sets `stale_after_s` to 30, and `hub.state_refresh_s` to 1 so that the LCD follows every reading.
5. **Services.** Copy `hardware/rpi_hub/systemd/*.service` to `/etc/systemd/system/`, then run `sudo systemctl enable --now ff-hub-io ff-rf-gateway ff-wifi-setup`.
6. **WiFi.** `ff-wifi-setup` opens the setup portal at boot if no saved WiFi is in range: join `FF-Hub-Setup` (password `floodhub`) and open `http://10.42.0.1`.
   Holding the ack button for 8 s forgets the WiFi and opens the portal again. If nobody finishes the setup within 10 min, the Pi restores the WiFi it forgot.
   Also run `nmcli connection modify <wifi> connection.autoconnect-retries 0`: with the default, the Pi stopped retrying during a long outage.

## 3. Use it

- **LCD page 1:** node and state (NORMAL / WARNING / CRITICAL / FAULT), level and rate, sensor state, and the node link (WiFi or RF). The last line shows what was acknowledged and when.
- **LCD page 2** (one press of the button when nothing is sounding): the Pi's WiFi and signal, IP address, node link and reading age, platform link (Cloud OK / DOWN), CPU temperature.
- **Button:** one press acknowledges a sounding alarm. A higher severity sounds again.
- **Mode:** `mosquitto_pub -r -t farm/<site>/hub/mode -m cloud_only` makes the Pi obey the platform's decisions (the baseline). Send `edge` to switch back. The broker keeps the value, so it stays after a reboot.

## 4. Test it

- `tools/nrf_rx_test.py`: checks the Pi's nRF24L01 over SPI, then prints the node's packets.
- `tools/failover_test.py <node-ip> [cut_s] [drop|reject]` (sudo): blocks the node's MQTT traffic with nftables, then reports per reading which path delivered it and how late.
- A real outage: turn off the WiFi access point. The node keeps sending over RF, and the Pi keeps alarming on its own. When the WiFi returns, Grafana fills the gap from the Pi's queue.
