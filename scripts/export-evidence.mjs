// Exports the readings, alerts and notifications of the live test windows to CSV (the bucket keeps 30 days, so run this before they age out).
//   node scripts/export-evidence.mjs        writes docs/evidence/data/*.csv   (all times UTC; "local" is Asia/Bangkok)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
if (existsSync(path.join(root, '.env'))) for (const l of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
for (const k of ['INFLUX_URL', 'INFLUX_USER', 'INFLUX_PASS', 'INFLUX_ORG']) if (!env[k]) { console.error('missing ' + k); process.exit(1); }
const BUCKET = env.INFLUX_BUCKET || 'flood', out = path.join(root, 'docs/evidence/data');
mkdirSync(out, { recursive: true });

const signin = await fetch(`${env.INFLUX_URL}/api/v2/signin`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${env.INFLUX_USER}:${env.INFLUX_PASS}`).toString('base64') } });
const cookie = signin.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function query(flux) {
  const res = await fetch(`${env.INFLUX_URL}/api/v2/query?org=${encodeURIComponent(env.INFLUX_ORG)}`, { method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json', Accept: 'application/csv' }, body: JSON.stringify({ query: flux, type: 'flux' }) });
  if (!res.ok) throw new Error(`query failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const lines = (await res.text()).split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];
  const parse = (l) => { const o = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; };
  const head = parse(lines[0]);
  return lines.slice(1).map(parse).filter((r) => r.length === head.length && r[0] !== 'result').map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const local = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
const csv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => { const v = r[c] ?? ''; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','))].join('\n') + '\n';

// readings: one file per live test window
const LEVEL_FIELDS = ['distance_cm', 'level_cm', 'level_f', 'rate_cm_min', 'quality', 'alert_view', 'temp_c', 'temp_corr_cm', 'reject', 'valid'];
const windows = [
  ['2026-10-14-glitches', '2026-10-14T15:39:00Z', '2026-10-14T15:46:00Z', 'glitches scenario: spikes, timeouts, zeros, a stuck run'],
  ['2026-10-18-level-step-rate-fix', '2026-10-18T02:27:00Z', '2026-10-18T02:34:30Z', 'two 6 to 8 cm steps after the rate-window fix'],
  ['2026-10-18-temp-swing', '2026-10-18T03:03:30Z', '2026-10-18T03:09:30Z', 'temp_swing: air 25 to 40 C, true level 10 cm'],
  ['2026-10-18-alert-lifecycle', '2026-10-18T03:52:30Z', '2026-10-18T04:04:30Z', 'flash_rise, ack, calm, silence, sensor_dead'],
  ['2026-10-18-fallback-tests', '2026-10-18T05:10:00Z', '2026-10-18T05:21:00Z', 'fallback tests A (no Pi), B (Pi covers), C (Pi dead)'],
];
for (const [name, a, b] of windows) {
  const rows = await query(`from(bucket: "${BUCKET}") |> range(start: ${a}, stop: ${b})
    |> filter(fn: (r) => r._measurement == "level" and r.site == "demo" and r.node == "sim01" and contains(value: r._field, set: ${JSON.stringify(LEVEL_FIELDS)}))
    |> pivot(rowKey: ["_time", "transport"], columnKey: ["_field"], valueColumn: "_value") |> group() |> sort(columns: ["_time"])`);
  rows.forEach((r) => { r.time_utc = r._time; r.time_local = local(r._time); });
  writeFileSync(path.join(out, name + '.csv'), csv(['time_utc', 'time_local', 'transport', ...LEVEL_FIELDS], rows));
  console.log(`${name}.csv  ${rows.length} rows  (${a} to ${b})`);
}

// every alert and notification decision still in the bucket
for (const [m, keys, cols] of [
  ['alert', ['node', 'kind', 'severity', 'source'], ['node', 'source', 'kind', 'severity', 'state', 'sev', 'level_cm', 'rate_cm_min', 'reason', 'acked', 'alertID']],
  ['notification', ['node', 'kind', 'severity', 'channel'], ['node', 'severity', 'kind', 'status', 'reason', 'text']],
]) {
  const rows = await query(`from(bucket: "${BUCKET}") |> range(start: -30d) |> filter(fn: (r) => r._measurement == "${m}")
    |> pivot(rowKey: ["_time", ${keys.map((k) => `"${k}"`).join(', ')}], columnKey: ["_field"], valueColumn: "_value") |> group() |> sort(columns: ["_time"])`);
  rows.forEach((r) => { r.time_utc = r._time; r.time_local = local(r._time); });
  writeFileSync(path.join(out, m + '-rows.csv'), csv(['time_utc', 'time_local', ...cols], rows));
  console.log(`${m}-rows.csv  ${rows.length} rows`);
}
