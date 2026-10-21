// Idempotent installer. Talks only to the HTTP APIs of Node-RED, InfluxDB 2.x and Grafana, so it runs from any machine.
//   node scripts/deploy.mjs [--no-verify]
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(path.join(root, 'config/site.json'), 'utf8'));
const env = { ...process.env };
if (existsSync(path.join(root, '.env'))) for (const l of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) { const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/); if (m && !(m[1] in process.env)) env[m[1]] = m[2].trim(); }
for (const k of ['NODERED_URL', 'NODERED_USER', 'NODERED_PASS', 'INFLUX_URL', 'INFLUX_USER', 'INFLUX_PASS', 'INFLUX_ORG', 'GRAFANA_URL', 'GRAFANA_USER', 'GRAFANA_PASS', 'MQTT_PW_nodered', 'MQTT_PW_' + cfg.sim.node])
  if (!env[k]) { console.error(`missing ${k} (see .env.example)`); process.exit(1); }
const BUCKET = env.INFLUX_BUCKET || 'flood';
const log = (s) => console.log(s);
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function http(name, url, { method = 'GET', headers = {}, body, ok = [200], raw = false } = {}) {
  let res;
  try { res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`${name}: cannot reach ${url} (${e.cause?.code || e.message})`); }
  if (!ok.includes(res.status)) throw new Error(`${name}: ${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return raw ? res : res.status === 204 ? null : res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

// ---- 1. preflight
log('1/5 preflight');
const health = await http('influx', `${env.INFLUX_URL}/health`);
if (!/^v2\./.test(health.version)) throw new Error(`InfluxDB ${health.version}: need 2.x`);
const gh = await http('grafana', `${env.GRAFANA_URL}/api/health`);
const nr = await (async () => {
  const res = await fetch(`${env.NODERED_URL}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'node-red-admin', grant_type: 'password', scope: '*', username: env.NODERED_USER, password: env.NODERED_PASS }) });
  if (!res.ok) throw new Error(`node-red: login failed (${res.status})`);
  return { Authorization: 'Bearer ' + (await res.json()).access_token };
})();
const nrVer = (await http('node-red', `${env.NODERED_URL}/settings`, { headers: nr })).version;
if (parseInt(nrVer) < 4) throw new Error(`Node-RED ${nrVer}: need 4+`);
log(`    influxdb ${health.version}, grafana ${gh.version}, node-red ${nrVer}`);

