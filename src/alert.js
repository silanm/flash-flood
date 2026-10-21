// Alert decisions. Pure: state in, events out, no I/O. Rules are described in ARCHITECTURE.md §8.
// Flood alert: NORMAL -> WARNING -> CRITICAL, driven by level OR rate. Sensor alert: separate (stale / degraded) and never changes the flood state.
const NAMES = ['normal', 'warning', 'critical'];

const newFsm = () => ({
  sev: 0, upN: 0, upMin: 0, upKind: null, clearSince: null, clearMax: 0, alertID: null, acked: false, remindT: null,
  sensor: 'ok', reason: null, badN: 0, okSince: null, sensorRemindT: null, sensorAcked: false,
});

// What the dashboard shows for one node: the flood state, plus 3 if the sensor is faulty (a held WARNING must never look like plain NORMAL).
const view = (fsm) => fsm.sev + (fsm.sensor === 'fault' ? 3 : 0);

// Severity a (level, rate) pair calls for. With clear=true the thresholds are lowered by the hysteresis, so an alert only
// clears once the value is clearly back below the line (stops flapping around a threshold).
function target(level, rate, cfg, clear) {
  const L = cfg.levels, R = cfg.rates, A = cfg.alerts, hl = clear ? A.hysteresis_cm : 0, hr = clear ? A.hysteresis_cm_min : 0, hasRate = Number.isFinite(rate);
  if (level >= L.critical_cm - hl) return { sev: 2, kind: 'level' };
  if (hasRate && rate >= R.critical_cm_min - hr) return { sev: 2, kind: 'rate' };
  if (level >= L.warning_cm - hl) return { sev: 1, kind: 'level' };
  if (hasRate && rate >= R.warning_cm_min - hr) return { sev: 1, kind: 'rate' };
  return { sev: 0, kind: null };
}

const mk = (key, type, now, o) => { const [site, node] = key.split('/'); return { type, site, node, ts: now, ...o }; };

// f = fields of one stored level row {valid, level_f, rate_cm_min, quality}. Called for every non-dropped message.
function onSample(fsm, f, key, cfg, now) {
  const A = cfg.alerts, out = [];
  const sensorEv = (type, o) => mk(key, type, now, { severity: 'sensor', kind: 'sensor', sev: type === 'sensor_fault' ? 1 : 0, held: fsm.sev, seq: f.seq, ...o });

  // sensor health: quality 2 (>50 % of the last minute rejected) for confirm_n messages in a row is a fault
  if (f.quality === 2) {
    fsm.badN++; fsm.okSince = null;
    if (fsm.sensor === 'ok' && fsm.badN >= A.confirm_n) { fsm.sensor = 'fault'; fsm.reason = 'degraded'; fsm.sensorAcked = false; fsm.sensorRemindT = now; out.push(sensorEv('sensor_fault', { reason: 'degraded' })); }
  } else {
    fsm.badN = 0;
    if (fsm.sensor === 'fault') {
      fsm.okSince = fsm.okSince ?? now;
      if (now - fsm.okSince >= A.sensor_clear_s * 1000) { fsm.sensor = 'ok'; out.push(sensorEv('sensor_ok', { reason: fsm.reason })); fsm.reason = null; fsm.okSince = null; }
    }
  }

  // flood level: only accepted readings count. Rejected ones neither escalate nor clear (fail safe).
  if (f.valid && Number.isFinite(f.level_f)) {
    const up = target(f.level_f, f.rate_cm_min, cfg, false), dn = target(f.level_f, f.rate_cm_min, cfg, true);
    const flood = (type, kind) => mk(key, type, now, { severity: NAMES[fsm.sev], sev: fsm.sev, kind, alertID: fsm.alertID, level: f.level_f, rate: f.rate_cm_min, seq: f.seq });
    if (up.sev > fsm.sev) {
      fsm.upMin = fsm.upN === 0 ? up.sev : Math.min(fsm.upMin, up.sev); fsm.upN++; fsm.upKind = up.kind;
      if (fsm.upN >= A.confirm_n) {
        if (fsm.sev === 0) fsm.alertID = `${key}-${now}`;
        fsm.sev = fsm.upMin; fsm.upN = 0; fsm.acked = false; fsm.remindT = now; fsm.clearSince = null; fsm.clearMax = 0;
        out.push(flood('escalate', fsm.upKind));
      }
    } else fsm.upN = 0;
    if (dn.sev < fsm.sev) {
      if (fsm.clearSince === null) { fsm.clearSince = now; fsm.clearMax = dn.sev; } else fsm.clearMax = Math.max(fsm.clearMax, dn.sev);
      if (now - fsm.clearSince >= A.clear_hold_s * 1000) {
        fsm.sev = fsm.clearMax; fsm.clearSince = null; fsm.clearMax = 0;
        out.push(flood(fsm.sev === 0 ? 'clear' : 'deescalate', 'level'));
        if (fsm.sev === 0) fsm.alertID = null;
      }
    } else { fsm.clearSince = null; fsm.clearMax = 0; }
  }
  return out;
}

