const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../config/site.json');
const A = require('../src/alert');

const G = cfg.alerts.fallback.grace_s * 1000, DEAD = cfg.alerts.fallback.pi_dead_after_s * 1000, T0 = 1_000_000;
const ev = (type, o = {}) => ({ type, site: 'demo', node: 'sim01', severity: 'warning', sev: 1, kind: 'level', level: 15, rate: 0.2, ts: T0, ...o });
const sent = (outs) => outs.filter((o) => o.g.send);
const why = (outs) => outs.map((o) => `${o.e.type}:${o.g.send ? 'SEND' : o.g.defer ? 'defer' : o.g.reason}`);

test('Pi silent (never seen): the alert is held for the grace period, then the container sends it', () => {
  const ns = A.newNotifier(), first = A.handle(ns, ev('escalate'), cfg, T0);
  assert.deepEqual(why(first), ['escalate:defer']);
  assert.deepEqual(A.notifyTick(ns, cfg, T0 + G - 1000), [], 'not yet');
  const due = A.notifyTick(ns, cfg, T0 + G);
  assert.equal(sent(due).length, 1); assert.equal(due[0].g.reason, 'fallback: Pi did not send'); assert.equal(due[0].g.late, true);
});

test('Pi covers it during the grace period: nothing is sent', () => {
  const ns = A.newNotifier(); A.handle(ns, ev('escalate'), cfg, T0);
  const hub = A.onHub(ns, A.fromHub('demo', { severity: 'warning', node: 'sim01' }, T0 + 5000), cfg, T0 + 5000);
  assert.deepEqual(why(hub), ['hub_alert:sent by the Pi', 'escalate:covered by Pi']);
  assert.deepEqual(A.notifyTick(ns, cfg, T0 + G + 1000), []);
  // and its follow-ups stay quiet: the Pi owns the alert
  assert.deepEqual(why(A.handle(ns, ev('clear', { severity: 'normal', sev: 0 }), cfg, T0 + 60000)), ['clear:Pi owns this alert']);
  assert.deepEqual(why(A.handle(ns, ev('ack'), cfg, T0 + 61000)), ['ack:Pi owns this alert']);
});

test('Pi alerted shortly BEFORE the container: covered immediately, never held', () => {
  const ns = A.newNotifier(); A.onHub(ns, A.fromHub('demo', { severity: 'critical' }, T0 - 20000), cfg, T0 - 20000); // no node named: whole site
  assert.deepEqual(why(A.handle(ns, ev('escalate'), cfg, T0)), ['escalate:covered by Pi']);
  const later = T0 + cfg.alerts.fallback.cover_s * 1000 + 5000; A.hubSeen(ns, 'demo', later - 1000); // Pi still alive (heartbeat), just not alerting
  assert.equal(A.handle(ns, ev('escalate'), cfg, later)[0].g.defer, true, 'an old Pi alert no longer covers');
});

test('a Pi WARNING does not cover a container CRITICAL, and a Pi alert for another node does not cover this one', () => {
  const ns = A.newNotifier(); A.onHub(ns, A.fromHub('demo', { severity: 'warning', node: 'sim01' }, T0), cfg, T0);
  assert.equal(A.handle(ns, ev('escalate', { severity: 'critical', sev: 2 }), cfg, T0 + 1000)[0].g.defer, true);
  assert.equal(A.handle(ns, ev('escalate', { node: 'other' }), cfg, T0 + 1000)[0].g.defer, true);
});

test('a worse alert while one is held supersedes it; only the worse one is sent', () => {
  const ns = A.newNotifier(); A.handle(ns, ev('escalate'), cfg, T0);
  const o = A.handle(ns, ev('escalate', { severity: 'critical', sev: 2 }), cfg, T0 + 10000);
  assert.deepEqual(why(o), ['escalate:superseded', 'escalate:defer']);
  const due = A.notifyTick(ns, cfg, T0 + 10000 + G); assert.equal(sent(due).length, 1); assert.equal(due[0].e.severity, 'critical');
});

test('resolved or acknowledged before the grace period ends: cancelled, nothing is sent', () => {
  for (const [type, reason] of [['clear', 'resolved before sent'], ['ack', 'acknowledged before sent']]) {
    const ns = A.newNotifier(); A.handle(ns, ev('escalate'), cfg, T0);
    const o = A.handle(ns, ev(type, { severity: 'normal', sev: 0 }), cfg, T0 + 8000);
    assert.equal(o[0].g.reason, reason); assert.equal(sent(o).length, 0);
    assert.deepEqual(A.notifyTick(ns, cfg, T0 + G + 1000), []);
  }
});

test('alerts the container sent keep their follow-ups: reminder, ack, deescalate, clear; ownership ends at clear', () => {
  const ns = A.newNotifier(); A.handle(ns, ev('escalate'), cfg, T0); A.notifyTick(ns, cfg, T0 + G);
  for (const t of ['reminder', 'ack', 'deescalate']) assert.equal(A.handle(ns, ev(t), cfg, T0 + 40000)[0].g.send, true, t);
  assert.equal(A.handle(ns, ev('clear', { severity: 'normal', sev: 0 }), cfg, T0 + 50000)[0].g.send, true);
  assert.equal(A.handle(ns, ev('reminder'), cfg, T0 + 60000)[0].g.send, false, 'owned flag cleared');
});

