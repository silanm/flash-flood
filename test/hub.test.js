const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config/site.json');
const S = require('../src/sim');
const P = require('../src/pipeline');
const A = require('../src/alert');
const H = require('../src/hub');
const { buildPiFlows } = require('../nodered/build-pi');

// ---- src/hub.js: what the hardware shows
const fsm = (o = {}) => ({ ...A.newFsm(), ...o });
const io = (o, last = { level_cm: 12.34, rate_cm_min: 0.4 }, mode = 'edge') => H.ioState('sim01', mode, fsm(o), last, 1000);

test('LED and buzzer: every state, and a dead sensor never reads as green or silent', () => {
  const rows = [
    [{}, 'green', 'off'],
    [{ sev: 1 }, 'amber', 'warning'], [{ sev: 2 }, 'red', 'critical'],
    [{ sev: 1, acked: true }, 'amber', 'off'], [{ sev: 2, acked: true }, 'red', 'off'],
    [{ sensor: 'fault', reason: 'stale' }, 'amber', 'fault'],                     // sev 0 would be green: forced to amber
    [{ sensor: 'fault', reason: 'stale', sensorAcked: true }, 'amber', 'off'],
    [{ sev: 2, sensor: 'fault', reason: 'degraded' }, 'red', 'critical'],          // the flood alarm outranks the fault tone
    [{ sev: 2, acked: true, sensor: 'fault', reason: 'degraded' }, 'red', 'fault'], // flood acknowledged, fault still sounds
  ];
  for (const [o, led, buzzer] of rows) { const s = io(o); assert.deepEqual([s.led, s.buzzer], [led, buzzer], JSON.stringify(o)); assert.equal(s.blink, o.sensor === 'fault'); }
});

test('LCD: four lines of at most 20 characters, the right message for each case', () => {
  const lines = (o, last, mode) => io(o, last, mode).lcd;
  assert.deepEqual(lines({}), ['sim01 NORMAL', 'Lvl 12.3cm +0.4/m', 'Sensor: ok', 'Mode: edge']);
  assert.deepEqual(lines({ sev: 2 }).slice(0, 1).concat(lines({ sev: 2 }).slice(3)), ['sim01 CRITICAL', 'Press button to ack']);
  assert.equal(lines({ sev: 1, acked: true })[3], 'Acked');
  assert.equal(lines({ sensor: 'fault', reason: 'degraded' })[2], 'Sensor: degraded');
  assert.equal(lines({}, null, 'cloud_only')[1], 'Lvl --cm', 'no reading yet: dashes, not NaN');
  assert.equal(lines({}, { level_cm: 5, rate_cm_min: -0.25 })[1], 'Lvl 5.0cm -0.3/m');
  for (const o of [{}, { sev: 2 }, { sev: 1, acked: true }, { sensor: 'fault', reason: 'degraded' }]) for (const l of lines(o)) assert.ok(l.length <= 20, l);
  assert.equal(H.ioState('a-very-long-node-name', 'edge', fsm({ sev: 2 }), {}, 0).lcd[0].length, 20);
});

test('worst picks the most severe node; changed ignores the numbers on the LCD', () => {
  const a = io({}), b = io({ sev: 1 }), c = io({ sev: 1, acked: true }), d = io({ sensor: 'fault', reason: 'stale' });
  assert.equal(H.worst([a, b, c]), b, 'an unacknowledged warning outranks an acknowledged one');
  assert.equal(H.worst([a, d]), d); assert.equal(H.worst([d, c]), c);
  assert.equal(H.changed(undefined, a), true); assert.equal(H.changed(a, io({}, { level_cm: 99, rate_cm_min: 3 })), false);
  for (const o of [{ sev: 1 }, { acked: true }, { sensor: 'fault' }]) assert.equal(H.changed(a, io(o)), true, JSON.stringify(o));
  assert.equal(H.changed(a, io({}, undefined, 'cloud_only')), true);
});

