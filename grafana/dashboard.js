// Grafana dashboard as code, generated from config/site.json so the threshold lines can never drift from the alert levels.
const DS = { type: 'influxdb', uid: 'flood-flux' };

module.exports = function dashboard(cfg, bucket = 'flood') {
  const base = `from(bucket: "${bucket}")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "level" and r.site == "\${site}" and r.node == "\${node}")`;
  const wide = (fields) => `${base}
  |> filter(fn: (r) => ${fields.map((f) => `r._field == "${f}"`).join(' or ')})
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> keep(columns: ["_time", ${fields.map((f) => `"${f}"`).join(', ')}])`;
  const last = (f) => `${base}
  |> filter(fn: (r) => r._field == "${f}")
  |> last()
  |> keep(columns: ["_value"])`;
  const steps = (w, c) => ({ mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: w }, { color: 'red', value: c }] });
  const target = (flux) => [{ refId: 'A', datasource: DS, query: flux }];
  const panel = (id, type, title, x, y, w, h, flux, fieldConfig = {}, options = {}) => ({ id, type, title, datasource: DS, gridPos: { x, y, w, h }, targets: target(flux), fieldConfig: { defaults: {}, overrides: [], ...fieldConfig }, options });
  const lvl = cfg.levels, rate = cfg.rates;
  const usable = cfg.tank.sensor_height_cm - cfg.tank.valid_min_cm;
  // Charts draw dots, not lines: Grafana cannot insert breaks into Flux series, and a line drawn across a silent period makes a dead sensor look calm.
  const line = { custom: { drawStyle: 'points', pointSize: 3, showPoints: 'always' } };

  // Independent of the dashboard time range: current alert state and data age must never read "no data" just because the window is short.
  const ever = (f) => `from(bucket: "${bucket}")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "level" and r.site == "\${site}" and r.node == "\${node}" and r._field == "${f}")
  |> last()`;
  const hist = (measurement, keys, cols, n) => `from(bucket: "${bucket}")
  |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "${measurement}" and r.site == "\${site}")
  |> pivot(rowKey: ["_time", ${keys.map((k) => `"${k}"`).join(', ')}], columnKey: ["_field"], valueColumn: "_value")
  |> group()
  |> keep(columns: [${cols.map((c) => `"${c}"`).join(', ')}])
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: ${n})`;
  const sevMap = [{ type: 'value', options: { 0: { text: 'NORMAL', color: 'green' }, 1: { text: 'WARNING', color: 'orange' }, 2: { text: 'CRITICAL', color: 'red' } } }];
  const viewMap = [{ type: 'value', options: { 0: { text: 'NORMAL', color: 'green' }, 1: { text: 'WARNING', color: 'orange' }, 2: { text: 'CRITICAL', color: 'red' }, 3: { text: 'SENSOR FAULT', color: 'purple' }, 4: { text: 'WARNING + SENSOR FAULT', color: 'orange' }, 5: { text: 'CRITICAL + SENSOR FAULT', color: 'red' } } }];
  const qualMap = [{ type: 'value', options: { 0: { text: 'good', color: 'green' }, 1: { text: 'suspect', color: 'orange' }, 2: { text: 'bad', color: 'red' } } }];
  const blue = { thresholds: { mode: 'absolute', steps: [{ color: 'blue', value: null }] }, color: { mode: 'thresholds' } };
  const tile = { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'background' };
  const stale = cfg.alerts.stale_after_s;

  const panels = [
    // row 1: what is happening, and can I trust it
    panel(1, 'stat', 'Alert state', 0, 0, 6, 4, ever('alert_view') + `\n  |> map(fn: (r) => ({ _value: if float(v: int(v: now())) - float(v: int(v: r._time)) > ${stale * 1e9}.0 and r._value < 3.0 then r._value + 3.0 else r._value }))`, { defaults: { mappings: viewMap, noValue: 'NO DATA', thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }] }, color: { mode: 'thresholds' } } }, tile),
    panel(2, 'stat', 'Level', 6, 0, 6, 4, last('level_f'), { defaults: { unit: 'lengthcm', decimals: 1, thresholds: steps(lvl.warning_cm, lvl.critical_cm), color: { mode: 'thresholds' } } }, tile),
    panel(3, 'stat', 'Rate of rise', 12, 0, 6, 4, last('rate_cm_min'), { defaults: { unit: 'suffix: cm/min', decimals: 2, noValue: 'no rate yet', thresholds: steps(rate.warning_cm_min, rate.critical_cm_min), color: { mode: 'thresholds' } } }, tile),
    panel(4, 'stat', 'Last reading', 18, 0, 6, 4, ever('seq') + `\n  |> map(fn: (r) => ({ _value: float(v: int(v: now())) - float(v: int(v: r._time)) }))\n  |> map(fn: (r) => ({ _value: r._value / 1000000000.0 }))`,
      { defaults: { unit: 's', decimals: 0, noValue: 'NO DATA', thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: Math.round(stale / 3) }, { color: 'red', value: stale }] }, color: { mode: 'thresholds' } } }, tile),
    // row 2
    panel(5, 'stat', 'Sensor quality', 0, 4, 6, 4, last('quality'), { defaults: { mappings: qualMap, thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }] }, color: { mode: 'thresholds' } } }, tile),
    panel(6, 'stat', 'Air temp', 6, 4, 6, 4, last('temp_c'), { defaults: { unit: 'celsius', decimals: 1, noValue: 'no reading', ...blue } }, tile),
    panel(7, 'stat', 'Node', 12, 4, 6, 4, `${base}
  |> filter(fn: (r) => r._field == "seq")
  |> last()
  |> map(fn: (r) => ({ _value: r.node + " via " + r.transport }))`, { defaults: blue }, { ...tile, reduceOptions: { calcs: ['lastNotNull'], fields: '/.*/' }, textMode: 'value' }),
    panel(18, 'stat', 'Pi hub last seen', 18, 4, 6, 4, `from(bucket: "${bucket}")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "hub" and r.site == "\${site}" and r._field == "beat")
  |> last()
  |> map(fn: (r) => ({ _value: (float(v: int(v: now())) - float(v: int(v: r._time))) / 1000000000.0 }))`,
      { defaults: { unit: 's', decimals: 0, noValue: 'NO PI SEEN', thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: Math.round(cfg.alerts.fallback.pi_dead_after_s / 3) }, { color: 'red', value: cfg.alerts.fallback.pi_dead_after_s }] }, color: { mode: 'thresholds' } } }, tile),
    // main chart
    panel(8, 'timeseries', 'Water level: raw (small dots) and filtered (yellow)', 0, 8, 24, 9, wide(['level_cm', 'level_f']), {
      defaults: { unit: 'lengthcm', custom: { drawStyle: 'points', pointSize: 4, showPoints: 'always', thresholdsStyle: { mode: 'line' } }, min: 0, max: usable, thresholds: steps(lvl.warning_cm, lvl.critical_cm) },
      overrides: [{ matcher: { id: 'byName', options: 'level_cm' }, properties: [{ id: 'custom.pointSize', value: 3 }, { id: 'color', value: { mode: 'fixed', fixedColor: 'light-blue' } }] }],
    }, { legend: { displayMode: 'list', placement: 'bottom' } }),
    panel(9, 'timeseries', 'Rate of rise (cm/min)', 0, 17, 8, 8, wide(['rate_cm_min']), { defaults: { unit: 'none', custom: { ...line.custom, thresholdsStyle: { mode: 'line' }, axisSoftMin: -1, axisSoftMax: rate.critical_cm_min + 1 }, thresholds: steps(rate.warning_cm_min, rate.critical_cm_min) } }),
    panel(10, 'timeseries', 'Temperature and its correction', 8, 17, 8, 8, wide(['temp_c', 'temp_corr_cm']), {
      defaults: { unit: 'celsius', custom: { ...line.custom } },
      overrides: [{ matcher: { id: 'byName', options: 'temp_corr_cm' }, properties: [{ id: 'unit', value: 'lengthcm' }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'decimals', value: 2 }, { id: 'color', value: { mode: 'fixed', fixedColor: 'orange' } }] }],
    }, { legend: { displayMode: 'list', placement: 'bottom' } }),
    panel(11, 'state-timeline', 'Transport (wifi / rf)', 16, 17, 8, 8, `${base}
  |> filter(fn: (r) => r._field == "seq")
  |> map(fn: (r) => ({ _time: r._time, _value: if r.transport == "rf" then 1 else 0 }))`, { defaults: { displayName: 'link', mappings: [{ type: 'value', options: { 0: { text: 'wifi', color: 'green' }, 1: { text: 'rf (fallback)', color: 'orange' } } }], custom: { fillOpacity: 70 } } }),
    // alert state over time, and sensor health over time
    panel(12, 'state-timeline', 'Alert state', 0, 25, 12, 6, wide(['alert_view']), { defaults: { displayName: 'alert', mappings: viewMap, custom: { fillOpacity: 70 } } }),
    panel(13, 'state-timeline', 'Sensor quality', 12, 25, 12, 6, wide(['quality']), { defaults: { displayName: 'quality', mappings: qualMap, custom: { fillOpacity: 70 } } }),
    // history (last 24 h, independent of the time picker)
    panel(14, 'table', 'Alerts (last 24 h, newest first)', 0, 31, 12, 8, hist('alert', ['node', 'kind', 'severity', 'source'], ['_time', 'node', 'source', 'kind', 'severity', 'state', 'level_cm', 'rate_cm_min', 'reason'], 50), { defaults: { noValue: 'No alerts in the last 24 h' } }),
    panel(15, 'table', 'Notifications (log channel, last 24 h)', 12, 31, 12, 8, hist('notification', ['node', 'kind', 'severity', 'channel'], ['_time', 'node', 'severity', 'status', 'text', 'reason'], 50), { defaults: { noValue: 'No notifications in the last 24 h' } }),
    panel(16, 'table', 'Rejected readings (by reason, in range)', 0, 39, 12, 7, `${base}
  |> filter(fn: (r) => r._field == "reject")
  |> keep(columns: ["_value"])
  |> rename(columns: {_value: "reason"})
  |> group(columns: ["reason"])
  |> reduce(identity: {count: 0}, fn: (r, accumulator) => ({count: accumulator.count + 1}))
  |> group()`, { defaults: { noValue: 'No rejected readings' } }),
    panel(17, 'table', 'Device status messages (LWT, last 24 h)', 12, 39, 12, 7, hist('node_status', ['node', 'source'], ['_time', 'node', 'source', 'online'], 20), { defaults: { noValue: 'No status messages in the last 24 h' } }),
  ];

  const order = (id, cols) => { panels.find((p) => p.id === id).transformations = [{ id: 'organize', options: { indexByName: Object.fromEntries(cols.map((c, i) => [c, i])), renameByName: { _time: 'time' } } }]; };
  order(14, ['_time', 'node', 'state', 'severity', 'kind', 'source', 'level_cm', 'rate_cm_min', 'reason']);
  order(15, ['_time', 'node', 'severity', 'status', 'text', 'reason']);

  const tagVar = (name, flux) => ({ name, label: name, type: 'query', datasource: DS, query: flux, refresh: 1, sort: 1, includeAll: false, multi: false });
  return {
    uid: 'flood-main', title: 'Flood Monitor', tags: ['flood'], timezone: 'Asia/Bangkok', refresh: '5s', schemaVersion: 39, version: 1,
    time: { from: 'now-15m', to: 'now' },
    templating: { list: [
      tagVar('site', `import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "${bucket}", tag: "site")`),
      tagVar('node', `import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "${bucket}", tag: "node", predicate: (r) => r.site == "\${site}")`),
    ] },
    panels,
  };
};
