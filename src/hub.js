// The Raspberry Pi hub: what its LED, LCD and buzzer should show, and what it tells the platform. Pure: state in, state out, no I/O.
// The Pi runs the same pipeline.js and alert.js as the container (ARCHITECTURE.md §14). Two modes:
//   edge        the Pi filters, decides and alarms by itself            (the proposed design)
//   cloud_only  the Pi only relays; the container decides, the Pi obeys  (baseline A for the evaluation)
const LABEL = ['NORMAL', 'WARNING', 'CRITICAL'], LED = ['green', 'amber', 'red'];
const SEV = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };
const clip = (s) => String(s).slice(0, 20); // the LCD is 20 x 4
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');

// A stand-in for the container's alert state machine, rebuilt from its retained platform/alert and platform/sensor messages (cloud_only mode).
const newPlatformView = () => ({ sev: 0, acked: false, sensor: 'ok', reason: null, sensorAcked: false });

// fsm: anything with {sev, acked, sensor, reason, sensorAcked}; last: {level_cm, rate_cm_min} of the latest good reading.
function ioState(node, mode, fsm, last, now) {
  const fault = fsm.sensor === 'fault', flood = fsm.sev > 0, l = last || {};
  const needsAck = (flood && !fsm.acked) || (fault && !fsm.sensorAcked);
  const rate = Number.isFinite(l.rate_cm_min) ? ` ${l.rate_cm_min >= 0 ? '+' : ''}${num(l.rate_cm_min)}/m` : '';
  return {
    node, mode, sev: fsm.sev, sensor: fsm.sensor, reason: fsm.reason, acked: fsm.acked, sensorAcked: fsm.sensorAcked,
    led: fsm.sev === 0 && fault ? 'amber' : LED[fsm.sev], // a dead sensor must never show green
    blink: fault,
    buzzer: flood && !fsm.acked ? LABEL[fsm.sev].toLowerCase() : fault && !fsm.sensorAcked ? 'fault' : 'off',
    lcd: [clip(`${node} ${LABEL[fsm.sev]}`), clip(`Lvl ${num(l.level_cm)}cm${rate}`), clip(fault ? `Sensor: ${fsm.reason}` : 'Sensor: ok'), clip(needsAck ? 'Press button to ack' : flood || fault ? 'Acked' : `Mode: ${mode}`)],
    level_cm: l.level_cm, rate_cm_min: l.rate_cm_min, ts: now,
  };
}

// One site shows one state: the worst of its nodes.
const rank = (s) => s.sev * 4 + (s.sensor === 'fault' ? 2 : 0) + (s.sev > 0 && !s.acked ? 1 : 0);
const worst = (states) => states.reduce((a, b) => (rank(b) > rank(a) ? b : a), states[0]);

// Publish a state when something the hardware shows changed (the LCD numbers are refreshed on a timer instead).
const KEYS = ['mode', 'node', 'sev', 'sensor', 'reason', 'acked', 'sensorAcked', 'led', 'blink', 'buzzer'];
const changed = (prev, next) => !prev || KEYS.some((k) => prev[k] !== next[k]);

// farm/<site>/hub/alert, in the shape the container's fromHub() reads. Only a raised alert is published, never a clear or a de-escalation.
function alertPayload(e) {
  if (e.type !== 'escalate' && e.type !== 'sensor_fault') return null;
  const o = { severity: e.type === 'sensor_fault' ? 'sensor' : e.severity, node: e.node, kind: e.kind, level: e.level, rate: e.rate, reason: e.reason, alertID: e.alertID, seq: e.seq, ts: new Date(e.ts).toISOString() };
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v))));
}

const parseMode = (v) => { const m = String(v).trim().toLowerCase().replace('-', '_'); return m === 'edge' || m === 'cloud_only' ? m : null; };

// Fold one retained platform/alert/<node> ("alert") or platform/sensor/<node> ("sensor") message into the stand-in state machine.
function fromPlatform(view, kind, p) {
  const s = p && p.state;
  if (kind === 'alert') {
    if (typeof s === 'string' && SEV[s] !== undefined) { if (SEV[s] > view.sev || SEV[s] === 0) view.acked = false; view.sev = SEV[s]; }
    else if (s === 'ACKED') view.acked = true;
  } else if (kind === 'sensor') {
    if (s === 'SENSOR_FAULT') { view.sensor = 'fault'; view.reason = p.reason || null; view.sensorAcked = false; }
    else if (s === 'SENSOR_OK') { view.sensor = 'ok'; view.reason = null; view.sensorAcked = false; }
    else if (s === 'ACKED') view.sensorAcked = true;
  }
  return view;
}

module.exports = { newPlatformView, ioState, worst, changed, alertPayload, parseMode, fromPlatform };
