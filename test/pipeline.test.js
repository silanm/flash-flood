const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../config/site.json');
const P = require('../src/pipeline');
const S = require('../src/sim');

const T0 = Date.parse('2026-10-14T12:00:00Z');
// Run a scenario through the pipeline on a fake clock; returns the output rows.
function run(scenario, seconds, seed = 1) {
  const sim = S.newSim(seed); S.setScenario(sim, scenario);
  let st = P.newState(); const rows = [];
  for (let t = 0; t < seconds; t += cfg.sim.interval_s) {
    const now = T0 + t * 1000;
    for (const m of S.tick(sim, cfg, now)) {
      if (!m.topic.endsWith('/level')) continue;
      const r = P.step(st, m.payload, cfg, now); st = r.st; rows.push({ t, ...r.out });
    }
  }
  return rows;
}
const sample = (seq, d, t) => ({ seq, ts: new Date(T0 + t * 1000).toISOString(), distance_cm: d, transport: 'wifi' });
const feed = (st, seq, d, t) => P.step(st, sample(seq, d, t), cfg, T0 + t * 1000);

test('calm: nothing rejected, quality good, rate ~0', () => {
  const rows = run('calm', 300).filter((r) => !r.drop);
  assert.ok(rows.every((r) => r.fields.valid && r.fields.quality === 0));
  assert.ok(Math.abs(rows.at(-1).fields.rate_cm_min) < 0.3);
});

test('slow_rise: rate ~0.4 cm/min', () => {
  const r = run('slow_rise', 300).at(-1).fields;
  assert.ok(Math.abs(r.rate_cm_min - 0.4) < 0.2, `rate ${r.rate_cm_min}`);
});

test('flash_rise: rate ~3 cm/min', () => {
  const r = run('flash_rise', 200).at(-1).fields;
  assert.ok(Math.abs(r.rate_cm_min - 3) < 0.6, `rate ${r.rate_cm_min}`);
});

test('glitches: every null/0/spike is rejected and level_f stays near truth (level 8 cm)', () => {
  const rows = run('glitches', 600).filter((r) => !r.drop);
  const bad = rows.filter((r) => !r.fields.valid);
  assert.ok(bad.length > 10, 'scenario should inject glitches');
  assert.ok(rows.filter((r) => r.fields.valid).every((r) => Math.abs(r.fields.level_f - 8) < 1.5), 'filtered level drifted');
  const reasons = new Set(bad.map((r) => r.fields.reject));
  for (const k of ['timeout', 'range', 'spike', 'stuck']) assert.ok(reasons.has(k), `missing reject reason ${k}`);
});

test('stuck run flags the node suspect', () => {
  const rows = run('glitches', 130).filter((r) => !r.drop && r.fields.reject === 'stuck');
  assert.ok(rows.length > 0 && rows.every((r) => r.fields.quality >= 1));
});

test('sensor_dead: all-null window drives quality to bad and never produces a level', () => {
  const rows = run('sensor_dead', 90).filter((r) => !r.drop && r.t >= 60);
  assert.ok(rows.every((r) => r.fields.reject === 'timeout' && r.fields.level_f === undefined));
  assert.equal(rows.at(-1).fields.quality, 2);
});

test('sustained step is accepted on the third sample, a lone spike is not', () => {
  let st = P.newState(), seq = 0;
  for (let i = 0; i < 10; i++) st = feed(st, ++seq, 24, i * 2).st;           // level 6
  let r = feed(st, ++seq, 200, 20); assert.equal(r.out.fields.reject, 'spike'); st = r.st;
  r = feed(st, ++seq, 24, 22); assert.ok(r.out.fields.valid); st = r.st;      // back to normal: pending cleared
  for (const [i, want] of [[0, 'spike'], [1, 'spike'], [2, undefined]]) {
    r = feed(st, ++seq, 14, 24 + i * 2); st = r.st;                           // real step to level 16
    assert.equal(r.out.fields.reject, want);
  }
});

test('failover: rf transport tagged, duplicates dropped, no gaps counted', () => {
  const rows = run('failover', 120);
  assert.ok(rows.some((r) => r.drop === 'dup'));
  const ok = rows.filter((r) => !r.drop);
  assert.ok(ok.some((r) => r.tags.transport === 'rf') && ok.some((r) => r.tags.transport === 'wifi'));
  assert.ok(ok.every((r) => r.fields.valid && r.fields.seq_gap === undefined));
});

