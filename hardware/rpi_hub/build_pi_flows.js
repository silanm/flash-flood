// Builds the Pi hub flows (nodered/build-pi.js) with this rig's site, mounting height and LCD refresh. Usage:
//   node hardware/rpi_hub/build_pi_flows.js   -> writes hardware/rpi_hub/pi.flows.ait.json (import it into Node-RED on the Pi)
const path = require('path'), fs = require('fs');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config/site.json'), 'utf8'));
cfg.site = 'ait';                    // ESP32 NVS site ID; keeps real data apart from the simulator's "demo"
// 2026-10-25: tripod at its lowest. 36.6 = the sensor's own temperature-corrected reading to the empty table
// (35.8 cm raw x 350.8/343 at 32.1 C; tape: 36 cm to the cone rim). Re-zero when the water jar is in place.
cfg.tank.sensor_height_cm = 36.6;
// Placeholders: 50 % / 75 % of the usable depth (36.6 - 5 cm blind margin = 31.6 cm).
cfg.levels = { warning_cm: 16, critical_cm: 24 };
// 2026-11-05: 30 s, not 90: the node sends every 2 s and RF hot standby covers WiFi gaps (stale readings show on the LCD after 30 s).
cfg.alerts.stale_after_s = 30;
// 2026-11-07: publish hub/state on every reading, not every 10 s, so the LCD level follows the water .
cfg.hub.state_refresh_s = 1;
const { buildPiFlows } = require(path.join(repo, 'nodered/build-pi.js'));
const out = path.join(__dirname, 'pi.flows.ait.json');
fs.writeFileSync(out, JSON.stringify(buildPiFlows({ cfg, env: {} }), null, 2) + '\n');
console.log('wrote ' + out + ' (site ' + cfg.site + ', sensor_height_cm ' + cfg.tank.sensor_height_cm + ', levels ' + JSON.stringify(cfg.levels) + ')');
