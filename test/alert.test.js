const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../config/site.json');
const P = require('../src/pipeline');
const S = require('../src/sim');
const A = require('../src/alert');

const T0 = Date.parse('2026-10-14T12:00:00Z'), KEY = 'demo/sim01';
// Scenario -> pipeline -> alert logic on a fake clock, with the 10 s watchdog tick. Returns {events, fsm}; every event has .t (seconds).
function run(c, scenario, seconds, { ackAt } = {}) {
  const sim = S.newSim(1); S.setScenario(sim, scenario);
  let st = P.newState(); const fsm = A.newFsm(), events = []; let lastSeen = null;
  const add = (evs, t) => evs.forEach((e) => events.push({ ...e, t }));
  for (let t = 0; t < seconds; t += 2) {
    const now = T0 + t * 1000;
    for (const m of S.tick(sim, c, now)) {
      if (!m.topic.endsWith('/level')) continue;
      lastSeen = now;
      const r = P.step(st, m.payload, c, now); st = r.st;
      if (!r.out.drop) add(A.onSample(fsm, r.out.fields, KEY, c, now), t);
    }
    if (t % 10 === 0 && lastSeen !== null) add(A.onTick(fsm, lastSeen, KEY, c, now), t);
    if (ackAt !== undefined && t === ackAt) add(A.ack(fsm, KEY, 'tester', now), t);
  }
  return { events, fsm };
}
const flood = (r) => r.events.filter((e) => ['escalate', 'deescalate', 'clear'].includes(e.type));
const lowLevels = { ...cfg, levels: { warning_cm: 7, critical_cm: 9 } };

test('calm: no events at all', () => assert.deepEqual(run(cfg, 'calm', 300).events, []));

test('slow_rise: WARNING only when the level crosses the threshold (not before), then nothing early', () => {
  const r = run(lowLevels, 'slow_rise', 300), esc = r.events.filter((e) => e.type === 'escalate');
  assert.equal(esc.length, 1); assert.equal(esc[0].severity, 'warning'); assert.equal(esc[0].kind, 'level');
  assert.ok(esc[0].t >= 150 && esc[0].t <= 185, `warning at ${esc[0].t} s (level 7 is reached at 150 s)`);
});

test('flash_rise: the RATE alert fires before the absolute level threshold (the "time to react" claim)', () => {
  const r = run(cfg, 'flash_rise', 200), first = r.events.find((e) => e.type === 'escalate');
  assert.equal(first.kind, 'rate'); assert.equal(first.severity, 'critical');
  assert.ok(first.level < cfg.levels.warning_cm, `level was only ${first.level.toFixed(1)} cm (warning ${cfg.levels.warning_cm})`);
  assert.ok(first.t < 100, `fired at ${first.t} s`);
});

test('recede: alert holds until the level is clearly below the threshold, then clears after the hold time', () => {
  const r = run(cfg, 'recede', 300), esc = r.events.find((e) => e.type === 'escalate'), clr = r.events.find((e) => e.type === 'clear');
  assert.equal(esc.severity, 'warning');           // starts at 20 cm, above the 14 cm warning line
  assert.ok(clr, 'must clear'); assert.ok(clr.t >= 225 && clr.t <= 275, `cleared at ${clr.t} s (level crosses 13 cm at 210 s + 30 s hold)`);
});

test('glitches: zero flood alerts from nulls, zeros, spikes and a repeated value', () => assert.deepEqual(flood(run(cfg, 'glitches', 600)), []));

test('failover (wifi -> rf, duplicates, LWT offline): no alerts of any kind', () => assert.deepEqual(run(cfg, 'failover', 150).events, []));

test('sensor_dead mid-WARNING: sensor fault raised, flood WARNING is HELD (never cleared), sensor recovers', () => {
  const r = run(cfg, 'sensor_dead', 230);
  assert.equal(r.events.find((e) => e.type === 'escalate').severity, 'warning');
  const sf = r.events.find((e) => e.type === 'sensor_fault'); assert.equal(sf.reason, 'degraded'); assert.equal(sf.held, 1);
  assert.ok(sf.t >= 40 && sf.t <= 100, `fault at ${sf.t} s`);
  assert.equal(r.events.filter((e) => e.type === 'clear' || e.type === 'deescalate').length, 0, 'bad data must not clear a flood alert');
  assert.ok(r.events.some((e) => e.type === 'sensor_ok' && e.t > sf.t));
  assert.equal(r.fsm.sev, 1);
});

test('silence: node-offline fault by watchdog after stale_after_s, clears after data resumes', () => {
  const r = run(cfg, 'silence', 230), sf = r.events.find((e) => e.type === 'sensor_fault'), ok = r.events.find((e) => e.type === 'sensor_ok');
  const due = 28 + cfg.alerts.stale_after_s;                                          // last data at 28 s; the watchdog ticks every 10 s
  assert.equal(sf.reason, 'stale'); assert.ok(sf.t >= due - 3 && sf.t <= due + 17, `stale at ${sf.t} s (last data 28 s + ${cfg.alerts.stale_after_s} s)`);
  assert.ok(ok && ok.t > 150, 'recovers only after data resumes (150 s) plus sensor_clear_s');
  assert.equal(flood(r).length, 0);
});

