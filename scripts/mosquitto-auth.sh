#!/usr/bin/env bash
# Run as root ON the broker host. Enables password auth + ACL for Mosquitto 2.x. Idempotent.
#   usage: MQTT_PW_nodered=... MQTT_PW_sim01=... MQTT_PW_node01=... MQTT_PW_hub=... mosquitto-auth.sh /path/to/acl
# Each edited conf is backed up once as *.pre-flood. Roll back by restoring those and restarting mosquitto.
set -euo pipefail
ACL=${1:?path to acl file}
D=/etc/mosquitto
USERS="nodered sim01 node01 hub"   # node01 = colleague's ESP32; add one user per extra node

install -m 640 -o root -g mosquitto "$ACL" $D/flood.acl
rm -f $D/flood.pwfile.new
first=1
for u in $USERS; do
  v=MQTT_PW_$u; : "${!v:?missing $v}"
  if [ $first = 1 ]; then mosquitto_passwd -b -c $D/flood.pwfile.new "$u" "${!v}"; first=0
  else mosquitto_passwd -b $D/flood.pwfile.new "$u" "${!v}"; fi
done
chown root:mosquitto $D/flood.pwfile.new; chmod 640 $D/flood.pwfile.new; mv $D/flood.pwfile.new $D/flood.pwfile

# any existing anonymous allowance would defeat the password file
for f in $D/mosquitto.conf $D/conf.d/*.conf; do
  if grep -q '^allow_anonymous true' "$f"; then
    [ -e "$f.pre-flood" ] || cp -p "$f" "$f.pre-flood"
    sed -i 's/^allow_anonymous true/allow_anonymous false/' "$f"
  fi
done
cat > $D/conf.d/flood-auth.conf <<CONF
allow_anonymous false
password_file $D/flood.pwfile
acl_file $D/flood.acl
CONF
systemctl restart mosquitto
sleep 1
systemctl is-active mosquitto