test('Pi dead (heartbeat stops): one PI OFFLINE notice, alerts are sent at once, node-stale is explained by it, recovery announced', () => {
  const ns = A.newNotifier(); A.hubSeen(ns, 'demo', T0);
  assert.deepEqual(A.notifyTick(ns, cfg, T0 + DEAD - 1000), []);
  const down = A.notifyTick(ns, cfg, T0 + DEAD + 1000);
  assert.deepEqual(why(down), ['hub_fault:SEND']); assert.match(A.message(down[0].e, down[0].g), /PI OFFLINE/);
  assert.deepEqual(A.notifyTick(ns, cfg, T0 + DEAD + 11000), [], 'announced once');
  const now = T0 + DEAD + 20000;
  const flood = A.handle(ns, ev('escalate', { ts: now }), cfg, now);
  assert.equal(flood[0].g.send, true); assert.equal(flood[0].g.reason, 'Pi offline'); assert.match(A.message(flood[0].e, flood[0].g), /\[Pi offline\]$/);
  assert.equal(A.handle(ns, ev('sensor_fault', { severity: 'sensor', kind: 'sensor', reason: 'stale', ageS: 92 }), cfg, now)[0].g.reason, 'Pi offline explains it');
  A.hubSeen(ns, 'demo', now + 5000);
  assert.deepEqual(why(A.notifyTick(ns, cfg, now + 6000)), ['hub_ok:SEND']);
});

test('a node going stale while the Pi was still alive when it was held, but dead when the grace ends: explained, not sent twice', () => {
  const ns = A.newNotifier(); A.hubSeen(ns, 'demo', T0);
  A.handle(ns, ev('sensor_fault', { severity: 'sensor', kind: 'sensor', reason: 'stale', ageS: 90 }), cfg, T0 + DEAD - 5000);   // Pi not yet declared dead
  const out = A.notifyTick(ns, cfg, T0 + DEAD + 30000);
  assert.deepEqual(why(out), ['hub_fault:SEND', 'sensor_fault:Pi offline explains it']);
});

test('flap guard still applies to the container fallback', () => {
  const ns = A.newNotifier(); A.handle(ns, ev('escalate'), cfg, T0); A.notifyTick(ns, cfg, T0 + G);                // sent
  A.handle(ns, ev('clear', { severity: 'normal', sev: 0 }), cfg, T0 + G + 1000);
  A.handle(ns, ev('escalate'), cfg, T0 + G + 2000);
  const again = A.notifyTick(ns, cfg, T0 + 2 * G + 2000); assert.equal(again[0].g.reason, 'dedupe');
});

test('sensor alerts from the Pi cover sensor faults, not flood alerts', () => {
  const ns = A.newNotifier(); A.onHub(ns, A.fromHub('demo', { severity: 'sensor', node: 'sim01' }, T0), cfg, T0);
  assert.equal(A.handle(ns, ev('sensor_fault', { severity: 'sensor', kind: 'sensor', reason: 'degraded' }), cfg, T0 + 1000)[0].g.reason, 'covered by Pi');
  assert.equal(A.handle(ns, ev('escalate'), cfg, T0 + 1000)[0].g.defer, true);
});

test('rows: a held event writes only its transition row; the late decision writes only the notification row', () => {
  const e = ev('escalate', { alertID: 'a1' });
  assert.deepEqual(A.rows(e, { send: false, defer: true }, 1).map((r) => r.measurement), ['alert']);
  const late = A.rows(e, { send: true, reason: 'fallback: Pi did not send', late: true }, 2);
  assert.deepEqual(late.map((r) => r.measurement), ['notification']);
  assert.equal(late[0].fields.status, 'sent'); assert.match(late[0].fields.text, /\[fallback: Pi did not send\]$/);
  assert.deepEqual(A.rows(e, { send: false, reason: 'covered by Pi' }, 3).map((r) => r.measurement), ['alert', 'notification']);
});

test('end to end with the simulator: flash_rise and no Pi gives exactly one delayed fallback message per severity', () => {
  const P = require('../src/pipeline'), S = require('../src/sim'), sim = S.newSim(1); S.setScenario(sim, 'flash_rise');
  let st = P.newState(); const fsm = A.newFsm(), ns = A.newNotifier(), outs = [];
  for (let t = 0; t < 200; t += 2) {
    const now = T0 + t * 1000;
    for (const m of S.tick(sim, cfg, now)) if (m.topic.endsWith('/level')) { const r = P.step(st, m.payload, cfg, now); st = r.st; if (!r.out.drop) A.onSample(fsm, r.out.fields, 'demo/sim01', cfg, now).forEach((e) => outs.push(...A.handle(ns, e, cfg, now).map((o) => ({ ...o, t })))); }
    if (t % 10 === 0) outs.push(...A.notifyTick(ns, cfg, now).map((o) => ({ ...o, t })));
  }
  const esc = outs.filter((o) => o.e.type === 'escalate' && o.g.defer), sentNow = sent(outs);
  assert.ok(esc.length >= 1 && sentNow.length >= 1);
  for (const s of sentNow) { const opened = esc.find((x) => x.e.alertID === s.e.alertID && x.e.severity === s.e.severity); assert.ok(s.t - opened.t >= cfg.alerts.fallback.grace_s, `sent ${s.t - opened.t}s after raised`); }
});
