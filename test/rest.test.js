const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const cfg = require('../config/site.json');
const A = require('../src/alert');
const R = require('../src/rest');
const { buildFlows } = require('../nodered/build');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const NOW = Date.parse('2026-10-21T10:00:00Z');
const REST = { user: 'operator', sha256: sha('p:w') }; // the password contains ':' on purpose

test('auth: only the right user and password pass; malformed headers fail', () => {
  const ok = (h) => R.authorized(h, REST, sha);
  assert.equal(ok(basic('operator', 'p:w')), true);
  for (const h of [undefined, '', 'Bearer abc', 'Basic', 'Basic !!!', basic('operator', 'p'), basic('other', 'p:w'), basic('operator', ''), 'Basic ' + Buffer.from('nocolon').toString('base64')])
    assert.equal(ok(h), false, String(h));
});

test('alerts query: siteID is required and cannot carry Flux or MQTT wildcards', () => {
  assert.equal(R.alertsQuery({}, 'flood', NOW).error.status, 400);
  for (const site of ['', 'a b', 'x"', 'x") |> yield() //', 'a/b', '+', '#', 'a'.repeat(41), ['demo']])
    assert.equal(R.alertsQuery({ siteID: site }, 'flood', NOW).error?.status, 400, JSON.stringify(site));
  const q = R.alertsQuery({ siteID: 'demo' }, 'flood', NOW);
  assert.ok(q.flux.includes('r.site == "demo"') && q.flux.includes('from(bucket: "flood")') && q.flux.includes('desc: true') && q.flux.includes('limit(n: 200)'));
  assert.equal(q.since, NOW - 24 * 3600e3, 'default window is 24 h');
});

test('alerts query: since must be an ISO time with a zone, in the past', () => {
  const since = (s) => R.alertsQuery({ siteID: 'demo', since: s }, 'flood', NOW);
  assert.equal(since('2026-10-21T08:30:00Z').since, Date.parse('2026-10-21T08:30:00Z'));
  assert.equal(since('2026-10-21T15:30:00+07:00').since, Date.parse('2026-10-21T08:30:00Z'));
  assert.ok(since('2026-10-21T08:30:00Z').flux.includes('range(start: 2026-10-21T08:30:00.000Z)'));
  for (const s of ['yesterday', '2026-10-21', '2026-10-21T08:30:00', '2026-10-21T15:30:00 07:00', '2026-10-21T12:00:00Z', '2026-13-45T00:00:00Z', 'x") |> yield()', ['2026-10-21T08:30:00Z']])
    assert.equal(since(s).error?.status, 400, JSON.stringify(s));
});

test('alert rows become the contract: ISO ts, no empty fields, junk rows dropped', () => {
  const rows = [
    { _time: '2026-10-21T09:00:00.5Z', node: 'sim01', kind: 'rate', severity: 'critical', source: 'platform', state: 'CRITICAL', alertID: 'demo/sim01-1', level_cm: 9.5, rate_cm_min: 2.7, extra: 'dropped', site: 'demo' },
    { _time: new Date('2026-10-21T08:00:00Z'), node: 'sim01', kind: 'sensor', severity: 'sensor', source: 'platform', state: 'SENSOR_FAULT', reason: 'stale' },
    { node: 'no time' }, null, { _time: 'garbage' },
    { _time: '2026-10-21T07:00:00Z', node: 'hub', kind: 'hub', severity: 'hub', source: 'platform', state: 'HUB_FAULT', alertID: '', reason: '', level_cm: null }, // as the live pivot returns a row with no such fields
  ];
  assert.deepEqual(R.toAlerts(rows), [
    { alertID: 'demo/sim01-1', node: 'sim01', kind: 'rate', severity: 'critical', state: 'CRITICAL', level_cm: 9.5, rate_cm_min: 2.7, source: 'platform', ts: '2026-10-21T09:00:00.500Z' },
    { node: 'sim01', kind: 'sensor', severity: 'sensor', state: 'SENSOR_FAULT', source: 'platform', reason: 'stale', ts: '2026-10-21T08:00:00.000Z' },
    { node: 'hub', kind: 'hub', severity: 'hub', state: 'HUB_FAULT', source: 'platform', ts: '2026-10-21T07:00:00.000Z' },
  ]);
  for (const x of [undefined, null, 'x', {}]) assert.deepEqual(R.toAlerts(x), []);
});

