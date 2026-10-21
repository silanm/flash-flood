#!/usr/bin/env bash
# Run ON the broker host with the same MQTT_PW_* env. Proves auth and ACL scoping. Exit code != 0 on any failure.
set -u
H=127.0.0.1; fail=0
ok(){ echo "PASS  $1"; }; bad(){ echo "FAIL  $1"; fail=1; }
pub(){ timeout 5 mosquitto_pub -h $H -u "$1" -P "${!2}" -t "$3" -m "$4" -q 1 2>&1; }
# 1 anonymous refused
timeout 5 mosquitto_pub -h $H -t farm/demo/node/sim01/level -m x -q 1 2>&1 | grep -qi "not authori" && ok "anonymous refused" || bad "anonymous not refused"
# 2 wrong password refused
timeout 5 mosquitto_pub -h $H -u nodered -P wrong -t farm/demo/node/sim01/level -m x -q 1 2>&1 | grep -qi "not authori" && ok "wrong password refused" || bad "wrong password not refused"
# 3 own subtree delivered to platform
rm -f /tmp/t3; mosquitto_sub -h $H -u nodered -P "$MQTT_PW_nodered" -t 'farm/+/node/+/#' -C 1 -W 5 > /tmp/t3 & sleep 1
pub sim01 MQTT_PW_sim01 farm/demo/node/sim01/level own; wait; grep -q own /tmp/t3 && ok "sim01 -> nodered delivered" || bad "sim01 own topic not delivered"
# 4 another node's subtree is blocked
rm -f /tmp/t4; mosquitto_sub -h $H -u nodered -P "$MQTT_PW_nodered" -t 'farm/+/node/+/#' -C 1 -W 4 > /tmp/t4 & sleep 1
pub sim01 MQTT_PW_sim01 farm/demo/node/node01/level spoof >/dev/null; wait; grep -q spoof /tmp/t4 && bad "sim01 spoofed node01" || ok "sim01 cannot publish to node01 subtree"
# 5 nodered cannot forge hub/ack
rm -f /tmp/t5; mosquitto_sub -h $H -u hub -P "$MQTT_PW_hub" -t 'farm/+/hub/ack' -C 1 -W 4 > /tmp/t5 & sleep 1
pub nodered MQTT_PW_nodered farm/demo/hub/ack forged >/dev/null; wait; grep -q forged /tmp/t5 && bad "nodered forged hub/ack" || ok "nodered cannot write hub/ack"
# 6 device cannot read other nodes
rm -f /tmp/t6; mosquitto_sub -h $H -u sim01 -P "$MQTT_PW_sim01" -t 'farm/+/node/node01/#' -C 1 -W 4 > /tmp/t6 & sleep 1
pub hub MQTT_PW_hub farm/demo/node/node01/level peek >/dev/null; wait; grep -q peek /tmp/t6 && bad "sim01 read node01 subtree" || ok "sim01 cannot read node01 subtree"
rm -f /tmp/t[3-6]; exit $fail