test('alert payload: only raised alerts, in the shape the container reads', () => {
  const ev = (type, o = {}) => ({ type, site: 'demo', node: 'sim01', severity: 'warning', sev: 1, kind: 'level', level: 15, rate: NaN, alertID: 'demo/sim01-1', seq: 7, ts: 1_000_000, ...o });
  for (const type of ['clear', 'deescalate', 'reminder', 'ack', 'sensor_ok']) assert.equal(H.alertPayload(ev(type)), null, type);
  const esc = H.alertPayload(ev('escalate'));
  assert.deepEqual(esc, { severity: 'warning', node: 'sim01', kind: 'level', level: 15, alertID: 'demo/sim01-1', seq: 7, ts: '1970-01-01T00:16:40.000Z' }, 'NaN rate left out');
  assert.equal(A.fromHub('demo', esc, 1).sev, 1);
  const sf = H.alertPayload(ev('sensor_fault', { severity: 'sensor', kind: 'sensor', reason: 'stale', level: undefined }));
  assert.equal(sf.severity, 'sensor'); assert.equal(A.fromHub('demo', sf, 1).cls, 'sensor');
});

test('mode parsing and platform states', () => {
  assert.deepEqual(['edge', ' Cloud_Only\n', 'cloud-only', 'cloud', '', 'EDGE '].map(H.parseMode), ['edge', 'cloud_only', 'cloud_only', null, null, 'edge']);
  const v = H.newPlatformView(), up = (kind, p) => H.fromPlatform(v, kind, p);
  up('alert', { state: 'WARNING' }); assert.deepEqual([v.sev, v.acked], [1, false]);
  up('alert', { state: 'ACKED' }); assert.equal(v.acked, true);
  up('alert', { state: 'WARNING' }); assert.equal(v.acked, true, 'a de-escalation or repeat does not undo an acknowledgement');
  up('alert', { state: 'CRITICAL' }); assert.deepEqual([v.sev, v.acked], [2, false], 'a worse alert needs a new acknowledgement');
  up('alert', { state: 'NORMAL' }); assert.deepEqual([v.sev, v.acked], [0, false]);
  up('sensor', { state: 'SENSOR_FAULT', reason: 'stale' }); assert.deepEqual([v.sensor, v.reason, v.sensorAcked], ['fault', 'stale', false]);
  up('sensor', { state: 'ACKED' }); assert.equal(v.sensorAcked, true);
  up('sensor', { state: 'SENSOR_OK' }); assert.deepEqual([v.sensor, v.reason], ['ok', null]);
  const before = JSON.stringify(v); for (const bad of [null, {}, { state: 'WHAT' }, { state: 7 }]) up('alert', bad); assert.equal(JSON.stringify(v), before);
});

// ---- the generated Pi flows, running the real function-node code on a fake clock
const flows = buildPiFlows({ cfg });
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const logic = new AsyncFunction('msg', 'node', 'flow', flows.find((n) => n.id === 'hubpi-logic').func);
const T0 = Date.parse('2026-10-21T10:00:00Z');
const ctx = () => { const o = {}; return { keys: () => Object.keys(o), get: (k) => o[k], set: (k, v) => { if (v === undefined) delete o[k]; else o[k] = v; } }; };
const HUB_TOPIC = /^farm\/demo\/hub\/(heartbeat|alert|state|mode)$/; // the broker's ACL lets the hub user write farm/+/hub/# only as far as we use it