test('ack request: needs a valid site and a plain ackBy name', () => {
  assert.deepEqual(R.ackRequest({ siteID: 'demo' }, { ackBy: 'somchai' }), { site: 'demo', by: 'somchai' });
  assert.equal(R.ackRequest({ siteID: 'demo' }, { ackBy: 'Somchai J.' }).by, 'Somchai J.');
  for (const [p, b] of [[{ siteID: 'a/b' }, { ackBy: 'x' }], [{}, { ackBy: 'x' }], [{ siteID: 'demo' }, undefined], [{ siteID: 'demo' }, {}], [{ siteID: 'demo' }, { ackBy: '' }],
    [{ siteID: 'demo' }, { ackBy: 'a'.repeat(65) }], [{ siteID: 'demo' }, { ackBy: 'x\n[ACK] forged' }], [{ siteID: 'demo' }, { ackBy: 7 }], [{ siteID: 'demo' }, 'ackBy=x']])
    assert.equal(R.ackRequest(p, b).error?.status, 400, JSON.stringify([p, b]));
});

// ---- the platform state the endpoints act on
function warning(key) { // an FSM that has really escalated to WARNING
  const fsm = A.newFsm(), f = { valid: true, level_f: cfg.levels.warning_cm + 1, rate_cm_min: 0, quality: 0 };
  for (let i = 0; i < cfg.alerts.confirm_n; i++) A.onSample(fsm, f, key, cfg, NOW + i * 2000);
  assert.equal(fsm.sev, 1); return fsm;
}

test('ackSite: acknowledges every active alert of that site only, once', () => {
  const a = warning('demo/sim01'), b = warning('demo/sim02'), other = warning('demo2/x'), calm = A.newFsm();
  const entries = [['demo/sim01', a], ['demo/sim02', b], ['demo/calm', calm], ['demo2/x', other]];
  const r = A.ackSite(entries, 'demo', 'somchai', NOW + 60000);
  assert.equal(r.found, true); assert.deepEqual(r.events.map((e) => [e.type, e.node, e.by]), [['ack', 'sim01', 'somchai'], ['ack', 'sim02', 'somchai']]);
  assert.equal(a.acked && b.acked, true); assert.equal(other.acked, false, 'a site whose name merely starts the same is untouched');
  const again = A.ackSite(entries, 'demo', 'somchai', NOW + 61000);
  assert.deepEqual([again.found, again.events], [true, []], 'already acknowledged: nothing to do, not an error');
  assert.equal(A.ackSite(entries, 'nowhere', 'x', NOW).found, false);
});

test('ackSite: a sensor fault is acknowledged too', () => {
  const fsm = A.newFsm(); A.onTick(fsm, NOW - 120000, 'demo/sim01', cfg, NOW);
  assert.equal(fsm.sensor, 'fault');
  const r = A.ackSite([['demo/sim01', fsm]], 'demo', 'x', NOW + 1000);
  assert.deepEqual(r.events.map((e) => e.kind), ['sensor']); assert.equal(fsm.sensorAcked, true);
});

// ---- the generated Node-RED flows: build them and run the real function-node code with a fake context
const ENV = { INFLUX_ORG: 'org', INFLUX_TOKEN_READ: 'read-token', REST_PASSWORD: 'p:w' };
const flows = buildFlows({ cfg, env: ENV });
const node = (id) => flows.find((n) => n.id === id);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ctx = (obj = {}) => ({ keys: () => Object.keys(obj), get: (k) => obj[k], set: (k, v) => { obj[k] = v; } });
const call = (id, msg, flow = ctx()) => new AsyncFunction('msg', 'node', 'flow', 'crypto', node(id).func)(msg, { status() {} }, flow, crypto);
const request = (o) => ({ req: { headers: { authorization: basic('operator', 'p:w') }, query: {}, params: {}, ...o }, payload: o.body });

test('flows: every function node compiles, every wire has a target, ids stay in the flood- namespace', () => {
  const ids = new Set(flows.map((n) => n.id));
  for (const n of flows) {
    assert.ok(n.id.startsWith('flood-'), n.id);
    if (n.type === 'function') assert.doesNotThrow(() => new AsyncFunction('msg', 'node', 'flow', 'context', 'crypto', n.func), n.id);
    for (const w of (n.wires || []).flat()) assert.ok(ids.has(w), `${n.id} -> ${w}`);
    if (n.type === 'catch') for (const s of n.scope) assert.ok(ids.has(s), `${n.id} scope ${s}`);
  }
});