test('silence: simulator publishes nothing in the silent window', () => {
  const rows = run('silence', 150);
  assert.ok(rows.every((r) => r.t < 30));
});

test('schema and range: garbage is dropped or rejected, never raised as level', () => {
  const st = P.newState();
  assert.equal(P.step(st, { seq: 'x', distance_cm: 5 }, cfg, T0).out.drop, 'schema');
  assert.equal(P.step(st, { seq: 1, distance_cm: 'far' }, cfg, T0).out.drop, 'schema');
  assert.equal(feed(P.newState(), 1, 0, 0).out.fields.reject, 'range');
  assert.equal(feed(P.newState(), 1, 450, 0).out.fields.reject, 'range');
});

test('node restart (seq resets) is accepted, redelivered old seq is not', () => {
  let st = P.newState();
  for (let i = 100; i < 110; i++) st = feed(st, i, 24, (i - 100) * 2).st;
  assert.equal(feed(st, 108, 24, 20).out.drop, 'dup');
  assert.ok(feed(st, 0, 24, 22).out.fields.valid);
});

test('clock skew: node timestamp far from now falls back to receive time', () => {
  const r = P.step(P.newState(), { seq: 1, ts: '2020-01-01T00:00:00Z', distance_cm: 24 }, cfg, T0);
  assert.equal(r.out.ts, T0);
});

test('a level step does not read as a sustained rise (slope history drops at the jump)', () => {
  // +/-0.1 cm alternating jitter, as a live sensor has (a constant signal would trip the stuck detector instead)
  let st = P.newState(), seq = 0, t = 0;
  const f = (d) => { const r = feed(st, ++seq, d + (seq % 2 ? 0.1 : -0.1), t); st = r.st; t += 2; return r.out.fields; };
  for (let i = 0; i < 60; i++) f(24);                       // level 6, calm
  const rates = [];
  for (let i = 0; i < 60; i++) { const x = f(22); if (x.rate_cm_min !== undefined) rates.push(x.rate_cm_min); } // level 8
  assert.ok(rates.length > 20, 'rate should resume after the step');
  assert.ok(Math.max(...rates.map(Math.abs)) < 0.5, `max |rate| ${Math.max(...rates.map(Math.abs)).toFixed(2)}`);
});

// run() with a config override, returns rows
const runCfg = (c, scenario, seconds) => {
  const sim = S.newSim(1); S.setScenario(sim, scenario); let st = P.newState(); const rows = [];
  for (let t = 0; t < seconds; t += c.sim.interval_s) { const now = T0 + t * 1000; for (const m of S.tick(sim, c, now)) if (m.topic.endsWith('/level')) { const r = P.step(st, m.payload, c, now); st = r.st; rows.push({ t, ...r.out }); } }
  return rows.filter((r) => !r.drop);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

test('temperature: compensation recovers the true level when air warms 25 -> 40 C', () => {
  const tail = (c) => mean(runCfg(c, 'temp_swing', 300).filter((r) => r.t >= 240 && r.fields.valid).map((r) => r.fields.level_f));
  const off = tail({ ...cfg, temperature: { ...cfg.temperature, enabled: false } }), on = tail(cfg);
  assert.ok(Math.abs(on - 10) < 0.3, `compensated level ${on.toFixed(2)} (true 10)`);
  assert.ok(Math.abs(off - 10) > 0.5, `uncompensated drift only ${(off - 10).toFixed(2)} cm: simulator is not modelling the physics`);
});

test('temperature: dropout holds the last good value, error codes are ignored, level stays valid', () => {
  const rows = runCfg(cfg, 'temp_fault', 150);
  const gap = rows.filter((r) => r.t >= 62 && r.t < 120);
  assert.ok(gap.length > 20 && gap.every((r) => r.fields.temp_ok === false && r.fields.temp_c === undefined), 'null and -127 must not count as a fresh temperature');
  assert.ok(gap.every((r) => r.fields.valid && Math.abs(r.fields.level_f - 10) < 0.5), 'held temperature should keep the level accurate');
  assert.ok(rows.filter((r) => r.t >= 125).every((r) => r.fields.temp_ok === true), 'recovers when readings return');
});

test('temperature: missing or non-numeric temp_c disables compensation without breaking the reading', () => {
  const r = P.step(P.newState(), { seq: 1, distance_cm: 22, temp_c: 'warm' }, cfg, T0).out.fields;
  assert.equal(r.valid, true); assert.equal(r.temp_ok, false); assert.equal(r.level_cm, 8); assert.equal(r.temp_corr_cm, undefined);
});