function pi() {
  const flow = ctx(), log = [];
  const send = async (topic, payload, at) => {
    const real = Date.now; Date.now = () => at;
    try {
      const r = await logic({ topic, payload }, { status() {} }, flow), msgs = (r ? r[0] : []).map((m) => ({ ...m, body: m.payload.startsWith('{') ? JSON.parse(m.payload) : m.payload, t: at }));
      for (const m of msgs) { assert.match(m.topic, HUB_TOPIC); assert.equal(m.qos, 1); }
      log.push(...msgs); return msgs;
    } finally { Date.now = real; }
  };
  return { flow, send, log };
}
// A Pi fed by the simulator: readings every 2 s, the 10 s tick as in the flow.
function rig(scenario) {
  const p = pi(), sim = S.newSim(1); S.setScenario(sim, scenario); let t = 0;
  p.run = async (seconds) => { for (const end = t + seconds; t < end; t += 2) { const now = T0 + t * 1000; for (const m of S.tick(sim, cfg, now)) if (m.topic.endsWith('/level')) await p.send(m.topic, JSON.stringify(m.payload), now); if (t % 10 === 0) await p.send('tick', '', now); } };
  p.at = () => T0 + t * 1000;
  return p;
}
const on = (p, suffix) => p.log.filter((m) => m.topic.endsWith(suffix));
const sec = (m) => (m.t - T0) / 1000;
// The container's own run of the same scenario (pipeline -> alert logic), for comparison.
function container(scenario, seconds) {
  const sim = S.newSim(1); S.setScenario(sim, scenario); let st = P.newState(); const f = A.newFsm(), events = [];
  for (let t = 0; t < seconds; t += 2) for (const m of S.tick(sim, cfg, T0 + t * 1000)) if (m.topic.endsWith('/level')) {
    const r = P.step(st, m.payload, cfg, T0 + t * 1000); st = r.st;
    if (!r.out.drop) events.push(...A.onSample(f, r.out.fields, 'demo/sim01', cfg, T0 + t * 1000).map((e) => ({ ...e, t })));
  }
  return events;
}

test('edge: a fast rise raises the hub alert from the rate, before the level line, and it is the container\'s alert', async () => {
  const p = rig('flash_rise'); await p.run(120);
  const alerts = on(p, '/hub/alert'), first = alerts[0];
  assert.equal(first.body.kind, 'rate'); assert.ok(first.body.level < cfg.levels.warning_cm); assert.ok(sec(first) < 100);
  assert.equal(A.fromHub('demo', first.body, 1).sev, first.body.severity === 'critical' ? 2 : 1, 'the container reads our alert');
  const ce = container('flash_rise', 120).find((e) => e.type === 'escalate');
  assert.equal(sec(first), ce.t, 'same code, same inputs: the Pi alerts at the same second as the container');
  assert.equal(first.body.seq, ce.seq);
  const state = on(p, '/hub/state').at(-1).body;
  assert.deepEqual([state.led, state.buzzer, state.retain], ['red', 'critical', undefined]); assert.equal(on(p, '/hub/state').every((m) => m.retain === true), true);
  const raised = on(p, '/hub/state').find((m) => m.body.trace);
  assert.equal(raised.body.trace.seq, first.body.seq); assert.equal(raised.body.ts - raised.body.trace.rx_ms, 0, 'edge latency: the alarm is set in the same instant the reading arrives');
});

test('edge: calm raises nothing and shows green; glitches raise no flood alert', async () => {
  const calm = rig('calm'); await calm.run(300);
  assert.deepEqual(on(calm, '/hub/alert'), []);
  const s = on(calm, '/hub/state').at(-1).body; assert.deepEqual([s.led, s.buzzer, s.lcd[3]], ['green', 'off', 'Mode: edge']);
  const g = rig('glitches'); await g.run(600);
  assert.deepEqual(on(g, '/hub/alert').filter((m) => m.body.severity !== 'sensor'), [], 'no flood alert from nulls, zeros, spikes or a repeated value');
  assert.deepEqual(g.flow.keys().filter((k) => k.startsWith('fsm:')).map((k) => g.flow.get(k).sev), [0]);
});

test('edge: the button silences the buzzer; the alert stays; no second hub alert', async () => {
  const p = rig('flash_rise'); await p.run(120); const n = on(p, '/hub/alert').length, at = p.at();
  await p.send('farm/demo/hub/ack', JSON.stringify({ ackBy: 'somchai' }), at);
  const s = on(p, '/hub/state').at(-1).body;
  assert.deepEqual([s.buzzer, s.acked, s.led, s.lcd[3]], ['off', true, 'red', 'Acked']);
  assert.equal(on(p, '/hub/alert').length, n);
  await p.send('farm/demo/hub/ack', 'not json', at + 1000); // a garbled ack still acknowledges, as "unknown"
});