test('flows: without REST_PASSWORD no REST node exists; with it the password is stored only as a hash', () => {
  const none = buildFlows({ cfg, env: { ...ENV, REST_PASSWORD: '' } });
  assert.equal(none.some((n) => n.type === 'http in' || n.id.startsWith('flood-rest-')), false);
  assert.equal(none.some((n) => n.id === 'flood-influx-read'), false);
  const text = JSON.stringify(flows);
  assert.ok(!text.includes('p:w') && text.includes(sha('p:w')));
  assert.deepEqual(flows.filter((n) => n.type === 'http in').map((n) => [n.method, n.url]), [['get', '/api/v1/alerts'], ['post', '/api/v1/sites/:siteID/ack']]);
  assert.equal(node('flood-influx-read').credentials.token, 'read-token', 'history is read with the read token, not the write token');
});

test('GET alerts flow: 401 without valid credentials, 400 on a bad query, otherwise a Flux query', async () => {
  const noAuth = await call('flood-rest-alerts', { req: { headers: {}, query: { siteID: 'demo' }, params: {} } });
  assert.equal(noAuth[0], null); assert.equal(noAuth[1].statusCode, 401); assert.match(noAuth[1].headers['WWW-Authenticate'], /^Basic/);
  const wrong = await call('flood-rest-alerts', request({ headers: { authorization: basic('operator', 'nope') }, query: { siteID: 'demo' } }));
  assert.equal(wrong[1].statusCode, 401);
  const badQ = await call('flood-rest-alerts', request({ query: { siteID: 'x") |> yield()' } }));
  assert.equal(badQ[0], null); assert.equal(badQ[1].statusCode, 400);
  const good = await call('flood-rest-alerts', request({ query: { siteID: 'demo' } }));
  assert.equal(good[1], null); assert.match(good[0].query, /r\.site == "demo"/); assert.match(good[0].query, /from\(bucket: "flood"\)/);
});

test('GET alerts flow: rows are shaped into the contract; a failed query answers 500', async () => {
  const shaped = await call('flood-rest-shape', { query: 'x', payload: [{ _time: '2026-10-21T09:00:00Z', node: 'sim01', state: 'WARNING', severity: 'warning', kind: 'level' }] });
  assert.equal(shaped.statusCode, 200); assert.equal('query' in shaped, false);
  assert.deepEqual(shaped.payload, [{ node: 'sim01', kind: 'level', severity: 'warning', state: 'WARNING', ts: '2026-10-21T09:00:00.000Z' }]);
  const err = await call('flood-rest-error', { error: { message: 'secret detail' } });
  assert.equal(err.statusCode, 500); assert.deepEqual(err.payload, { error: 'history query failed' }, 'no internal detail leaks');
});

test('POST ack flow: 401, 400, 404 change nothing; 200 acknowledges and hands the events to the notifier', async () => {
  const state = { 'fsm:demo/sim01': warning('demo/sim01') }, flow = ctx(state);
  const post = (o) => call('flood-rest-ack', request({ params: { siteID: 'demo' }, body: { ackBy: 'somchai' }, ...o }), flow);

  const noAuth = await post({ headers: {} });
  assert.equal(noAuth[1].statusCode, 401); assert.equal(state['fsm:demo/sim01'].acked, false);
  assert.equal((await post({ body: {} }))[1].statusCode, 400);
  const unknown = await post({ params: { siteID: 'nowhere' } });
  assert.equal(unknown[0], null); assert.equal(unknown[1].statusCode, 404); assert.equal(state['fsm:demo/sim01'].acked, false);

  const [events, res] = await post({});
  assert.equal(res.statusCode, 200); assert.equal(res.payload.siteID, 'demo'); assert.equal(res.payload.acked, true); assert.equal(res.payload.count, 1);
  assert.ok(!Number.isNaN(Date.parse(res.payload.ackTs)));
  assert.deepEqual(events.map((m) => [m.payload.type, m.payload.node, m.payload.by]), [['ack', 'sim01', 'somchai']]);
  assert.equal(events.some((m) => m.payload.type === 'hub_seen'), false, 'the Pi is not marked alive by an operator request');
  assert.equal(state['fsm:demo/sim01'].acked, true);

  const [none, again] = await post({});
  assert.deepEqual([none, again.statusCode, again.payload.acked, again.payload.count], [[], 200, false, 0]);
});
