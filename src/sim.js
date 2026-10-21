// Deterministic simulator for one HC-SR04 node. Pure: produces the MQTT messages a real node would send.
const SCENARIOS = {
  calm:        () => ({ level: 6 }),
  slow_rise:   (t) => ({ level: 6 + 0.4 * t / 60 }),
  flash_rise:  (t) => ({ level: 6 + 3 * t / 60 }),
  recede:      (t) => ({ level: Math.max(2, 20 - 2 * t / 60) }),
  glitches:    (t) => ({ level: 8, glitchP: 0.07, stuck: t >= 60 && t < 180 }),
  sensor_dead: (t) => ({ level: 16, dead: t >= 30 && t < 90 }),
  failover:    (t) => ({ level: 10, rf: t >= 30 && t < 90 }),
  silence:     (t) => ({ level: 10, silent: t >= 30 && t < 150 }),
  temp_swing:  (t) => ({ level: 10, temp: 25 + 15 * Math.min(t, 240) / 240 }), // air warms 25 -> 40 C; an uncompensated sensor drifts ~0.7 cm
  temp_fault:  (t) => ({ level: 10, tempReading: t >= 60 && t < 90 ? null : t >= 90 && t < 120 ? -127 : undefined }), // temp sensor drops out, then reports DS18B20 error code
};

const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
const newSim = (seed = 1) => ({ rnd: rng(seed), t: 0, seq: 0, lastD: null, status: null, scenario: 'calm' });
const setScenario = (sim, name) => { if (!SCENARIOS[name]) return false; sim.scenario = name; sim.t = 0; sim.lastD = null; return true; };

// One sampling tick. Returns [{topic,payload,qos,retain?}]. now = ms epoch.
function tick(sim, cfg, now) {
  const { site, tank: T, sim: S } = cfg, base = `farm/${site}/node/${S.node}`;
  const t0 = sim.t, sp = SCENARIOS[sim.scenario](t0), out = [];
  sim.t += S.interval_s;
  const status = sp.rf ? 'offline' : 'online'; // LWT fires when WiFi path dies, while RF data keeps arriving
  if (status !== sim.status) { sim.status = status; out.push({ topic: `${base}/status`, payload: status, qos: 1, retain: true }); }
  if (sp.silent) return out;

  const gauss = () => Math.sqrt(-2 * Math.log(1 - sim.rnd())) * Math.cos(2 * Math.PI * sim.rnd());
  const level = Math.min(sp.level, T.sensor_height_cm - T.valid_min_cm - 1);
  // Physics: echo time = 2*true/c(T), but the firmware converts with a fixed speed, so the reported distance drifts with temperature.
  const temp = sp.temp !== undefined ? sp.temp : 28 + 3 * Math.sin(2 * Math.PI * t0 / 600), assumed = (cfg.temperature || {}).assumed_sound_mps || 343;
  let d = Math.round(((T.sensor_height_cm - level) * assumed / (331.3 + 0.606 * temp) + 0.25 * gauss()) * 10) / 10;
  const tempRead = sp.tempReading !== undefined ? sp.tempReading : Math.round((temp + 0.1 * gauss()) * 10) / 10;
  if (sp.dead) d = null;
  else if (sp.stuck && sim.lastD !== null) d = sim.lastD;
  else if (sp.glitchP) { const r = sim.rnd(); if (r < sp.glitchP / 3) d = null; else if (r < 2 * sp.glitchP / 3) d = 0; else if (r < sp.glitchP) d = Math.round(100 + sim.rnd() * 200); }
  if (d !== null && d > 0) sim.lastD = d;

  const msg = { topic: `${base}/level`, qos: 1, payload: { seq: ++sim.seq, ts: new Date(now - (sp.rf ? 1000 : 0)).toISOString(), distance_cm: d, temp_c: tempRead, transport: sp.rf ? 'rf' : 'wifi' } };
  out.push(msg);
  if (sp.rf && sim.seq % 5 === 0) out.push({ ...msg }); // RF path redelivers
  return out;
}

module.exports = { SCENARIOS, newSim, setScenario, tick };
