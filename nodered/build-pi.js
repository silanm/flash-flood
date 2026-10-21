// Builds the Node-RED flows for the Raspberry Pi hub from src/*.js (core nodes only): the same filter and alert code as the container, plus the
// hub's outputs. Writes nodered/pi.flows.json when run directly:  node nodered/build-pi.js
// Import it on the Pi (Node-RED menu > Import), then open the "hub broker" node and enter the Pi's local Mosquitto user and password. No secret is in the file.
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
const prelude = (files, cfg) => `const CFG = ${JSON.stringify(cfg)};\n` + Object.entries(files)
  .map(([v, f]) => `const ${v} = (() => { const module = { exports: {} };\n${read(f)}\nreturn module.exports; })();\n`).join('');

// One function node does everything; it tells the inputs apart by topic. Output: MQTT messages for one mqtt-out node.
//   farm/+/node/+/level       a reading (WiFi, or RF republished by the gateway)
//   farm/+/hub/ack            the button
//   farm/+/hub/mode           retained: edge | cloud_only
//   farm/+/platform/alert|sensor/+   the container's retained states
//   tick (10 s), beat (heartbeat_s), ui-mode (editor injects)
const PI_GLUE = `
const now = Date.now(), t = String(msg.topic), p = t.split('/'), out = [];
const pub = (topic, body, retain) => out.push({ topic, payload: typeof body === 'string' ? body : JSON.stringify(body), qos: 1, retain: !!retain });
const parse = () => { try { return typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload; } catch (e) { return null; } };
let mode = flow.get('mode') || CFG.hub.default_mode;
const MODE_T = 'farm/' + CFG.site + '/hub/mode';
const sites = () => [...new Set(flow.keys().filter((k) => /^(fsm|pf):/.test(k)).map((k) => k.split(':')[1].split('/')[0]))];

// What the hardware should show for one site: from our own state machines (edge) or from the platform's states (cloud_only).
function show(site, trace) {
  const pre = (mode === 'edge' ? 'fsm:' : 'pf:') + site + '/', last = mode === 'edge' ? 'last:' : 'plast:';
  const states = flow.keys().filter((k) => k.startsWith(pre)).map((k) => { const key = k.slice(k.indexOf(':') + 1); return H.ioState(key.split('/')[1], mode, flow.get(k), flow.get(last + key), now); });
  if (!states.length) return;
  const next = H.worst(states), prev = flow.get('io:' + site), changed = H.changed(prev, next);
  if (!changed && now - prev.ts < CFG.hub.state_refresh_s * 1000) return;
  if (trace && changed) next.trace = trace; // lets the evaluation time reading -> alarm on this one clock
  flow.set('io:' + site, next); pub('farm/' + site + '/hub/state', next, true);
}
function setMode(m) {
  if (m === mode) return;
  mode = m; flow.set('mode', m);
  if (m === 'edge') for (const k of flow.keys()) if (/^(fsm|st|last):/.test(k)) flow.set(k, undefined); // a clean start: memory from before the switch is stale
  for (const s of sites()) show(s, null);
}
const raise = (events) => { let trace = null; for (const e of events) { const a = H.alertPayload(e); if (a) { pub('farm/' + e.site + '/hub/alert', a, false); trace = e.seq === undefined ? trace : { seq: e.seq, rx_ms: (flow.get('rx:' + e.site + '/' + e.node) || {})[e.seq] }; } } return trace; };

if (t === 'beat') pub('farm/' + CFG.site + '/hub/heartbeat', { ts: new Date(now).toISOString(), mode }, false);
else if (t === 'ui-mode') { const m = H.parseMode(msg.payload); if (m) { setMode(m); pub(MODE_T, m, true); } }
else if (t === MODE_T) { const m = H.parseMode(msg.payload); if (m) setMode(m); }
else if (t === 'tick') {
  if (mode === 'edge') for (const [key, lastSeen] of Object.entries(flow.get('seen') || {})) { // a node that went quiet
    const fsm = flow.get('fsm:' + key) || M.newFsm();
    raise(M.onTick(fsm, lastSeen, key, CFG, now)); flow.set('fsm:' + key, fsm);
  }
  for (const s of sites()) show(s, null);
}
else if (p[2] === 'node' && p[4] === 'level') {
  const key = p[1] + '/' + p[3], body = parse(), seen = flow.get('seen') || {};
  seen[key] = now; flow.set('seen', seen); // any message, even a duplicate, proves the node is alive
  const rx = flow.get('rx:' + key) || {};
  if (body && Number.isFinite(body.seq)) { rx[body.seq] = now; const ks = Object.keys(rx); if (ks.length > 200) delete rx[ks[0]]; flow.set('rx:' + key, rx); }
  if (mode === 'edge') {
    const r = P.step(flow.get('st:' + key) || P.newState(), body, CFG, now); flow.set('st:' + key, r.st);
    if (!r.out.drop) {
      const f = r.out.fields, fsm = flow.get('fsm:' + key) || M.newFsm();
      const events = M.onSample(fsm, f, key, CFG, now); flow.set('fsm:' + key, fsm);
      if (f.valid) flow.set('last:' + key, { level_cm: f.level_f, rate_cm_min: f.rate_cm_min });
      show(p[1], raise(events));
    }
  }
}
else if (p[2] === 'hub' && p[3] === 'ack') {
  if (mode === 'edge') { // in cloud_only the ack travels to the container, which answers with an ACKED state
    const body = parse(), entries = flow.keys().filter((k) => k.startsWith('fsm:')).map((k) => [k.slice(4), flow.get(k)]);
    M.ackSite(entries, p[1], (body && body.ackBy) || 'unknown', now);
    for (const [k, fsm] of entries) flow.set('fsm:' + k, fsm);
    show(p[1], null);
  }
}
else if (p[2] === 'platform' && (p[3] === 'alert' || p[3] === 'sensor') && p[4]) {
  const key = p[1] + '/' + p[4], body = parse();
  if (body) { // always tracked, so a switch to cloud_only starts from the container's current state
    flow.set('pf:' + key, H.fromPlatform(flow.get('pf:' + key) || H.newPlatformView(), p[3], body));
    if (Number.isFinite(body.level)) flow.set('plast:' + key, { level_cm: body.level, rate_cm_min: body.rate });
    if (mode === 'cloud_only') {
      const raised = (body.state === 'WARNING' || body.state === 'CRITICAL' || body.state === 'SENSOR_FAULT') && body.seq !== undefined;
      show(p[1], raised ? { seq: body.seq, rx_ms: (flow.get('rx:' + p[1] + '/' + p[4]) || {})[body.seq] } : null);
    }
  }
}
return out.length ? [out] : null;`;

