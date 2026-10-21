// Builds the Node-RED flows for this platform from src/*.js. Every node id starts with "flood-" so deploy can replace
// our nodes without touching anything else on the target.
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
// Inline a pure module into a function node: tests and runtime run the same code.
// files: one file name (bound to M) or {M: 'alert.js', R: 'rest.js'}.
const prelude = (files, cfg) => `const CFG = ${JSON.stringify(cfg)};\n` + Object.entries(typeof files === 'string' ? { M: files } : files)
  .map(([v, f]) => `const ${v} = (() => { const module = { exports: {} };\n${read(f)}\nreturn module.exports; })();\n`).join('');

const PIPELINE_GLUE = `
let p; try { p = JSON.parse(msg.payload); } catch (e) { p = null; }
const [, site, , nodeId] = msg.topic.split('/');
const seen = flow.get('seen') || {}; seen[site + '/' + nodeId] = Date.now(); flow.set('seen', seen); // any message, even a duplicate, proves the node is alive
const key = 'st:' + site + '/' + nodeId;
const r = M.step(flow.get(key) || M.newState(), p, CFG, Date.now());
flow.set(key, r.st);
if (r.out.drop) { node.status({ fill: 'grey', shape: 'ring', text: nodeId + ' dropped ' + r.out.drop }); return null; }
msg.row = { site, node: nodeId, tags: r.out.tags, fields: r.out.fields, ts: r.out.ts };
return msg;`;

const ALERT_GLUE = `
const r = msg.row, key = r.site + '/' + r.node, now = Date.now();
const fsm = flow.get('fsm:' + key) || M.newFsm();
const events = M.onSample(fsm, r.fields, key, CFG, now);
flow.set('fsm:' + key, fsm);
const f = r.fields;
f.alert_sev = fsm.sev; f.alert_view = M.view(fsm); // lets the dashboard draw the alert state as a continuous timeline
const label = ['NORMAL', 'WARNING', 'CRITICAL'][fsm.sev];
node.status({ fill: fsm.sev === 2 ? 'red' : fsm.sev === 1 ? 'yellow' : f.valid ? 'green' : 'grey', shape: 'dot', text: r.node + ' ' + label + (fsm.sensor === 'fault' ? ' / SENSOR ' + fsm.reason : '') + ' ' + (f.valid ? f.level_f.toFixed(1) + ' cm' : 'rejected ' + f.reject) });
return [{ payload: [{ measurement: 'level', tags: { site: r.site, node: r.node, ...r.tags }, fields: f, timestamp: r.ts }] }, events.map((e) => ({ payload: e }))];`;

const WATCHDOG_GLUE = `
const seen = flow.get('seen') || {}, now = Date.now(), out = [];
for (const [key, t] of Object.entries(seen)) {
  const fsm = flow.get('fsm:' + key) || M.newFsm();
  out.push(...M.onTick(fsm, t, key, CFG, now));
  flow.set('fsm:' + key, fsm);
}
return [out.map((e) => ({ payload: e }))];`;

const ACK_GLUE = `
const site = msg.topic.split('/')[1]; let p; try { p = JSON.parse(msg.payload); } catch (e) { p = {}; }
const now = Date.now(), out = [];
for (const k of flow.keys()) if (k.startsWith('fsm:' + site + '/')) { const fsm = flow.get(k); out.push(...M.ack(fsm, k.slice(4), (p && p.ackBy) || 'unknown', now)); flow.set(k, fsm); }
return [[{ payload: { type: 'hub_seen', site } }, ...out.map((e) => ({ payload: e }))]];`;

const HUBALERT_GLUE = `
let p; try { p = JSON.parse(msg.payload); } catch (e) { p = null; }
const e = M.fromHub(msg.topic.split('/')[1], p, Date.now());
return e ? { payload: e } : null;`;

const HEARTBEAT_GLUE = `
const site = msg.topic.split('/')[1];
return [{ payload: [{ measurement: 'hub', tags: { site }, fields: { beat: 1 }, timestamp: Date.now() }] }, { payload: { type: 'hub_seen', site } }];`;