test('hysteresis: once escalated, a level hovering just under the threshold does not flap (and never clears)', () => {
  const fsm = A.newFsm(), evs = [], s = (level, t) => evs.push(...A.onSample(fsm, { valid: true, level_f: level, quality: 0 }, KEY, cfg, T0 + t * 1000));
  for (let t = 0; t < 8; t += 2) s(15, t);                                             // sustained above 14: escalates
  for (let t = 8, n = 0; t < 300; t += 2, n++) s(n % 2 ? 13.8 : 14.4, t);              // hovers; 13.8 is above the 13 cm clear line
  for (let t = 300; t < 420; t += 2) s(13.5, t);                                      // SITS between 13 and 14 for 2 min: hold time alone cannot save it, hysteresis must
  assert.deepEqual(evs.map((e) => e.type), ['escalate']);
  for (let t = 420; t < 460; t += 2) s(12.5, t);                                       // clearly below 13 for > 30 s: now it clears
  assert.deepEqual(evs.map((e) => e.type), ['escalate', 'clear']);
});

test('confirmation: two high readings are not enough, the third escalates', () => {
  const fsm = A.newFsm(), s = (l, t) => A.onSample(fsm, { valid: true, level_f: l, quality: 0 }, KEY, cfg, T0 + t * 1000);
  assert.equal(s(20, 0).length, 0); assert.equal(s(20, 2).length, 0);
  assert.equal(s(10, 4).length, 0);                   // dips back: counter resets
  assert.equal(s(20, 6).length + s(20, 8).length, 0); assert.equal(s(20, 10)[0].type, 'escalate');
});

test('rejected readings neither escalate nor clear', () => {
  const fsm = A.newFsm(), s = (f, t) => A.onSample(fsm, f, KEY, cfg, T0 + t * 1000);
  for (let t = 0; t < 10; t += 2) s({ valid: true, level_f: 20, quality: 0 }, t);
  assert.equal(fsm.sev, 1);
  for (let t = 10; t < 200; t += 2) s({ valid: false, quality: 1 }, t);
  assert.equal(fsm.sev, 1);
});

test('reminders every remind_min until acknowledged, then silence', () => {
  const c = { ...cfg, alerts: { ...cfg.alerts, remind_min: 1 } }, fsm = A.newFsm(), evs = [];
  for (let t = 0; t < 400; t += 2) {
    const now = T0 + t * 1000;
    evs.push(...A.onSample(fsm, { valid: true, level_f: 20, quality: 0 }, KEY, c, now));
    if (t % 10 === 0) evs.push(...A.onTick(fsm, now, KEY, c, now));
    if (t === 200) evs.push(...A.ack(fsm, KEY, 'somchai', now));
  }
  const rem = evs.filter((e) => e.type === 'reminder'), ack = evs.find((e) => e.type === 'ack');
  assert.equal(rem.length, 3, 'reminders at ~66, 126, 186 s'); assert.equal(ack.by, 'somchai');
  assert.ok(rem.every((e) => e.ts < ack.ts), 'none after the ack');
  // a worse alert after an ack alerts again
  const e2 = A.onSample(fsm, { valid: true, level_f: 25, quality: 0 }, KEY, c, T0 + 401000).concat(A.onSample(fsm, { valid: true, level_f: 25, quality: 0 }, KEY, c, T0 + 403000), A.onSample(fsm, { valid: true, level_f: 25, quality: 0 }, KEY, c, T0 + 405000));
  assert.equal(e2[0].severity, 'critical'); assert.equal(fsm.acked, false);
});

test('flap guard: a second opening alert for the same node and severity inside the window is suppressed', () => {
  const L = {}, esc = (node, sev) => ({ type: 'escalate', site: 'demo', node, severity: sev });
  assert.equal(A.gate(L, esc('n1', 'warning'), cfg, 0).send, true);
  assert.equal(A.gate(L, esc('n1', 'warning'), cfg, 30000).reason, 'dedupe');
  assert.equal(A.gate(L, esc('n2', 'warning'), cfg, 30000).send, true);      // another node is a different alert
  assert.equal(A.gate(L, esc('n1', 'critical'), cfg, 30000).send, true);     // different severity
  assert.equal(A.gate(L, esc('n1', 'warning'), cfg, 100000).send, true);     // window over
});

test('hub alerts: severities mapped, junk ignored', () => {
  assert.equal(A.fromHub('demo', { severity: 'red', level: 25 }, 1).severity, 'critical');
  assert.equal(A.fromHub('demo', { severity: 'amber' }, 1).sev, 1);
  assert.equal(A.fromHub('demo', { severity: 'green' }, 1), null);
  assert.equal(A.fromHub('demo', null, 1), null);
});

test('InfluxDB rows: transitions + notification decision, no undefined fields, reminder has no transition row', () => {
  const e = { type: 'escalate', site: 'demo', node: 'sim01', severity: 'warning', sev: 1, kind: 'level', alertID: 'a1', level: 14.3, rate: undefined, ts: 1 };
  const r = A.rows(e, { send: true }, 5);
  assert.deepEqual(r.map((x) => x.measurement), ['alert', 'notification']);
  assert.ok(Object.values(r[0].fields).every((v) => v !== undefined) && r[0].fields.rate_cm_min === undefined);
  assert.equal(r[0].fields.state, 'WARNING'); assert.equal(r[1].fields.status, 'sent');
  assert.deepEqual(A.rows({ ...e, type: 'reminder' }, { send: true }, 5).map((x) => x.measurement), ['notification']);
});

test('dashboard view: a held WARNING during a sensor fault never reads as plain NORMAL or WARNING', () => {
  const r = run(cfg, 'sensor_dead', 100);
  assert.equal(A.view(A.newFsm()), 0);
  assert.equal(r.fsm.sev, 1); assert.equal(r.fsm.sensor, 'fault'); assert.equal(A.view(r.fsm), 4);
  assert.equal(A.view({ sev: 0, sensor: 'fault' }), 3); assert.equal(A.view({ sev: 2, sensor: 'fault' }), 5);
});
