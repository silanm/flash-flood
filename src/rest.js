// REST view of the platform (ARCHITECTURE.md §13). Pure: auth, request validation, Flux text and row shaping for the Node-RED http endpoints.
//   GET  /api/v1/alerts?siteID=<id>&since=<iso8601>   alert history, newest first
//   POST /api/v1/sites/<siteID>/ack  {"ackBy":"name"}  acknowledge everything active at the site
// Every request needs HTTP Basic credentials for one operator account. Only the SHA-256 of the password is kept in the flow.
const SITE = /^[A-Za-z0-9_-]{1,40}$/; // a site ID is one MQTT topic level and is pasted into a Flux string: no '/', '+', '#', quotes or spaces
const BY = /^[\p{L}\p{N} ._@-]{1,64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/; // a zone is required: "2026-10-21T10:00:00" would be read in the server's zone
const LIMIT = 200;

const bad = (message, status = 400) => ({ error: { status, message } });
// InfluxDB's pivot returns "" for a string field a row does not have (found on the live container), so empty strings are dropped as well.
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

function parseBasic(header) {
  const m = /^Basic\s+(\S+)$/i.exec(header || '');
  if (!m) return null;
  const s = Buffer.from(m[1], 'base64').toString('utf8'), i = s.indexOf(':');
  return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
}
// rest = {user, sha256}; sha = a SHA-256 hex function (the Node-RED function node has no require, so the caller passes it in).
const authorized = (header, rest, sha) => { const c = parseBasic(header); return !!c && c.user === rest.user && sha(c.pass) === rest.sha256; };

function alertsQuery(q, bucket, now) {
  const site = q && q.siteID;
  if (typeof site !== 'string' || !SITE.test(site)) return bad('siteID is required: 1 to 40 letters, digits, "_" or "-"');
  let since = now - 24 * 3600e3; // the dashboard's alert table also looks back 24 h
  if (q.since !== undefined) {
    const t = typeof q.since === 'string' && ISO.test(q.since) ? Date.parse(q.since) : NaN;
    if (!Number.isFinite(t) || t > now) return bad('since must be an ISO 8601 time in the past with a zone, e.g. 2026-10-21T10:00:00Z (write + as %2B in a URL)');
    since = t;
  }
  const flux = `from(bucket: "${bucket}")
  |> range(start: ${new Date(since).toISOString()})
  |> filter(fn: (r) => r._measurement == "alert" and r.site == "${site}")
  |> pivot(rowKey: ["_time", "node", "kind", "severity", "source"], columnKey: ["_field"], valueColumn: "_value")
  |> group()
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: ${LIMIT})`;
  return { site, since, flux };
}

// Rows from the influxdb-in node (one object per pivoted row) -> the contract. Rows without a usable time are dropped.
const toAlerts = (rows) => (Array.isArray(rows) ? rows : [])
  .filter((r) => r && Number.isFinite(new Date(r._time).getTime()))
  .map((r) => clean({ alertID: r.alertID, node: r.node, kind: r.kind, severity: r.severity, state: r.state, level_cm: r.level_cm, rate_cm_min: r.rate_cm_min, source: r.source, reason: r.reason, ts: new Date(r._time).toISOString() }));

function ackRequest(params, body) {
  const site = params && params.siteID, by = body && body.ackBy;
  if (typeof site !== 'string' || !SITE.test(site)) return bad('siteID must be 1 to 40 letters, digits, "_" or "-"');
  if (typeof by !== 'string' || !BY.test(by)) return bad('body must be {"ackBy": "<name>"}, 1 to 64 letters, digits, spaces or . _ @ -');
  return { site, by };
}

module.exports = { authorized, alertsQuery, toAlerts, ackRequest, parseBasic };
