# Figures

Standalone SVG diagrams (open in a browser, Inkscape or Word; they carry their own colours). **Drafts for the report**: the course guide asks for hand-drawn
versions of the architecture figure, so treat these as the content to redraw, not as final art.

| File | Shows |
|---|---|
| `fig-c-system-architecture.svg` | the whole system: sensor node, WiFi and radio links, the Raspberry Pi (edge) and the Proxmox container (historian), and what reaches the officer |
| `fig-a-path-of-one-reading.svg` | one reading's path: sensor, Mosquitto, Node-RED, InfluxDB, Grafana, and what the data looks like at each step |
| `fig-b-node-red-processing.svg` | what Node-RED does to one reading: check, temperature correction, plausibility checks, smoothing and rate, write |

The older JPEG figures from the interim report are unchanged in this folder.