// Periodic check (every ~10 s). lastSeen = receive time (ms) of the most recent message of any kind from the node.
function onTick(fsm, lastSeen, key, cfg, now) {
  const A = cfg.alerts, out = [], due = (t) => now - t >= A.remind_min * 60000;
  if (fsm.sensor === 'ok' && now - lastSeen > A.stale_after_s * 1000) {
    fsm.sensor = 'fault'; fsm.reason = 'stale'; fsm.sensorAcked = false; fsm.sensorRemindT = now; fsm.okSince = null; fsm.badN = 0;
    out.push(mk(key, 'sensor_fault', now, { severity: 'sensor', kind: 'sensor', sev: 1, reason: 'stale', ageS: Math.round((now - lastSeen) / 1000), held: fsm.sev }));
  }
  if (fsm.sev > 0 && !fsm.acked && due(fsm.remindT)) { fsm.remindT = now; out.push(mk(key, 'reminder', now, { severity: NAMES[fsm.sev], sev: fsm.sev, kind: 'level', alertID: fsm.alertID })); }
  if (fsm.sensor === 'fault' && !fsm.sensorAcked && due(fsm.sensorRemindT)) { fsm.sensorRemindT = now; out.push(mk(key, 'reminder', now, { severity: 'sensor', kind: 'sensor', sev: 1, reason: fsm.reason })); }
  return out;
}

// Acknowledge: silences reminders for whatever is active on this node.
function ack(fsm, key, by, now) {
  const out = [];
  if (fsm.sev > 0 && !fsm.acked) { fsm.acked = true; out.push(mk(key, 'ack', now, { severity: NAMES[fsm.sev], sev: fsm.sev, kind: 'level', alertID: fsm.alertID, by })); }
  if (fsm.sensor === 'fault' && !fsm.sensorAcked) { fsm.sensorAcked = true; out.push(mk(key, 'ack', now, { severity: 'sensor', kind: 'sensor', sev: 1, reason: fsm.reason, by })); }
  return out;
}

// REST acknowledge for a whole site. entries = [[key, fsm]] for every node the platform knows ('site/node'). found=false: no node of that site has reported.
function ackSite(entries, site, by, now) {
  const mine = entries.filter(([key]) => key.startsWith(site + '/'));
  return { found: mine.length > 0, events: mine.flatMap(([key, fsm]) => ack(fsm, key, by, now)) };
}

// An alert raised by the Raspberry Pi hub: {severity: warning|critical|amber|red|sensor, node?, level?, rate?}. Unknown severities are ignored.
function fromHub(site, p, now) {
  const name = String(p && p.severity).toLowerCase(), sev = { critical: 2, red: 2, warning: 1, amber: 1, sensor: 1 }[name];
  if (sev === undefined) return null;
  const sensor = name === 'sensor';
  return { type: 'hub_alert', site, node: String((p && p.node) || 'hub'), hubNode: p.node ? String(p.node) : undefined, source: 'hub', severity: sensor ? 'sensor' : NAMES[sev], sev, kind: sensor ? 'sensor' : 'hub', cls: sensor ? 'sensor' : 'flood', level: Number.isFinite(p.level) ? p.level : undefined, rate: Number.isFinite(p.rate) ? p.rate : undefined, ts: now };
}

// Flap guard for the container's own opening alerts: one per (site,node,severity) per dedupe_window_s.
function gate(ledger, e, cfg, now) {
  const W = cfg.alerts.dedupe_window_s * 1000;
  for (const k of Object.keys(ledger)) if (now - ledger[k] > 10 * W) delete ledger[k];
  const own = `${e.site}|${e.node}|${e.severity}`;
  if (ledger[own] !== undefined && now - ledger[own] < W) return { send: false, reason: 'dedupe' };
  ledger[own] = now;
  return { send: true };
}