function buildPiFlows({ cfg, env = {} }) {
  const tab = 'hubpi-tab';
  const inject = (id, name, topic, payload, repeat, y) => ({ id, type: 'inject', z: tab, name, props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], repeat: repeat ? String(repeat) : '', crontab: '', once: !!repeat, onceDelay: 3, topic, payload, payloadType: 'str', x: 130, y, wires: [['hubpi-logic']] });
  const mqttIn = (id, name, topic, y) => ({ id, type: 'mqtt in', z: tab, name, topic, qos: '1', datatype: 'utf8', broker: 'hubpi-broker', nl: false, rap: false, rh: 0, inputs: 0, x: 140, y, wires: [['hubpi-logic']] });
  return [
    { id: 'hubpi-broker', type: 'mqtt-broker', name: 'hub broker (the Pi\'s local Mosquitto)', broker: env.PI_MQTT_HOST || '127.0.0.1', port: env.PI_MQTT_PORT || '1883', clientid: 'hub-flows', autoConnect: true, usetls: false, protocolVersion: '4', keepalive: '60', cleansession: false, credentials: { user: env.PI_MQTT_USER || '', password: env.PI_MQTT_PW || '' } },
    { id: tab, type: 'tab', label: 'hub: edge logic', disabled: false, info: 'The Pi hub. Same filter and alert code as the container (src/). Mode edge: decide here. Mode cloud_only: obey the container (baseline A). Generated by nodered/build-pi.js; edit src/, not here. Publishes farm/<site>/hub/{heartbeat,alert,state}.' },
    mqttIn('hubpi-in-level', 'readings', 'farm/+/node/+/level', 60),
    mqttIn('hubpi-in-ack', 'hub/ack (button)', 'farm/+/hub/ack', 120),
    mqttIn('hubpi-in-mode', 'hub/mode (retained)', 'farm/+/hub/mode', 180),
    mqttIn('hubpi-in-alert', 'platform/alert', 'farm/+/platform/alert/+', 240),
    mqttIn('hubpi-in-sensor', 'platform/sensor', 'farm/+/platform/sensor/+', 300),
    inject('hubpi-tick', 'tick 10s', 'tick', '', 10, 360),
    inject('hubpi-beat', `heartbeat ${cfg.hub.heartbeat_s}s`, 'beat', '', cfg.hub.heartbeat_s, 420),
    inject('hubpi-ui-edge', 'mode: edge', 'ui-mode', 'edge', 0, 480),
    inject('hubpi-ui-cloud', 'mode: cloud_only (baseline A)', 'ui-mode', 'cloud_only', 0, 540),
    { id: 'hubpi-logic', type: 'function', z: tab, name: 'hub logic', func: prelude({ P: 'pipeline.js', M: 'alert.js', H: 'hub.js' }, cfg) + PI_GLUE, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 440, y: 240, wires: [['hubpi-out']] },
    { id: 'hubpi-out', type: 'mqtt out', z: tab, name: 'hub/heartbeat|alert|state|mode', topic: '', qos: '', retain: '', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: 'hubpi-broker', x: 720, y: 240, wires: [] },
  ];
}

module.exports = { buildPiFlows, PI_GLUE };

if (require.main === module) {
  const cfg = require('../config/site.json');
  const file = path.join(__dirname, 'pi.flows.json');
  fs.writeFileSync(file, JSON.stringify(buildPiFlows({ cfg, env: process.env }), null, 2) + '\n');
  console.log('wrote ' + file);
}
