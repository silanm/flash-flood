// Proves the tests guard the rules: breaks one rule at a time, runs the suite, and requires a test whose name matches to fail.
//   node scripts/mutation-check.mjs        exit code 0 only if every mutation was caught; source files are always restored
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = [
  ['spike gate disabled (min_step_cm 1 -> 1000)', 'config/site.json', '"min_step_cm": 1,', '"min_step_cm": 1000,', /glitches|sustained step/],
  ['step guard disabled (a level jump no longer drops the slope history)', 'src/pipeline.js', 'Math.abs(fields.level_f - st.hist.at(-1).v) > F.min_step_cm', 'false', /does not read as a sustained rise/],
  ['temperature correction removed', 'src/pipeline.js', 'dc = tc === null ? d : d * (331.3 + 0.606 * tc) / TC.assumed_sound_mps;', 'dc = d;', /temperature: compensation/],
  ['fail-safe removed (rejected readings may clear an alert)', 'src/alert.js', 'if (f.valid && Number.isFinite(f.level_f)) {', 'if (true) {', /sensor_dead|rejected readings neither/],
  ['confirmation removed (escalate on the first reading)', 'src/alert.js', 'if (fsm.upN >= A.confirm_n) {', 'if (fsm.upN >= 1) {', /confirmation|slow_rise/],
  ['hysteresis removed', 'src/alert.js', 'hl = clear ? A.hysteresis_cm : 0, hr = clear ? A.hysteresis_cm_min : 0', 'hl = 0, hr = 0', /hysteresis|recede/],
  ['fallback: no grace period (send at once)', 'src/alert.js', 'ns.pending[key] = { e, due: now + cfg.alerts.fallback.grace_s * 1000 };', "return [...out, { e, g: send(ns, e, key, 'x', cfg, now) }];", /Pi silent|Pi covers it/],
  ['fallback: Pi alerts never cover', 'src/alert.js', 'return ns.hubAlerts.some(', 'return false && ns.hubAlerts.some(', /Pi covers it|BEFORE the container/],
  ['fallback: the Pi is never declared dead', 'src/alert.js', 'ns.hubSeen[site] !== undefined && now - ns.hubSeen[site]', 'false && now - ns.hubSeen[site]', /Pi dead/],
  ['fallback: container always sends follow-ups', 'src/alert.js', 'if (!ns.owned[key]) return', 'if (false) return', /follow-ups|Pi covers it/],
];
const run = () => spawnSync('node', ['--test', 'test/'], { cwd: root, encoding: 'utf8' });
const failing = (o) => [...new Set((o.stdout.match(/^✖ [^\n]+/gm) || []).map((l) => l.slice(2).replace(/ \(\d.*$/, '')))].filter((n) => !/^failing tests:?$/.test(n));

const base = run();
console.log(`baseline: ${/ℹ pass (\d+)/.exec(base.stdout)[1]} tests pass, ${/ℹ fail (\d+)/.exec(base.stdout)[1]} fail\n`);
let missed = 0;
for (const [name, file, from, to, expect] of M) {
  const f = path.join(root, file), original = readFileSync(f, 'utf8');
  if (!original.includes(from)) { console.log(`MISSING   ${name}: pattern not found in ${file}`); missed++; continue; }
  try {
    writeFileSync(f, original.replace(from, to));
    const names = failing(run()), caught = names.some((n) => expect.test(n));
    if (!caught) missed++;
    console.log(`${caught ? 'CAUGHT ' : 'MISSED '}  ${name}\n          ${names.length} failing: ${names.map((n) => n.slice(0, 70)).join(' | ') || '(none)'}`);
  } finally { writeFileSync(f, original); }
}
const after = run();
console.log(`\nrestored: ${/ℹ pass (\d+)/.exec(after.stdout)[1]} tests pass, ${/ℹ fail (\d+)/.exec(after.stdout)[1]} fail`);
console.log(missed ? `${missed} mutation(s) NOT caught` : `all ${M.length} mutations caught`);
process.exit(missed ? 1 : 0);
