/*
 * Flash Flood Early Warning - ESP32 sensor node (v3.4: platform contract + nRF24L01 hot standby + 2-level reset + serial WiFi/broker setup + wififorget + WiFi rejoin watchdog)
 *
 * Boot flow:
 *   1. BOOT button (GPIO0) while running (do NOT hold BOOT while pressing EN: that is flash-download mode):
 *        hold 3-10 s, then release -> forget WiFi only (MQTT/site/node settings kept), reboot into the portal
 *        hold > 10 s               -> factory reset: WiFi + all settings, reboot into the portal
 *      The on-board LED (GPIO2) lights at 3 s and blinks fast after 10 s.
 *   2. No saved WiFi (or it fails)  -> ESP32 opens AP "FlashFlood-Node-XXXX"
 *      (password: floodnode). Join it, captive portal opens (or browse to
 *      192.168.4.1), pick WiFi, enter password + MQTT broker/site/node. The MQTT password field is
 *      always shown empty (never echoed into the page); leave it empty to keep the saved one.
 *   3. Connected -> wait for NTP time, then publish one raw HC-SR04 reading per sample.
 *
 * MQTT contract (teammate's platform, ARCHITECTURE.md section 4):
 *   farm/<site>/node/<node>/level   NOT retained, one message per sample (every 2 s):
 *     {"seq":N,"ts":"2026-10-23T07:00:00.123Z","distance_cm":37.4|null,
 *      "filtered_cm":37.3|null,"temp_c":27.4|null,"rh_pct":61.2|null,"transport":"wifi","rssi":-50}
 *     distance_cm = raw single echo (null on echo timeout), filtered_cm = median of last 5 valid.
 *     Speed of sound assumed 343 m/s (0.0343 cm/us). No temperature compensation here: the platform
 *     compensates with temp_c. temp_c/rh_pct come from an SHT30 on I2C (SDA 21, SCL 22, 0x44 or 0x45),
 *     read every sample; null when no SHT30 answers (auto-detected, can be plugged in later + reboot).
 *   farm/<site>/node/<node>/status  "online" / "offline" (LWT), retained
 *   QoS 0: PubSubClient cannot publish QoS 1. seq lets the platform see gaps.
 *
 * RF hot standby (v3, 2026-10-25): EVERY reading is sent over MQTT and also over nRF24L01 to the
 * Pi hub (RfPacket below). The Pi's rf_gateway.py drops the RF copy when the WiFi copy arrived
 * within 3 s, otherwise it publishes it on the same topic with "transport":"rf".
 * Reason: a QoS 0 publish into a half-open TCP socket reports success, so the node itself cannot
 * tell that WiFi is losing data (Build_Log.md section 10). The hub can, by seq.
 *
 * Serial commands (115200, end with newline):
 *   mqttuser <name>   MQTT username (default: node ID)
 *   mqttpass <pw>     MQTT password (kept in NVS, never printed)
 *   mqtthost <host>   MQTT broker host or IP (kept in NVS), reconnects at once
 *   wifi <ssid>       WiFi network for the next "wifipass" (v3.2: change WiFi without the portal)
 *   wifipass [<pw>]   join that network now and save it (no argument = open network). The old
 *                     network is forgotten; if the new one is not in range, the node keeps retrying it
 *                     (and after a reboot opens the portal for 3 min, then retries)
 *   wififorget        same as holding BOOT 3-10 s: forget WiFi only (MQTT/site/node kept), reboot into the portal
 *   status            print link state
 *
 * Libraries: WiFiManager (tzapu) >= 2.0.17, PubSubClient 2.8, RF24 (TMRh20) 1.6.x
 * Board: "ESP32 Dev Module" (esp32 core by Espressif)
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <Preferences.h>
#include <SPI.h>
#include <RF24.h>
#include <Wire.h>
#include <time.h>
#include <sys/time.h>

// ---------- Pins (Build_Log.md section 1/3) ----------
const int PIN_TRIG = 27;
const int PIN_ECHO = 26;      // via 10k/20k divider (5 V -> 3.3 V)
const int PIN_RESET_BTN = 0;  // on-board BOOT button
const int PIN_LED = 2;        // on-board LED: reset-hold feedback
const int PIN_RF_CE = 4;      // nRF24L01 on VSPI (18/19/23)
const int PIN_RF_CSN = 5;
const int PIN_SDA = 21;     // SHT30 (3.3 V)
const int PIN_SCL = 22;
const unsigned long RESET_HOLD_MS = 3000;     // release after this: forget WiFi only
const unsigned long FACTORY_HOLD_MS = 10000;  // held this long: factory reset

// ---------- Timing ----------
const unsigned long SAMPLE_MS = 2000;   // one reading (and one message) per sample
const int MEDIAN_N            = 5;      // filtered_cm only; the platform filters the raw value itself

// ---------- Radio (must match the Pi's rf_gateway.py) ----------
const uint8_t HUB_ADDR[6] = "FFHUB";
const uint8_t RF_CHANNEL  = 108;        // 2.508 GHz, above WiFi channels 1-13

struct __attribute__((packed)) RfPacket {   // 30 bytes, little-endian
  uint8_t  ver;          // 2
  char     node[8];      // node ID, NUL-padded
  uint8_t  flags;        // bit0: ts valid
  uint32_t seq;
  uint64_t ts_ms;        // Unix epoch ms (UTC)
  int16_t  dist_mm;      // raw echo, -1 = null (timeout)
  int16_t  filt_mm;      // median, -1 = null
  int16_t  temp_cc;      // 0.01 degC, INT16_MIN = null
  int16_t  rh_cpct;      // 0.01 %RH, INT16_MIN = null
};

// ---------- Settings (saved in flash via Preferences) ----------
char mqttHost[64]  = "ff-hub.local";   // the Pi hub broker (mDNS)
char mqttPort[6]   = "1883";
char siteId[16]    = "ait";
char nodeId[16]    = "node01";
char mqttUser[32]  = "";      // empty -> node ID
char mqttPass[64]  = "";      // set over serial: mqttpass <pw>

Preferences prefs;
WiFiClient netClient;
PubSubClient mqtt(netClient);
RF24 radio(PIN_RF_CE, PIN_RF_CSN);
bool shouldSaveConfig = false;
bool rfReady = false;
uint8_t shtAddr = 0;          // 0 = no SHT30 found
float tempC = NAN, rhPct = NAN;

String topicLevel, topicStatus, clientId;
float samples[MEDIAN_N];
int sampleCount = 0, sampleIdx = 0;
uint32_t seq = 0;
unsigned long lastSample = 0, lastMqttTry = 0, wifiDownSince = 0, lastWifiKick = 0;
unsigned long btnDownSince = 0;
uint32_t wifiOk = 0, wifiFail = 0, rfAck = 0, rfNoAck = 0;   // since boot
String serialLine;
String pendingSsid;            // set by "wifi <ssid>", used by "wifipass"

// ---------------------------------------------------------------------
void loadSettings() {
  prefs.begin("node", true);
  prefs.getString("host", mqttHost, sizeof(mqttHost));
  prefs.getString("port", mqttPort, sizeof(mqttPort));
  prefs.getString("site", siteId, sizeof(siteId));
  prefs.getString("node", nodeId, sizeof(nodeId));
  prefs.getString("muser", mqttUser, sizeof(mqttUser));
  prefs.getString("mpass", mqttPass, sizeof(mqttPass));
  prefs.end();
}

void saveSettings() {
  prefs.begin("node", false);
  prefs.putString("host", mqttHost);
  prefs.putString("port", mqttPort);
  prefs.putString("site", siteId);
  prefs.putString("node", nodeId);
  prefs.putString("muser", mqttUser);
  prefs.putString("mpass", mqttPass);
  prefs.end();
  Serial.println("[CFG] settings saved");
}

void resetAndRestart(bool factory) {
  WiFiManager wm;
  wm.resetSettings();               // saved WiFi credentials
  if (factory) {
    prefs.begin("node", false);
    prefs.clear();                  // broker, site, node, MQTT login
    prefs.end();
  }
  Serial.println(factory ? "[CFG] factory reset: WiFi + all settings erased, rebooting into the portal"
                         : "[CFG] WiFi forgotten (settings kept), rebooting into the portal");
  delay(500);
  ESP.restart();
}

void checkResetButton() {
  unsigned long held = btnDownSince ? millis() - btnDownSince : 0;
  if (digitalRead(PIN_RESET_BTN) == HIGH) {             // released
    if (held >= RESET_HOLD_MS) resetAndRestart(false);
    if (btnDownSince) digitalWrite(PIN_LED, LOW);
    btnDownSince = 0;
    return;
  }
  if (btnDownSince == 0) {
    btnDownSince = millis();
    Serial.println("[CFG] BOOT pressed: release after 3 s = forget WiFi, hold 10 s = factory reset");
  } else if (held >= FACTORY_HOLD_MS) {
    for (int i = 0; i < 10; i++) { digitalWrite(PIN_LED, i % 2); delay(60); }
    resetAndRestart(true);
  } else if (held >= RESET_HOLD_MS) {
    digitalWrite(PIN_LED, HIGH);
  }
}

// ---------------------------------------------------------------------
void startWiFi() {
  WiFiManager wm;

  loadSettings();

  WiFiManagerParameter pHost("host", "MQTT broker", mqttHost, sizeof(mqttHost) - 1);
  WiFiManagerParameter pPort("port", "MQTT port", mqttPort, sizeof(mqttPort) - 1);
  WiFiManagerParameter pSite("site", "Site ID", siteId, sizeof(siteId) - 1);
  WiFiManagerParameter pNode("node", "Node ID", nodeId, sizeof(nodeId) - 1);
  WiFiManagerParameter pUser("muser", "MQTT user (empty = node ID)", mqttUser, sizeof(mqttUser) - 1);
  WiFiManagerParameter pPass("mpass", mqttPass[0] ? "MQTT password (saved; leave empty to keep)" : "MQTT password",
                             "", sizeof(mqttPass) - 1, "type='password'");   // never echo the secret into the page
  wm.addParameter(&pHost);
  wm.addParameter(&pPort);
  wm.addParameter(&pSite);
  wm.addParameter(&pNode);
  wm.addParameter(&pUser);
  wm.addParameter(&pPass);
  wm.setSaveParamsCallback([]() { shouldSaveConfig = true; });
  wm.setSaveConfigCallback([]() { shouldSaveConfig = true; });

  wm.setConfigPortalTimeout(180);  // no one configures in 3 min -> reboot and retry

  uint8_t mac[6];
  WiFi.macAddress(mac);
  char apName[32];
  snprintf(apName, sizeof(apName), "FlashFlood-Node-%02X%02X", mac[4], mac[5]);
  Serial.printf("[WiFi] connecting, or opening portal AP \"%s\"\n", apName);

  if (!wm.autoConnect(apName, "floodnode")) {
    Serial.println("[WiFi] portal timed out -> restart");
    delay(1000);
    ESP.restart();
  }

  if (shouldSaveConfig) {
    strlcpy(mqttHost, pHost.getValue(), sizeof(mqttHost));
    strlcpy(mqttPort, pPort.getValue(), sizeof(mqttPort));
    strlcpy(siteId, pSite.getValue(), sizeof(siteId));
    strlcpy(nodeId, pNode.getValue(), sizeof(nodeId));
    strlcpy(mqttUser, pUser.getValue(), sizeof(mqttUser));
    if (pPass.getValue()[0]) strlcpy(mqttPass, pPass.getValue(), sizeof(mqttPass));
    saveSettings();
  }

  Serial.printf("[WiFi] connected to \"%s\", IP %s\n",
                WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
}

// ---------------------------------------------------------------------
bool timeValid() { return time(nullptr) > 1700000000; }  // after Nov 2023 = NTP has synced

uint64_t epochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}

void isoTs(uint64_t ms, char *out, size_t n) {
  time_t s = ms / 1000;
  struct tm t;
  gmtime_r(&s, &t);
  size_t k = strftime(out, n, "%Y-%m-%dT%H:%M:%S", &t);
  snprintf(out + k, n - k, ".%03uZ", (unsigned)(ms % 1000));
}

// ---------------------------------------------------------------------
bool connectMqtt() {
  const char *user = mqttUser[0] ? mqttUser : nodeId;
  Serial.printf("[MQTT] connecting to %s:%s as %s (user %s) ... ", mqttHost, mqttPort, clientId.c_str(), user);
  // LWT: broker publishes "offline" (retained) if this node drops off
  bool ok = mqttPass[0]
    ? mqtt.connect(clientId.c_str(), user, mqttPass, topicStatus.c_str(), 1, true, "offline")
    : mqtt.connect(clientId.c_str(), topicStatus.c_str(), 1, true, "offline");
  if (ok) {
    Serial.println("OK");
    mqtt.publish(topicStatus.c_str(), "online", true);
  } else {
    Serial.printf("failed, state=%d\n", mqtt.state());
  }
  return ok;
}

void startRadio() {
  if (!radio.begin() || !radio.isChipConnected()) {
    Serial.println("[RF] nRF24L01 not responding -> RF fallback disabled");
    return;
  }
  radio.setChannel(RF_CHANNEL);
  radio.setDataRate(RF24_1MBPS);
  radio.setPALevel(RF24_PA_LOW);
  radio.setPayloadSize(sizeof(RfPacket));
  radio.setRetries(5, 15);
  radio.stopListening(HUB_ADDR);   // TX only, destination = hub
  rfReady = true;
  Serial.printf("[RF] ready, ch %u, payload %u bytes\n", RF_CHANNEL, (unsigned)sizeof(RfPacket));
}

// ---------------------------------------------------------------------
// SHT30: single shot, high repeatability, no clock stretching (0x24 0x00), 6-byte answer with CRC-8 (0x31).
uint8_t shtCrc(const uint8_t *d) {
  uint8_t c = 0xFF;
  for (int i = 0; i < 2; i++) {
    c ^= d[i];
    for (int b = 0; b < 8; b++) c = (c & 0x80) ? (c << 1) ^ 0x31 : c << 1;
  }
  return c;
}

void startSht() {
  Wire.begin(PIN_SDA, PIN_SCL, 100000);
  for (uint8_t a : {0x44, 0x45}) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { shtAddr = a; break; }
  }
  if (shtAddr) Serial.printf("[SHT] SHT30 found at 0x%02X\n", shtAddr);
  else Serial.println("[SHT] no SHT30 on SDA21/SCL22 -> temp_c null");
}

void readSht() {
  tempC = rhPct = NAN;
  if (!shtAddr) return;
  Wire.beginTransmission(shtAddr);
  Wire.write(0x24); Wire.write(0x00);
  if (Wire.endTransmission() != 0) return;
  delay(16);                                   // max measurement time, high repeatability
  uint8_t d[6];
  if (Wire.requestFrom(shtAddr, (uint8_t)6) != 6) return;
  for (int i = 0; i < 6; i++) d[i] = Wire.read();
  if (shtCrc(d) != d[2] || shtCrc(d + 3) != d[5]) return;
  tempC = -45.0f + 175.0f * ((d[0] << 8) | d[1]) / 65535.0f;
  rhPct = 100.0f * ((d[3] << 8) | d[4]) / 65535.0f;
}

void fmtNum(char *out, size_t n, float v) {
  if (isnan(v)) strlcpy(out, "null", n);
  else snprintf(out, n, "%.2f", v);
}

// ---------------------------------------------------------------------
float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);  // 30 ms ~ 5 m
  if (us == 0) return -1;                             // no echo
  return us * 0.0343f / 2.0f;                         // 343 m/s
}

float median(float *v, int n) {
  float s[MEDIAN_N];
  memcpy(s, v, n * sizeof(float));
  for (int i = 1; i < n; i++) {           // insertion sort, n is tiny
    float k = s[i];
    int j = i - 1;
    while (j >= 0 && s[j] > k) { s[j + 1] = s[j]; j--; }
    s[j + 1] = k;
  }
  return s[n / 2];
}

void fmtCm(char *out, size_t n, float cm) {
  if (cm < 0) strlcpy(out, "null", n);
  else snprintf(out, n, "%.1f", cm);
}

bool publishWifi(uint32_t s, uint64_t ts, float raw, float filt) {
  if (!mqtt.connected()) return false;
  char tsBuf[32], rawBuf[12], filtBuf[12], tBuf[12], hBuf[12], payload[230];
  isoTs(ts, tsBuf, sizeof(tsBuf));
  fmtCm(rawBuf, sizeof(rawBuf), raw);
  fmtCm(filtBuf, sizeof(filtBuf), filt);
  fmtNum(tBuf, sizeof(tBuf), tempC);
  fmtNum(hBuf, sizeof(hBuf), rhPct);
  snprintf(payload, sizeof(payload),
           "{\"seq\":%lu,\"ts\":\"%s\",\"distance_cm\":%s,\"filtered_cm\":%s,"
           "\"temp_c\":%s,\"rh_pct\":%s,\"transport\":\"wifi\",\"rssi\":%d}",
           (unsigned long)s, tsBuf, rawBuf, filtBuf, tBuf, hBuf, WiFi.RSSI());
  bool ok = mqtt.publish(topicLevel.c_str(), payload, false);
  Serial.printf("[PUB] %s -> %s\n", payload, ok ? "ok" : "FAIL");
  return ok;
}

bool publishRf(uint32_t s, uint64_t ts, float raw, float filt) {
  if (!rfReady) return false;
  RfPacket p = {};
  p.ver = 2;
  strncpy(p.node, nodeId, sizeof(p.node));
  p.flags = timeValid() ? 1 : 0;
  p.seq = s;
  p.ts_ms = ts;
  p.dist_mm = raw < 0 ? -1 : (int16_t)lroundf(raw * 10.0f);
  p.filt_mm = filt < 0 ? -1 : (int16_t)lroundf(filt * 10.0f);
  p.temp_cc = isnan(tempC) ? INT16_MIN : (int16_t)lroundf(tempC * 100.0f);
  p.rh_cpct = isnan(rhPct) ? INT16_MIN : (int16_t)lroundf(rhPct * 100.0f);
  bool ok = radio.write(&p, sizeof(p));
  Serial.printf("[RF ] seq %lu dist %d mm -> %s\n", (unsigned long)s, p.dist_mm, ok ? "ACK" : "no ack");
  return ok;
}

// ---------------------------------------------------------------------
void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') { if (serialLine.length() < 120) serialLine += c; continue; }
    String line = serialLine; serialLine = "";
    line.trim();
    if (line.startsWith("mqttpass ")) {
      strlcpy(mqttPass, line.substring(9).c_str(), sizeof(mqttPass));
      saveSettings();
      Serial.println("[CFG] MQTT password set, reconnecting");
      mqtt.disconnect();
    } else if (line.startsWith("mqttuser ")) {
      strlcpy(mqttUser, line.substring(9).c_str(), sizeof(mqttUser));
      saveSettings();
      Serial.printf("[CFG] MQTT user set to %s, reconnecting\n", mqttUser);
      mqtt.disconnect();
    } else if (line.startsWith("mqtthost ")) {
      strlcpy(mqttHost, line.substring(9).c_str(), sizeof(mqttHost));
      saveSettings();
      mqtt.disconnect();
      mqtt.setServer(mqttHost, atoi(mqttPort));
      lastMqttTry = 0;
      Serial.printf("[CFG] MQTT broker set to %s, reconnecting\n", mqttHost);
    } else if (line.startsWith("wifi ")) {
      pendingSsid = line.substring(5);
      Serial.printf("[CFG] WiFi SSID \"%s\" noted; now send: wifipass <pw>\n", pendingSsid.c_str());
    } else if (line == "wifipass" || line.startsWith("wifipass ")) {
      if (!pendingSsid.length()) { Serial.println("[CFG] send wifi <ssid> first"); continue; }
      String pw = line.length() > 9 ? line.substring(9) : "";
      Serial.printf("[CFG] joining \"%s\" (saved for next boot)\n", pendingSsid.c_str());
      mqtt.disconnect();
      WiFi.persistent(true);                 // store in the WiFi NVS that WiFiManager's autoConnect uses
      WiFi.disconnect(false, false);
      WiFi.begin(pendingSsid.c_str(), pw.length() ? pw.c_str() : nullptr);
      pendingSsid = "";
    } else if (line == "wififorget") {
      resetAndRestart(false);
    } else if (line == "status") {
      Serial.printf("[STAT] site %s node %s broker %s:%s user %s pass %s | wifi %s \"%s\" %s rssi %d | mqtt %s | rf %s | seq %lu | time %s\n",
                    siteId, nodeId, mqttHost, mqttPort, mqttUser[0] ? mqttUser : nodeId, mqttPass[0] ? "set" : "none",
                    WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                    mqtt.connected() ? "up" : "down", rfReady ? "ready (hot standby)" : "off",
                    (unsigned long)seq, timeValid() ? "ok" : "not synced");
      Serial.printf("[STAT] SHT30 %s, temp %.2f C, rh %.1f %%\n", shtAddr ? "found" : "absent", tempC, rhPct);
      Serial.printf("[STAT] since boot: mqtt ok %lu fail %lu | rf ack %lu no-ack %lu\n",
                    (unsigned long)wifiOk, (unsigned long)wifiFail, (unsigned long)rfAck, (unsigned long)rfNoAck);
    } else if (line.length()) {
      Serial.println("[CFG] commands: mqttuser <name> | mqttpass <pw> | mqtthost <host> | wifi <ssid> | wifipass [<pw>] | wififorget | status");
    }
  }
}

// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Flash Flood ESP32 node v3.4 ===");

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  startRadio();
  startSht();
  startWiFi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // UTC; ts is ISO-8601 with Z

  topicLevel  = String("farm/") + siteId + "/node/" + nodeId + "/level";
  topicStatus = String("farm/") + siteId + "/node/" + nodeId + "/status";
  clientId    = String("ff-") + nodeId + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);

  mqtt.setServer(mqttHost, atoi(mqttPort));
  mqtt.setBufferSize(512);    // payload with temp/rh is ~240 B incl. topic; default 256 is too tight
  mqtt.setSocketTimeout(2);   // don't stall sampling for 15 s when the broker is unreachable
  netClient.setTimeout(2000);
  connectMqtt();
}

void loop() {
  checkResetButton();
  handleSerial();

  // keep MQTT alive; retry every 5 s without blocking sampling for long
  if (!mqtt.connected() && millis() - lastMqttTry > 5000) {
    lastMqttTry = millis();
    if (WiFi.status() != WL_CONNECTED) Serial.println("[WiFi] link down, auto-reconnecting...");
    else connectMqtt();
  }
  // v3.4: the core's auto-reconnect gave up after a 9 min hotspot outage (Build_Log section 22).
  // While the link stays down, ask again for the saved network every 20 s; WiFi.begin() returns at once.
  if (WiFi.status() == WL_CONNECTED) wifiDownSince = 0;
  else if (!wifiDownSince) wifiDownSince = millis();
  else if (millis() - wifiDownSince > 20000 && millis() - lastWifiKick > 20000) {
    lastWifiKick = millis();
    Serial.println("[WiFi] still down, rejoining saved network");
    WiFi.disconnect(false, false);
    WiFi.begin();
  }
  mqtt.loop();

  if (millis() - lastSample < SAMPLE_MS) return;
  lastSample = millis();

  if (!timeValid()) {   // the platform needs real timestamps; NTP normally syncs in a few seconds
    Serial.println("[NTP] waiting for time sync...");
    return;
  }

  float d = readDistanceCm();
  if (d >= 0) {
    samples[sampleIdx] = d;
    sampleIdx = (sampleIdx + 1) % MEDIAN_N;
    if (sampleCount < MEDIAN_N) sampleCount++;
  }
  float filt = sampleCount ? median(samples, sampleCount) : -1;
  readSht();
  uint32_t s = ++seq;
  uint64_t ts = epochMs();

  // both paths, every reading; the hub keeps one copy (rf_gateway.py)
  if (publishWifi(s, ts, d, filt)) wifiOk++; else wifiFail++;
  if (publishRf(s, ts, d, filt)) rfAck++; else rfNoAck++;
}