test('edge: a silent node raises a sensor alert after stale_after_s; the hardware sounds the fault tone', async () => {
  const p = rig('calm'); await p.run(40); const last = p.at();
  for (let s = 10; s <= 140; s += 10) await p.send('tick', '', last + s * 1000);
  const a = on(p, '/hub/alert'); assert.equal(a.length, 1); assert.deepEqual([a[0].body.severity, a[0].body.reason], ['sensor', 'stale']);
  assert.ok(sec(a[0]) - (last - T0) / 1000 >= cfg.alerts.stale_after_s);
  assert.equal(A.fromHub('demo', a[0].body, 1).cls, 'sensor');
  const s = on(p, '/hub/state').at(-1).body; assert.deepEqual([s.led, s.buzzer, s.blink, s.lcd[2]], ['amber', 'fault', true, 'Sensor: stale']);
});

test('heartbeat carries the mode and is not retained', async () => {
  const p = pi(); const [m] = await p.send('beat', '', T0);
  assert.equal(m.topic, 'farm/demo/hub/heartbeat'); assert.equal(m.retain, false); assert.deepEqual([m.body.mode, m.body.ts], ['edge', '2026-10-21T10:00:00.000Z']);
});

test('state refreshes on the tick, but only every state_refresh_s', async () => {
  const p = rig('calm'); await p.run(2); // publishes the first state at T0
  const n = () => on(p, '/hub/state').length; assert.equal(n(), 1);
  await p.send('tick', '', T0 + 5000); assert.equal(n(), 1, 'too soon');
  await p.send('tick', '', T0 + (cfg.hub.state_refresh_s + 1) * 1000); assert.equal(n(), 2);
});

// ---- baseline A
test('cloud_only: the Pi relays and obeys; it decides nothing itself', async () => {
  const p = rig('flash_rise');
  const [mode] = await p.send('ui-mode', 'cloud_only', T0);
  assert.deepEqual([mode.topic, mode.body, mode.retain], ['farm/demo/hub/mode', 'cloud_only', true], 'the choice is retained, so it survives a restart');
  const evs = container('flash_rise', 150).filter((e) => e.type === 'escalate'), ce = evs[0];
  await p.run(ce.t + 2);
  assert.deepEqual([on(p, '/hub/alert').length, on(p, '/hub/state').length], [0, 0], 'readings alone change nothing');

  // the container's retained state arrives 150 ms after the triggering reading reached the Pi
  const rxMs = p.flow.get('rx:demo/sim01')[ce.seq];
  assert.equal(rxMs, T0 + ce.t * 1000);
  await p.send('farm/demo/platform/alert/sim01', JSON.stringify(A.statePayload(ce)), rxMs + 150);
  const s = on(p, '/hub/state').at(-1).body;
  assert.deepEqual([s.mode, s.led, s.buzzer, s.lcd[3]], ['cloud_only', ce.sev === 2 ? 'red' : 'amber', ce.sev === 2 ? 'critical' : 'warning', 'Press button to ack']);
  assert.equal(s.trace.seq, ce.seq); assert.equal(s.ts - s.trace.rx_ms, 150, 'cloud-only latency is measured on the Pi\'s own clock');
  assert.deepEqual(on(p, '/hub/alert'), [], 'cloud_only never publishes hub/alert');

  await p.send('farm/demo/platform/alert/sim01', JSON.stringify({ state: 'ACKED' }), rxMs + 5000);
  assert.deepEqual([on(p, '/hub/state').at(-1).body.buzzer, on(p, '/hub/state').at(-1).body.lcd[3]], ['off', 'Acked']);
  await p.send('farm/demo/platform/alert/sim01', JSON.stringify({ state: 'NORMAL' }), rxMs + 9000);
  assert.deepEqual([on(p, '/hub/state').at(-1).body.led, on(p, '/hub/state').at(-1).body.lcd[3]], ['green', 'Mode: cloud_only']);
  await p.send('farm/demo/platform/sensor/sim01', JSON.stringify({ state: 'SENSOR_FAULT', reason: 'stale' }), rxMs + 9500);
  const f = on(p, '/hub/state').at(-1).body; assert.deepEqual([f.led, f.buzzer, f.blink], ['amber', 'fault', true]);
});