// ---- 2. InfluxDB: bucket + least-privilege tokens
log('2/5 influxdb bucket and tokens');
const signin = await http('influx signin', `${env.INFLUX_URL}/api/v2/signin`, { method: 'POST', headers: { Authorization: basic(env.INFLUX_USER, env.INFLUX_PASS) }, ok: [204], raw: true });
const ix = { Cookie: signin.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
const org = (await http('influx org', `${env.INFLUX_URL}/api/v2/orgs?org=${encodeURIComponent(env.INFLUX_ORG)}`, { headers: ix })).orgs?.[0];
if (!org) throw new Error(`InfluxDB org "${env.INFLUX_ORG}" not found`);
let bucket = (await http('influx bucket', `${env.INFLUX_URL}/api/v2/buckets?name=${BUCKET}&orgID=${org.id}`, { headers: ix, ok: [200, 404] }))?.buckets?.[0];
if (!bucket) bucket = await http('influx bucket', `${env.INFLUX_URL}/api/v2/buckets`, { method: 'POST', headers: ix, ok: [201], body: { orgID: org.id, name: BUCKET, retentionRules: [{ type: 'expire', everySeconds: 30 * 86400 }] } });
const auths = (await http('influx auths', `${env.INFLUX_URL}/api/v2/authorizations?orgID=${org.id}`, { headers: ix })).authorizations;
// InfluxDB never returns a token's value after creation, so an existing token cannot be reused. Rotate on every deploy:
// both consumers (Node-RED, Grafana) are redeployed below in the same run and get the new value.
async function token(desc, action) {
  for (const a of auths.filter((x) => x.description === desc)) await http('influx token', `${env.INFLUX_URL}/api/v2/authorizations/${a.id}`, { method: 'DELETE', headers: ix, ok: [204] });
  return (await http('influx token', `${env.INFLUX_URL}/api/v2/authorizations`, { method: 'POST', headers: ix, ok: [201], body: { orgID: org.id, description: desc, permissions: [{ action, resource: { type: 'buckets', id: bucket.id, orgID: org.id } }] } })).token;
}
env.INFLUX_TOKEN_WRITE = await token(`flood-write-${BUCKET}`, 'write');
const tokenRead = await token(`flood-read-${BUCKET}`, 'read');

// ---- 3. Node-RED: merge our flows, never replace the rest
log('3/5 node-red flows');
const mods = await http('node-red', `${env.NODERED_URL}/nodes`, { headers: { ...nr, Accept: 'application/json' } });
if (!mods.some((m) => m.module === 'node-red-contrib-influxdb')) {
  log('    installing node-red-contrib-influxdb (needs npm access from the Node-RED host)');
  await http('node-red install', `${env.NODERED_URL}/nodes`, { method: 'POST', headers: nr, ok: [200, 201], body: { module: 'node-red-contrib-influxdb' } });
}
const { buildFlows } = require(path.join(root, 'nodered/build.js'));
const ours = buildFlows({ cfg, env: { ...env, INFLUX_TOKEN_READ: tokenRead } }); // the REST history endpoint reads InfluxDB with the read-only token
if (!env.REST_PASSWORD) log('    REST_PASSWORD not set: REST endpoints not deployed');
const live = await http('node-red flows', `${env.NODERED_URL}/flows`, { headers: nr });
const kept = live.filter((n) => !String(n.id).startsWith('flood-'));
await http('node-red deploy', `${env.NODERED_URL}/flows`, { method: 'POST', headers: { ...nr, 'Node-RED-Deployment-Type': 'flows' }, ok: [200, 204], body: [...kept, ...ours] });
log(`    kept ${kept.length} existing nodes, deployed ${ours.length} of ours`);

// ---- 4. Grafana: datasource + dashboard
log('4/5 grafana datasource and dashboard');
const gf = { Authorization: basic(env.GRAFANA_USER, env.GRAFANA_PASS) };
const ds = { uid: 'flood-flux', name: 'flood', type: 'influxdb', access: 'proxy', url: env.GRAFANA_INFLUX_URL || 'http://127.0.0.1:8086', jsonData: { version: 'Flux', organization: env.INFLUX_ORG, defaultBucket: BUCKET }, secureJsonData: { token: tokenRead } };
const cur = await http('grafana ds', `${env.GRAFANA_URL}/api/datasources/uid/flood-flux`, { headers: gf, ok: [200, 404] });
if (cur?.id) await http('grafana ds', `${env.GRAFANA_URL}/api/datasources/uid/flood-flux`, { method: 'PUT', headers: gf, body: { ...ds, id: cur.id, version: cur.version } });
else await http('grafana ds', `${env.GRAFANA_URL}/api/datasources`, { method: 'POST', headers: gf, body: ds });
const dash = require(path.join(root, 'grafana/dashboard.js'))(cfg, BUCKET);
const saved = await http('grafana dash', `${env.GRAFANA_URL}/api/dashboards/db`, { method: 'POST', headers: gf, body: { dashboard: dash, overwrite: true, message: 'deploy.mjs' } });
log(`    ${env.GRAFANA_URL}${saved.url}`);

// ---- 5. verify end to end: simulator -> broker (auth) -> Node-RED -> Influx
if (process.argv.includes('--no-verify')) process.exit(0);
log('5/5 verify (waiting for simulated readings to land in InfluxDB)');
const flux = `from(bucket: "${BUCKET}") |> range(start: -2m) |> filter(fn: (r) => r._measurement == "level" and r._field == "seq") |> count()`;
let csv = '';
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  csv = await http('influx query', `${env.INFLUX_URL}/api/v2/query?orgID=${org.id}`, { method: 'POST', headers: { Authorization: `Token ${tokenRead}`, Accept: 'application/csv' }, body: { query: flux, type: 'flux' } });
  const rows = csv.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(','));
  const vi = rows[0]?.indexOf('_value');
  const n = vi >= 0 ? rows.slice(1).reduce((a, r) => a + (Number(r[vi]) || 0), 0) : 0;
  if (n > 0) { log(`    OK: ${n} readings stored in the last 2 min`); await checkDashboard(); process.exit(0); }
}
console.error('    last query result:', JSON.stringify(csv.slice(0, 400)));
console.error('    FAIL: no readings arrived. Check Node-RED debug / "flood: ingest" node status and the broker log.');
process.exit(2);

// Every panel and variable query must run in Grafana without error and, except rejected-readings (empty when the data is clean), return rows.
// ponytail: an empty stream never hits Flux runtime type errors, so the rejected-readings panel is only truly exercised
// when rejects exist (try: mosquitto_pub scenario `glitches` to farm/<site>/sim/control, then re-run).
async function checkDashboard() {
  const fill = (q) => q.replaceAll('${site}', cfg.site).replaceAll('${node}', cfg.sim.node);
  const queries = [...dash.panels.map((p) => [p.title, p.targets[0].query, p.type === 'table' || p.title.startsWith('Pi hub')]), ...dash.templating.list.map((v) => [`variable ${v.name}`, v.query, false])];
  let bad = 0;
  for (const [title, q, mayBeEmpty] of queries) {
    const r = await http('grafana query', `${env.GRAFANA_URL}/api/ds/query`, { method: 'POST', headers: gf, body: { from: 'now-15m', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'flood-flux', type: 'influxdb' }, query: fill(q), maxDataPoints: 500, intervalMs: 5000 }] } });
    const res = r.results.A, rows = (res.frames || []).reduce((a, f) => a + (f.data?.values?.[0]?.length || 0), 0);
    const ok = !res.error && (rows > 0 || mayBeEmpty);
    if (!ok) bad++;
    log(`    ${ok ? 'ok  ' : 'FAIL'} ${title}${res.error ? ': ' + res.error.slice(0, 160) : ` (${rows} rows)`}`);
  }
  if (bad) { console.error(`    ${bad} dashboard queries failed`); process.exit(3); }
}
