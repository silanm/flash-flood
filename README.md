# Flash-Flood Early Warning: an Edge-Cloud IoT Platform

A low-cost water-level monitor for canals in Thai farmland. A sensor node measures the water level. A Raspberry Pi next to the canal decides if a flood is near and sounds an alarm. A server stores the data and shows a dashboard. The alarm still works when WiFi or the server link is down.

This is the capstone project for AST01.41, Fundamentals of Internet of Things and Cloud Computing, at the Asian Institute of Technology.

## How it works

The decision happens at the edge, next to the canal. The server is not on the critical path.

```mermaid
flowchart TB
  subgraph Field["Field (edge)"]
    S["ESP32 + HC-SR04<br/>water-level sensor"]
    P["Raspberry Pi gateway<br/>decides and sounds the alarm"]
    A["Buzzer, LED and LCD"]
  end
  subgraph Lab["Proxmox container (platform)"]
    M["Mosquitto<br/>MQTT broker"] --> N["Node-RED<br/>filter and alerts"] --> I["InfluxDB<br/>storage"] --> G["Grafana<br/>dashboard"]
  end
  S -->|"WiFi + MQTT"| P
  S -.->|"nRF24L01 radio if WiFi fails"| P
  P --> A
  P -->|"bridge, when the link is up"| M
  N -.->|"fallback alert if the Pi is silent"| O["Officer"]
  G --> O
```

Two failures do not stop the alarm:
- **WiFi fails.** The sensor node switches to a separate radio link to the Pi.
- **The link to the server fails.** The Pi decides and sounds the alarm alone.

## One reading, from sensor to dashboard

```mermaid
sequenceDiagram
  participant S as Sensor node
  participant P as Pi gateway
  participant C as Container
  participant D as Dashboard
  S->>P: water level reading (MQTT, every 2 s)
  P->>P: filter the reading, calculate the rate of rise
  alt level or rate is over a threshold
    P->>P: sound the buzzer, set the LED and LCD
    P->>C: alert message (when the link is up)
  end
  P->>C: reading and heartbeat (bridge)
  C->>C: filter, store with a verdict, run a copy of the alert logic
  C->>D: Grafana shows level, rate and alerts
  Note over P,C: If the Pi is silent for 90 s, the container raises the alert itself
```

## Alert states

Each sensor node has one flood state. A dead sensor never changes it. The platform reports a dead sensor as a separate fault.

```mermaid
stateDiagram-v2
  [*] --> NORMAL
  NORMAL --> WARNING: 3 readings over a warning threshold
  WARNING --> CRITICAL: 3 readings over a critical threshold
  CRITICAL --> WARNING: 30 s clearly below
  WARNING --> NORMAL: 30 s clearly below
  note right of WARNING: A sensor fault never changes this state
```

A warning threshold exists for the water level and for the rate of rise. A fast rise therefore warns you before the level is high.

## Quick start

You need Node.js 20 or later. You do not need hardware, because a built-in simulator sends realistic data.

```bash
git clone https://github.com/silanm/flash-flood.git
cd flash-flood
npm test                   # 73 tests, no network and no install needed
cp .env.example .env       # enter the details of your Node-RED, InfluxDB and Grafana
node scripts/deploy.mjs    # installs the flows and the dashboard, then starts the simulator
```

`deploy.mjs` needs a running Node-RED 4 or later, InfluxDB 2.x, Grafana and an MQTT broker. [The operating manual](docs/OPERATING.md) lists the steps and the settings.

## Status

| Part | State |
|---|---|
| Server side: filtering, alerts, fallback, dashboard, REST endpoints | Built and tested. It runs on a lab container with simulated data. |
| Pi gateway flows (edge and cloud-only modes) | Built and tested on a fake clock. They never ran on a real Pi. |
| ESP32 firmware, nRF24L01 failover, buzzer, LED and LCD drivers | Not in this repo. The equipment owner builds them. |
| Real sensor data, benchmarks, power measurements | Not done yet. |

## Read next

| I want to | Read |
|---|---|
| Run, configure or troubleshoot the platform | [docs/OPERATING.md](docs/OPERATING.md) |
| Understand the design and the decisions | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Set up the Raspberry Pi | [docs/PI_SETUP.md](docs/PI_SETUP.md) |
| See what we built, what we tested and what remains | [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md) |
| See the raw test data and dashboard screenshots | [docs/evidence/README.md](docs/evidence/README.md) |

## Repository layout

```
src/        the logic: pipeline, alerts, REST, Pi hub, simulator (pure functions, tested)
test/       73 unit and scenario tests
nodered/    builds the Node-RED flows, including nodered/pi.flows.json for the Pi
grafana/    the dashboard as code
scripts/    deploy script and broker security scripts
mosquitto/  broker topic rules and a Pi bridge template
config/     site.json holds every number that you can tune
docs/       manual, Pi setup, build log, evidence and figures
```