// One function for every notification decision. Inputs: our own alert events, Pi alerts (hub_alert), Pi liveness (hub_seen), and the 10 s tick.
const NOTIFY_GLUE = `
const e = msg.payload, now = Date.now(), ns = flow.get('notifier') || M.newNotifier();
let outcomes;
if (msg.topic === 'tick') outcomes = M.notifyTick(ns, CFG, now);
else if (e && e.type === 'hub_seen') { M.hubSeen(ns, e.site, now); outcomes = []; }
else if (e && e.type === 'hub_alert') outcomes = M.onHub(ns, e, CFG, now);
else outcomes = M.handle(ns, e, CFG, now);
flow.set('notifier', ns);
const rows = [], pubs = [];
for (const { e: ev, g } of outcomes) {
  if (g.send) node.warn(M.message(ev, g)); // "log" channel: the Node-RED log and the dashboard table. An external push channel (out of scope) would plug in here.
  rows.push({ payload: M.rows(ev, g, now) });
  if (!g.late && M.publishable(ev)) pubs.push({ topic: 'farm/' + ev.site + '/platform/' + (ev.kind === 'sensor' ? 'sensor' : 'alert') + '/' + ev.node, qos: 1, retain: true, payload: JSON.stringify(M.statePayload(ev)) });
}
const held = Object.keys(ns.pending).length;
node.status({ fill: held ? 'yellow' : 'blue', shape: 'dot', text: held + ' held, ' + outcomes.filter((o) => o.g.send).length + ' sent now' });
return [rows, pubs];`;

const STATUS_GLUE = `
const [, site, , nodeId] = msg.topic.split('/');
msg.payload = [{ measurement: 'node_status', tags: { site, node: nodeId, source: 'lwt' }, fields: { online: String(msg.payload).trim() === 'online' }, timestamp: Date.now() }];
return msg;`;

const SIM_GLUE = `
let sim = context.get('sim');
if (!sim) { sim = M.newSim(CFG.sim.seed); M.setScenario(sim, CFG.sim.scenario); context.set('sim', sim); context.set('on', CFG.sim.autostart); }
if (msg.topic !== 'tick') { // control: a scenario name, or on / off
  const c = String(msg.payload).trim();
  if (c === 'on' || c === 'off') context.set('on', c === 'on'); else if (M.setScenario(sim, c)) context.set('on', true);
  node.status({ text: (context.get('on') ? sim.scenario : 'off') });
  return null;
}
if (!context.get('on')) { node.status({ fill: 'grey', shape: 'ring', text: 'simulator off' }); return null; }
const out = M.tick(sim, CFG, Date.now());
node.status({ fill: 'blue', shape: 'dot', text: sim.scenario + ' t=' + sim.t + 's' });
return [out];`;

// REST endpoints (src/rest.js). Each request is authenticated first; output 1 continues, output 2 goes straight to the HTTP response.
const REST_COMMON = `
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const reply = (status, body, headers) => Object.assign(msg, { statusCode: status, headers: headers || {}, payload: body });
if (!R.authorized(msg.req.headers.authorization, CFG.rest, sha)) return [null, reply(401, { error: 'authentication required' }, { 'WWW-Authenticate': 'Basic realm="flood"' })];`;

const REST_ALERTS_GLUE = REST_COMMON + `
const q = R.alertsQuery(msg.req.query, CFG.rest.bucket, Date.now());
if (q.error) return [null, reply(q.error.status, { error: q.error.message })];
msg.query = q.flux;
return [msg, null];`;

const REST_SHAPE_GLUE = `
delete msg.query;
msg.statusCode = 200; msg.headers = {}; msg.payload = R.toAlerts(msg.payload);
return msg;`;

const REST_ERROR_GLUE = `
msg.statusCode = 500; msg.headers = {}; msg.payload = { error: 'history query failed' };
return msg;`;