// ---- Fallback notifier. The Raspberry Pi is the primary sender; the container only sends when the Pi has not.
// An opening alert (escalate / sensor_fault) is held for fallback.grace_s; it is cancelled if a Pi alert covers it, an ack arrives or the
// condition clears first, and sent otherwise. If the Pi has gone silent (no hub message for pi_dead_after_s) it is sent at once.
// Follow-ups (clear, reminder, ack) are sent only for alerts the container itself sent.
const alertKey = (e) => `${e.site}|${e.node}|${e.kind === 'sensor' ? 'sensor' : 'flood'}`;
const newNotifier = () => ({ hubSeen: {}, hubDead: {}, hubAlerts: [], pending: {}, owned: {}, ledger: {} });
const piDead = (ns, site, cfg, now) => ns.hubSeen[site] !== undefined && now - ns.hubSeen[site] > cfg.alerts.fallback.pi_dead_after_s * 1000;
const hubSeen = (ns, site, now) => { ns.hubSeen[site] = now; }; // any Pi message (heartbeat, ack, alert) proves it is alive

// Did the Pi already alert about something at least as bad, for this site (and this node, if it named one), recently?
function covered(ns, e, cfg, now) {
  const cls = e.kind === 'sensor' ? 'sensor' : 'flood', ttl = cfg.alerts.fallback.cover_s * 1000;
  return ns.hubAlerts.some((h) => h.site === e.site && h.cls === cls && h.sev >= e.sev && (!h.node || h.node === e.node) && now - h.t <= ttl);
}
function send(ns, e, key, reason, cfg, now) {
  const g = gate(ns.ledger, e, cfg, now);
  if (!g.send) return g;
  ns.owned[key] = true;
  return { send: true, reason };
}

// Outcomes are {e, g}: g = {send, reason?, defer?, late?}. defer = decision postponed; late = decision for an event already recorded.
function handle(ns, e, cfg, now) {
  const key = alertKey(e), out = [], dead = piDead(ns, e.site, cfg, now);
  if (e.type === 'escalate' || e.type === 'sensor_fault') {
    const old = ns.pending[key];
    if (old) { delete ns.pending[key]; out.push({ e: old.e, g: { send: false, reason: 'superseded', late: true } }); }
    if (covered(ns, e, cfg, now)) return [...out, { e, g: { send: false, reason: 'covered by Pi' } }];
    if (e.reason === 'stale' && dead) return [...out, { e, g: { send: false, reason: 'Pi offline explains it' } }]; // readings come through the Pi
    if (dead) return [...out, { e, g: send(ns, e, key, 'Pi offline', cfg, now) }];                                  // nobody else will tell anyone
    ns.pending[key] = { e, due: now + cfg.alerts.fallback.grace_s * 1000 };
    return [...out, { e, g: { send: false, defer: true } }];
  }
  const pend = ns.pending[key];
  if (pend) { delete ns.pending[key]; out.push({ e: pend.e, g: { send: false, reason: e.type === 'ack' ? 'acknowledged before sent' : 'resolved before sent', late: true } }); }
  if (!ns.owned[key]) return [...out, { e, g: { send: false, reason: 'Pi owns this alert' } }];
  if (e.type === 'clear' || e.type === 'sensor_ok') delete ns.owned[key];
  return [...out, { e, g: { send: true } }];
}

// A Pi alert: counts as "the Pi told them", and cancels any of our held alerts it covers.
function onHub(ns, e, cfg, now) {
  hubSeen(ns, e.site, now);
  ns.hubAlerts.push({ site: e.site, node: e.hubNode, cls: e.cls, sev: e.sev, t: now });
  ns.hubAlerts = ns.hubAlerts.filter((h) => now - h.t <= 10 * 60000);
  const out = [{ e, g: { send: false, reason: 'sent by the Pi' } }];
  for (const [key, p] of Object.entries(ns.pending)) if (covered(ns, p.e, cfg, now)) { delete ns.pending[key]; out.push({ e: p.e, g: { send: false, reason: 'covered by Pi', late: true } }); }
  return out;
}

// Every ~10 s: Pi liveness, and held alerts whose grace period is over.
function notifyTick(ns, cfg, now) {
  const out = [], hubEv = (type, site, o) => ({ type, site, node: 'hub', severity: 'hub', kind: 'hub', ts: now, ...o });
  for (const [site, t] of Object.entries(ns.hubSeen)) {
    const dead = now - t > cfg.alerts.fallback.pi_dead_after_s * 1000;
    if (dead && !ns.hubDead[site]) { ns.hubDead[site] = true; out.push({ e: hubEv('hub_fault', site, { sev: 1, ageS: Math.round((now - t) / 1000) }), g: { send: true } }); }
    if (!dead && ns.hubDead[site]) { ns.hubDead[site] = false; out.push({ e: hubEv('hub_ok', site, { sev: 0 }), g: { send: true } }); }
  }
  for (const [key, p] of Object.entries(ns.pending)) {
    if (now < p.due) continue;
    delete ns.pending[key];
    const dead = piDead(ns, p.e.site, cfg, now);
    if (covered(ns, p.e, cfg, now)) out.push({ e: p.e, g: { send: false, reason: 'covered by Pi', late: true } });
    else if (p.e.reason === 'stale' && dead) out.push({ e: p.e, g: { send: false, reason: 'Pi offline explains it', late: true } });
    else out.push({ e: p.e, g: { ...send(ns, p.e, key, dead ? 'Pi offline' : 'fallback: Pi did not send', cfg, now), late: true } });
  }
  return out;
}

