# Figures

These are standalone SVG diagrams. Open them in a browser, Inkscape or Word. They carry their own colors. **They are drafts for the report.** The course guide asks for hand-drawn versions of the architecture figure. Treat these diagrams as the content to redraw, not as final art.

| File | Shows |
|---|---|
| `fig-c-system-architecture.svg` | The whole system: the sensor node, the WiFi and radio links, the Raspberry Pi (edge), the Proxmox container (historian) and what reaches the officer. |
| `fig-a-path-of-one-reading.svg` | The path of one reading: the sensor, Mosquitto, Node-RED, InfluxDB and Grafana, and what the data looks like at each step. |
| `fig-b-node-red-processing.svg` | What Node-RED does to one reading: the check, the temperature correction, the plausibility checks, the smoothing and the rate, and the write. |

This folder also holds the older JPEG figures from the interim report. We did not change them.