test('cloud_only: the button and a silent node are the container\'s business', async () => {
  const p = rig('flash_rise'); await p.send('ui-mode', 'cloud_only', T0); await p.run(100);
  await p.send('farm/demo/hub/ack', JSON.stringify({ ackBy: 'x' }), p.at());
  for (let s = 10; s <= 200; s += 10) await p.send('tick', '', p.at() + s * 1000);
  assert.deepEqual([on(p, '/hub/alert').length, on(p, '/hub/state').length], [0, 0]);
});

test('mode switches: from the broker too, junk ignored, and going back to edge starts clean', async () => {
  const p = rig('flash_rise'); await p.run(120);
  assert.equal(on(p, '/hub/state').at(-1).body.buzzer, 'critical');
  await p.send('farm/demo/hub/mode', 'banana', p.at()); await p.send('beat', '', p.at()); assert.equal(on(p, '/hub/heartbeat').at(-1).body.mode, 'edge');
  await p.send('farm/demo/hub/mode', 'cloud_only', p.at()); await p.send('beat', '', p.at()); assert.equal(on(p, '/hub/heartbeat').at(-1).body.mode, 'cloud_only');
  await p.send('farm/demo/hub/mode', 'edge', p.at());
  assert.deepEqual(p.flow.keys().filter((k) => /^(fsm|st|last):/.test(k)), [], 'old alert memory is gone');
  await p.send('farm/demo/node/sim01/level', JSON.stringify({ seq: 9999, ts: new Date(p.at()).toISOString(), distance_cm: 22, temp_c: 28 }), p.at() + 2000);
  const s = on(p, '/hub/state').at(-1).body; assert.deepEqual([s.sev, s.led, s.buzzer], [0, 'green', 'off'], 'the old CRITICAL does not come back');
});

test('the container\'s own states, as it publishes them, drive the Pi in cloud_only (seq plumbing end to end)', async () => {
  // run the container logic, take every state it would publish, replay them to a Pi in cloud_only mode, and check the Pi follows
  const p = rig('flash_rise'); await p.send('ui-mode', 'cloud_only', T0); await p.run(150);
  const evs = container('flash_rise', 150).filter((e) => A.publishable(e));
  assert.ok(evs.length >= 1);
  for (const e of evs) await p.send(`farm/demo/platform/${e.kind === 'sensor' ? 'sensor' : 'alert'}/${e.node}`, JSON.stringify(A.statePayload(e)), p.at());
  const s = on(p, '/hub/state').at(-1).body, top = Math.max(...evs.map((e) => e.sev));
  assert.deepEqual([s.sev, s.led], [evs.at(-1).sev, ['green', 'amber', 'red'][evs.at(-1).sev]]); assert.ok(top >= 1);
});

// ---- the file we ship
test('flows: core nodes only, ids namespaced, wires resolve, the committed file is current and holds no secrets', () => {
  const ids = new Set(flows.map((n) => n.id)), core = new Set(['tab', 'mqtt-broker', 'mqtt in', 'mqtt out', 'function', 'inject']);
  for (const n of flows) {
    assert.ok(n.id.startsWith('hubpi-'), n.id); assert.ok(core.has(n.type), `${n.id} is a ${n.type}: not a core node`);
    for (const w of (n.wires || []).flat()) assert.ok(ids.has(w), `${n.id} -> ${w}`);
    if (n.broker && n.type !== 'mqtt-broker') assert.ok(ids.has(n.broker));
  }
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../nodered/pi.flows.json'), 'utf8'));
  assert.deepEqual(shipped, flows, 'nodered/pi.flows.json is stale: run  node nodered/build-pi.js');
  assert.deepEqual(flows.find((n) => n.type === 'mqtt-broker').credentials, { user: '', password: '' });
  const withPw = buildPiFlows({ cfg, env: { PI_MQTT_USER: 'hub', PI_MQTT_PW: 'x' } }).find((n) => n.type === 'mqtt-broker').credentials;
  assert.deepEqual(withPw, { user: 'hub', password: 'x' });
  const inputs = flows.filter((n) => n.type === 'mqtt in').map((n) => n.topic).sort();
  assert.deepEqual(inputs, ['farm/+/hub/ack', 'farm/+/hub/mode', 'farm/+/node/+/level', 'farm/+/platform/alert/+', 'farm/+/platform/sensor/+']);
});
