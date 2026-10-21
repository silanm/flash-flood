// HC-SR04 signal conditioning. Pure: state in, state out, no I/O. Stages are described in ARCHITECTURE.md §6.
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mad = (a, med) => median(a.map((x) => Math.abs(x - med)));

const newState = () => ({ seen: [], lastSeq: null, win: [], pend: [], hist: [], recent: [], same: 0, lastD: null, lastAccT: null, lastTemp: null });

// Least-squares slope in cm/min over hist [{t(s), v}], or null if too little data to be meaningful.
function slope(hist, minSpanS) {
  if (hist.length < 5 || hist[hist.length - 1].t - hist[0].t < minSpanS) return null; // short spans give a noisy slope (~0.6 cm/min at 20 s)
  const n = hist.length, mt = hist.reduce((s, p) => s + p.t, 0) / n, mv = hist.reduce((s, p) => s + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of hist) { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) ** 2; }
  return den ? (num / den) * 60 : null;
}

// msg: {seq, ts, distance_cm|null, transport}. Returns {st, out}; out is {drop} or {ts, tags, fields}.
function step(st, msg, cfg, now) {
  const { tank: T, filter: F } = cfg;
  if (!msg || !Number.isFinite(msg.seq) || !(msg.distance_cm === null || Number.isFinite(msg.distance_cm))) return { st, out: { drop: 'schema' } };

  // duplicate (QoS 1 redelivery) vs node restart (seq jumps backwards far)
  if (st.lastSeq !== null) {
    if (st.seen.includes(msg.seq) && st.lastSeq - msg.seq <= 5) return { st, out: { drop: 'dup' } };
    if (msg.seq < st.lastSeq - 5) { st.seen = []; st.lastSeq = null; }
  }
  const gap = st.lastSeq !== null && msg.seq > st.lastSeq + 1 ? msg.seq - st.lastSeq - 1 : 0;
  st.seen.push(msg.seq); if (st.seen.length > 64) st.seen.shift();
  if (st.lastSeq === null || msg.seq > st.lastSeq) st.lastSeq = msg.seq;

  // a node with a wrong clock must not write into the past
  let t = typeof msg.ts === 'number' ? msg.ts : Date.parse(msg.ts);
  if (!Number.isFinite(t) || Math.abs(t - now) > F.ts_skew_s * 1000) t = now;

  const d = msg.distance_cm;
  // Air temperature: the firmware assumes a fixed speed of sound, so true distance = reported * c(T) / assumed (c = 331.3 + 0.606 T m/s).
  const TC = cfg.temperature || { enabled: false };
  let tc = null, tempFresh = false;
  if (TC.enabled) {
    if (Number.isFinite(msg.temp_c) && msg.temp_c >= TC.valid_min_c && msg.temp_c <= TC.valid_max_c) { tc = msg.temp_c; tempFresh = true; st.lastTemp = { v: tc, t }; } // gate also rejects DS18B20 error codes (-127, 85)
    else if (st.lastTemp && t - st.lastTemp.t <= TC.hold_s * 1000) tc = st.lastTemp.v; // temperature drifts slowly: hold the last good value through a short outage
  }
  let reject = null, level = null, dc = null;
  if (d === null) reject = 'timeout';
  else if (d < T.valid_min_cm || d > T.valid_max_cm) reject = 'range';
  else {
    dc = tc === null ? d : d * (331.3 + 0.606 * tc) / TC.assumed_sound_mps;
    level = T.sensor_height_cm - dc;
    st.same = d === st.lastD ? st.same + 1 : 1; st.lastD = d;
    if (st.same >= F.stuck_n) reject = 'stuck';
    else if (st.win.length >= 3) {
      const med = median(st.win), thr = Math.max(F.hampel_k * 1.4826 * mad(st.win, med), F.min_step_cm);
      const dtMin = Math.max((t - st.lastAccT) / 60000, 1 / 60);
      if (Math.abs(level - med) > thr && Math.abs(level - med) / dtMin > F.max_rate_cm_min) {
        st.pend.push(level); if (st.pend.length > F.confirm_n) st.pend.shift(); // only the latest confirm_n must agree
        // a sustained shift is a real step, not a spike
        if (st.pend.length >= F.confirm_n && Math.max(...st.pend) - Math.min(...st.pend) <= F.min_step_cm) { st.win = st.pend.slice(); st.pend = []; }
        else reject = 'spike';
      } else st.pend = [];
    }
  }

  st.recent.push({ t, bad: reject !== null }); while (st.recent.length && t - st.recent[0].t > 60000) st.recent.shift();
  const ratio = st.recent.filter((r) => r.bad).length / st.recent.length;
  const quality = ratio > F.invalid_bad ? 2 : ratio > F.invalid_suspect || st.same >= F.stuck_n ? 1 : 0;

  const fields = { valid: reject === null, seq: msg.seq, quality, latency_ms: now - t };
  if (d !== null) fields.distance_cm = d;
  if (gap) fields.seq_gap = gap;
  if (level !== null) fields.level_cm = level;
  if (TC.enabled) { fields.temp_ok = tempFresh; if (tempFresh) fields.temp_c = tc; if (dc !== null && tc !== null) fields.temp_corr_cm = dc - d; }
  if (reject) fields.reject = reject;
  else {
    st.win.push(level); if (st.win.length > F.median_n) st.win.shift();
    st.lastAccT = t;
    fields.level_f = median(st.win);
    // The median turns a step into one jump of full size; real rises move ~0.1 cm per sample. A jump is a step, not a rise: drop the old slope.
    if (st.hist.length && Math.abs(fields.level_f - st.hist.at(-1).v) > F.min_step_cm) st.hist = [];
    st.hist.push({ t: t / 1000, v: fields.level_f }); while (st.hist.length && t / 1000 - st.hist[0].t > F.rate_window_s) st.hist.shift();
    const r = slope(st.hist, F.rate_min_span_s); if (r !== null) fields.rate_cm_min = r;
  }
  return { st, out: { ts: t, tags: { transport: msg.transport === 'rf' || msg.transport === 'wifi' ? msg.transport : 'unknown' }, fields } };
}

module.exports = { newState, step, median, slope };
