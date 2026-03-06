# GHosting Daemon

Game server node daemon for GHosting. Manages Docker containers, collects metrics, streams console logs, and handles file/backup operations on the host machine.

## Features

- **Docker Management** — Create, start, stop, restart, kill, and delete game server containers
- **System Metrics** — CPU, RAM, disk, and network monitoring (node-level + per-container)
- **Console (SSE)** — Real-time container log streaming via Server-Sent Events
- **File Manager** — List, read, write, upload, download, create, and delete files inside containers
- **Backup & Restore** — Create `.tar.gz` backups and restore with one click
- **TCP Proxy** — Route player traffic to isolated containers without exposing Docker ports
- **FRP Tunneling** — Optional Fast Reverse Proxy support for NAT traversal
- **WebSocket Heartbeat** — Maintains persistent connection with the central API

## Quick Start

### Prerequisites

- Node.js 20+
- Docker Engine installed and running
- Access to Docker socket (`/var/run/docker.sock`)

### Run with Docker

```bash
# From the project root (GHosting/)
docker compose up -d daemon
```

### Run Locally (Development)

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings

# Start with auto-reload
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DAEMON_ID` | `daemon-01` | Unique daemon identifier |
| `NODE_NAME` | `SG-1` | Display name for this node |
| `API_ENDPOINT` | `http://localhost:3000` | Central API URL |
| `WS_ENDPOINT` | `ws://localhost:3000` | Central API WebSocket URL |
| `DAEMON_AUTH_TOKEN` | `ghd_dev_token` | Auth token (must match Node config in web panel) |
| `DAEMON_PORT` | `8443` | HTTP API listen port |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `DATA_DIR` | `/opt/ghosting/data` | Server data storage directory |
| `CONTAINER_PREFIX` | `gs-` | Docker container name prefix |
| `HEARTBEAT_INTERVAL` | `30000` | Heartbeat interval (ms) |
| `METRICS_INTERVAL` | `10000` | Metrics collection interval (ms) |
| `FRP_ENABLED` | `false` | Enable FRP tunneling |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Node health + metrics |
| `GET` | `/api/servers` | List managed containers |
| `POST` | `/api/servers` | Create a new server |
| `DELETE` | `/api/servers/:id` | Delete a server |
| `POST` | `/api/servers/:id/power` | Power action (start/stop/restart/kill) |
| `GET` | `/api/servers/:id/stats` | Container resource stats |
| `GET` | `/api/servers/:id/console/stream` | SSE log stream |
| `POST` | `/api/servers/:id/console/input` | Send command to server stdin |
| `GET` | `/api/servers/:id/files` | List files |
| `GET` | `/api/servers/:id/files/content` | Read file content |
| `PUT` | `/api/servers/:id/files/content` | Write file content |
| `POST` | `/api/servers/:id/files/upload` | Upload files |
| `GET` | `/api/servers/:id/files/download` | Download a file |
| `GET` | `/api/servers/:id/backups` | List backups |
| `POST` | `/api/servers/:id/backups` | Create backup |
| `DELETE` | `/api/servers/:id/backups/:file` | Delete backup |
| `POST` | `/api/servers/:id/backups/:file/restore` | Restore backup |
| `GET` | `/api/metrics` | All server metrics |

## Architecture

```
┌─────────────┐      WebSocket       ┌──────────────┐
│  GHosting   │◄─────────────────────│   Daemon     │
│  Web Panel  │      HTTP API        │   (this)     │
└─────────────┘─────────────────────►│              │
                                     │  ┌─────────┐ │
                                     │  │ Docker  │ │
                                     │  │ Engine  │ │
                                     │  └─────────┘ │
                                     └──────────────┘
```