const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
function describe(e) {
  const w = `${e.site}/${e.node}`, S = String(e.severity).toUpperCase();
  switch (e.type) {
    case 'escalate': return `[${S}] ${w}: ${e.kind === 'rate' ? 'water rising fast' : 'water level high'} - level ${num(e.level)} cm, rate ${num(e.rate, 2)} cm/min`;
    case 'deescalate': return `[${S}] ${w}: eased to ${e.severity} - level ${num(e.level)} cm`;
    case 'clear': return `[NORMAL] ${w}: back to normal - level ${num(e.level)} cm`;
    case 'sensor_fault': return `[SENSOR FAULT] ${w}: ${e.reason === 'stale' ? `no data for ${e.ageS} s` : 'readings unreliable'}.${e.held > 0 ? ` Flood alert ${NAMES[e.held].toUpperCase()} is HELD: level is unknown.` : ''}`;
    case 'sensor_ok': return `[SENSOR OK] ${w}: readings reliable again`;
    case 'reminder': return `[REMINDER] ${w}: still ${e.kind === 'sensor' ? `sensor fault (${e.reason})` : S}, not acknowledged`;
    case 'ack': return `[ACK] ${w}: ${e.kind === 'sensor' ? 'sensor fault' : S} acknowledged by ${e.by}`;
    case 'hub_alert': return `[HUB ${S}] ${e.site}${e.hubNode ? '/' + e.hubNode : ''}: raised by the Pi hub - level ${num(e.level)} cm`;
    case 'hub_fault': return `[PI OFFLINE] ${e.site}: no message from the Pi hub for ${e.ageS} s. The container now raises notifications itself.`;
    case 'hub_ok': return `[PI OK] ${e.site}: the Pi hub is back`;
    default: return `[${e.type}] ${w}`;
  }
}

const STATE = { escalate: (e) => NAMES[e.sev].toUpperCase(), deescalate: (e) => NAMES[e.sev].toUpperCase(), clear: () => 'NORMAL', sensor_fault: () => 'SENSOR_FAULT', sensor_ok: () => 'SENSOR_OK', ack: () => 'ACKED', hub_alert: (e) => 'HUB_' + (e.severity === 'sensor' ? 'SENSOR' : NAMES[e.sev].toUpperCase()), hub_fault: () => 'HUB_FAULT', hub_ok: () => 'HUB_OK' };

// What is actually sent: the description, plus why the container sent it when it is not the primary sender.
const message = (e, g) => describe(e) + (g.send && g.reason ? ` [${g.reason}]` : '');

// InfluxDB points for an outcome: a transition row (once per event: not for reminders, not for a late decision) and a notification-decision
// row (not while the decision is deferred).
function rows(e, g, now) {
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
  const base = { site: e.site, node: e.node, severity: e.severity, kind: e.kind }, out = [];
  if (e.type !== 'reminder' && !g.late) out.push({ measurement: 'alert', tags: clean({ ...base, source: e.source || 'platform' }), fields: clean({ state: STATE[e.type](e), sev: e.sev, alertID: e.alertID, acked: e.type === 'ack', level_cm: e.level, rate_cm_min: e.rate, reason: e.reason }), timestamp: now });
  if (!g.defer) out.push({ measurement: 'notification', tags: clean({ ...base, channel: 'log' }), fields: clean({ text: message(e, g), status: g.send ? 'sent' : 'suppressed', reason: g.reason }), timestamp: now });
  return out;
}

// Retained MQTT state for other systems: farm/<site>/platform/alert/<node> (flood) and .../platform/sensor/<node> (sensor).
function publishable(e) { return e.source !== 'hub' && !['reminder', 'hub_fault', 'hub_ok'].includes(e.type); }
function statePayload(e) {
  const o = { alertID: e.alertID, site: e.site, node: e.node, severity: e.severity, kind: e.kind, state: STATE[e.type](e), level: e.level, rate: e.rate, reason: e.reason, seq: e.seq, ts: new Date(e.ts).toISOString() }; // seq: the reading that triggered it, so a listener can time the alert
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

module.exports = { view, newFsm, onSample, onTick, ack, ackSite, fromHub, gate, describe, message, rows, publishable, statePayload, target, newNotifier, handle, onHub, hubSeen, notifyTick };