// Acknowledges at the platform tier only: the ack events go to the notifier like an MQTT ack, but no hub/ack is published (only the Pi may
// publish that topic) and the Pi is not marked alive, since this request did not come from it.
const REST_ACK_GLUE = REST_COMMON + `
const a = R.ackRequest(msg.req.params, msg.payload);
if (a.error) return [null, reply(a.error.status, { error: a.error.message })];
const entries = flow.keys().filter((k) => k.startsWith('fsm:')).map((k) => [k.slice(4), flow.get(k)]);
const r = M.ackSite(entries, a.site, a.by, Date.now());
if (!r.found) return [null, reply(404, { error: 'unknown site' })];
for (const [k, fsm] of entries) flow.set('fsm:' + k, fsm);
return [r.events.map((e) => ({ payload: e })), reply(200, { siteID: a.site, acked: r.events.length > 0, count: r.events.length, ackTs: new Date().toISOString() })];`;

function buildFlows({ cfg, env }) {
  const org = env.INFLUX_ORG, bucket = env.INFLUX_BUCKET || 'flood';
  const mqttHost = env.NR_MQTT_HOST || '127.0.0.1', mqttPort = env.MQTT_PORT || '1883';
  const influxUrl = env.NR_INFLUX_URL || 'http://127.0.0.1:8086';
  const simNode = cfg.sim.node, simBase = `farm/${cfg.site}/node/${simNode}`;
  const broker = (id, name, clientid, user, pw, extra = {}) => ({
    id, type: 'mqtt-broker', name, broker: mqttHost, port: mqttPort, clientid, autoConnect: true, usetls: false,
    protocolVersion: '4', keepalive: '60', cleansession: false, credentials: { user, password: pw }, ...extra,
  });
  const fn = (id, z, name, body, x, y, wires, file, opt = {}) => ({ id, type: 'function', z, name, func: (file ? prelude(file, opt.cfg || cfg) : '') + body, outputs: wires.length, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: opt.libs || [], x, y, wires });
  const mqttIn = (id, z, name, topic, brokerId, x, y, wires) => ({ id, type: 'mqtt in', z, name, topic, qos: '1', datatype: 'utf8', broker: brokerId, nl: false, rap: true, rh: 0, inputs: 0, x, y, wires: [wires] });
  const influxOut = (id, z, name, x, y) => ({ id, type: 'influxdb batch', z, name, influxdb: 'flood-influx', measurement: '', precision: '', retentionPolicy: '', database: '', precisionV18FluxV20: 'ms', retentionPolicyV18Flux: '', org, bucket, x, y, wires: [] });

  const scenarios = Object.keys(require('../src/sim').SCENARIOS);

  // REST endpoints sit on the ingest tab because they read the alert state kept in that flow's context. Without REST_PASSWORD they are not
  // deployed at all, so an unauthenticated endpoint can never exist. Needs functionExternalModules (for crypto) and INFLUX_TOKEN_READ.
  const tab = 'flood-tab-ingest';
  const restCfg = { ...cfg, rest: { user: env.REST_USER || 'operator', sha256: require('crypto').createHash('sha256').update(env.REST_PASSWORD || '').digest('hex'), bucket } };
  const crypto = { libs: [{ var: 'crypto', module: 'crypto' }], cfg: restCfg };
  const httpIn = (id, name, method, url, y, wires) => ({ id, type: 'http in', z: tab, name, url, method, upload: false, swaggerDoc: '', x: 140, y, wires: [wires] });
  const httpOut = (id, y) => ({ id, type: 'http response', z: tab, name: 'respond', statusCode: '', headers: {}, x: 940, y, wires: [] });
  const rest = !env.REST_PASSWORD ? [] : [
    { id: 'flood-influx-read', type: 'influxdb', name: 'flood (read)', influxdbVersion: '2.0', url: influxUrl, timeout: '10', rejectUnauthorized: true, credentials: { token: env.INFLUX_TOKEN_READ } },
    httpIn('flood-rest-in-alerts', 'GET /api/v1/alerts', 'get', '/api/v1/alerts', 540, ['flood-rest-alerts']),
    fn('flood-rest-alerts', tab, 'auth + parse', REST_ALERTS_GLUE, 340, 540, [['flood-rest-influx'], ['flood-rest-out']], { R: 'rest.js' }, crypto),
    { id: 'flood-rest-influx', type: 'influxdb in', z: tab, name: 'influx: alert history', influxdb: 'flood-influx-read', query: '', rawOutput: false, precision: '', retentionPolicy: '', org, x: 540, y: 540, wires: [['flood-rest-shape']] },
    fn('flood-rest-shape', tab, 'shape', REST_SHAPE_GLUE, 740, 540, [['flood-rest-out']], { R: 'rest.js' }),
    { id: 'flood-rest-catch', type: 'catch', z: tab, name: 'history query failed', scope: ['flood-rest-influx'], uncaught: false, x: 540, y: 600, wires: [['flood-rest-error']] },
    fn('flood-rest-error', tab, 'error 500', REST_ERROR_GLUE, 740, 600, [['flood-rest-out']]),
    httpIn('flood-rest-in-ack', 'POST /api/v1/sites/:siteID/ack', 'post', '/api/v1/sites/:siteID/ack', 680, ['flood-rest-ack']),
    fn('flood-rest-ack', tab, 'auth + acknowledge', REST_ACK_GLUE, 340, 680, [['flood-fn-notify'], ['flood-rest-out']], { M: 'alert.js', R: 'rest.js' }, crypto),
    httpOut('flood-rest-out', 560),
  ];
  return [
    broker('flood-broker-platform', 'flood platform', 'flood-nodered', 'nodered', env.MQTT_PW_nodered),
    broker('flood-broker-sim', 'flood simulator', 'flood-sim01', simNode, env['MQTT_PW_' + simNode], {
      birthTopic: `${simBase}/status`, birthQos: '1', birthRetain: 'true', birthPayload: 'online',
      willTopic: `${simBase}/status`, willQos: '1', willRetain: 'true', willPayload: 'offline',
    }),
    { id: 'flood-influx', type: 'influxdb', name: 'flood', influxdbVersion: '2.0', url: influxUrl, timeout: '10', rejectUnauthorized: true, credentials: { token: env.INFLUX_TOKEN_WRITE } },

    { id: 'flood-tab-ingest', type: 'tab', label: 'flood: ingest', disabled: false, info: 'MQTT -> HC-SR04 conditioning (src/pipeline.js) -> InfluxDB. Generated by nodered/build.js; edit src/, not here.' },
    mqttIn('flood-in-level', 'flood-tab-ingest', 'level', 'farm/+/node/+/level', 'flood-broker-platform', 130, 60, ['flood-fn-pipeline']),
    fn('flood-fn-pipeline', 'flood-tab-ingest', 'condition', PIPELINE_GLUE, 310, 60, [['flood-fn-alert']], 'pipeline.js'),
    fn('flood-fn-alert', 'flood-tab-ingest', 'alert logic', ALERT_GLUE, 500, 60, [['flood-out-level'], ['flood-fn-notify']], 'alert.js'),
    influxOut('flood-out-level', 'flood-tab-ingest', 'influx: level', 720, 40),
    mqttIn('flood-in-status', 'flood-tab-ingest', 'status (LWT)', 'farm/+/node/+/status', 'flood-broker-platform', 130, 200, ['flood-fn-status']),
    fn('flood-fn-status', 'flood-tab-ingest', 'status row', STATUS_GLUE, 310, 200, [['flood-out-status']]),
    influxOut('flood-out-status', 'flood-tab-ingest', 'influx: node_status', 520, 200),
    { id: 'flood-wd-tick', type: 'inject', z: 'flood-tab-ingest', name: 'tick 10s', props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], repeat: '10', crontab: '', once: true, onceDelay: 5, topic: 'tick', payload: '', payloadType: 'date', x: 130, y: 280, wires: [['flood-fn-watchdog', 'flood-fn-notify']] },
    fn('flood-fn-watchdog', 'flood-tab-ingest', 'watchdog + reminders', WATCHDOG_GLUE, 330, 280, [['flood-fn-notify']], 'alert.js'),
    mqttIn('flood-in-ack', 'flood-tab-ingest', 'hub/ack', 'farm/+/hub/ack', 'flood-broker-platform', 130, 340, ['flood-fn-ack']),
    fn('flood-fn-ack', 'flood-tab-ingest', 'acknowledge', ACK_GLUE, 310, 340, [['flood-fn-notify']], 'alert.js'),
    mqttIn('flood-in-hubalert', 'flood-tab-ingest', 'hub/alert (Pi)', 'farm/+/hub/alert', 'flood-broker-platform', 130, 400, ['flood-fn-hubalert']),
    fn('flood-fn-hubalert', 'flood-tab-ingest', 'Pi alert', HUBALERT_GLUE, 330, 400, [['flood-fn-notify']], 'alert.js'),
    mqttIn('flood-in-heartbeat', 'flood-tab-ingest', 'hub/heartbeat (Pi)', 'farm/+/hub/heartbeat', 'flood-broker-platform', 130, 460, ['flood-fn-heartbeat']),
    fn('flood-fn-heartbeat', 'flood-tab-ingest', 'Pi alive', HEARTBEAT_GLUE, 330, 460, [['flood-out-events'], ['flood-fn-notify']]),
    fn('flood-fn-notify', 'flood-tab-ingest', 'notify (log)', NOTIFY_GLUE, 720, 300, [['flood-out-events'], ['flood-out-pub']], 'alert.js'),
    influxOut('flood-out-events', 'flood-tab-ingest', 'influx: alert + notification', 940, 280),
    { id: 'flood-out-pub', type: 'mqtt out', z: 'flood-tab-ingest', name: 'platform/alert|sensor', topic: '', qos: '', retain: '', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: 'flood-broker-platform', x: 940, y: 340, wires: [] },

    { id: 'flood-tab-sim', type: 'tab', label: 'flood: simulator', disabled: false, info: `Simulated node ${simNode} publishing to the real broker on the real topics. Click a scenario inject, or publish a scenario name / on / off to farm/${cfg.site}/sim/control.` },
    { id: 'flood-sim-tick', type: 'inject', z: 'flood-tab-sim', name: `tick ${cfg.sim.interval_s}s`, props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], repeat: String(cfg.sim.interval_s), crontab: '', once: true, onceDelay: 3, topic: 'tick', payload: '', payloadType: 'date', x: 130, y: 60, wires: [['flood-fn-sim']] },
    mqttIn('flood-sim-ctl', 'flood-tab-sim', 'control', `farm/${cfg.site}/sim/control`, 'flood-broker-sim', 140, 110, ['flood-fn-sim']),
    ...scenarios.map((s, i) => ({ id: `flood-sim-sc-${s}`, type: 'inject', z: 'flood-tab-sim', name: s, props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: 'control', payload: s, payloadType: 'str', x: 130, y: 170 + 40 * i, wires: [['flood-fn-sim']] })),
    ...['on', 'off'].map((s, i) => ({ id: `flood-sim-${s}`, type: 'inject', z: 'flood-tab-sim', name: `sim ${s}`, props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], repeat: '', crontab: '', once: false, onceDelay: 0.1, topic: 'control', payload: s, payloadType: 'str', x: 130, y: 170 + 40 * (scenarios.length + i), wires: [['flood-fn-sim']] })),
    fn('flood-fn-sim', 'flood-tab-sim', 'simulate', SIM_GLUE, 380, 110, [['flood-sim-out']], 'sim.js'),
    { id: 'flood-sim-out', type: 'mqtt out', z: 'flood-tab-sim', name: 'publish', topic: '', qos: '', retain: '', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: 'flood-broker-sim', x: 600, y: 110, wires: [] },
    ...rest,
  ];
}

module.exports = { buildFlows };
