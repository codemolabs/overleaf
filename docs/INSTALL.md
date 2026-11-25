# Installation & Cross-OS Operations Guide

This guide covers installing, running, updating, and hibernating **Overleaf: COSL Edition for Enterprises** across Linux, macOS, and Windows Docker hosts.

---

## Prerequisites

| Requirement | Minimum Recommended |
| :--- | :--- |
| **Container Engine** | Docker Engine + Compose v2 (Linux), Docker Desktop 4.x+ (macOS / Windows WSL2) |
| **Host RAM** | 2 GiB free RAM (full stack runs within `1.50 GiB` total container limit) |
| **Disk Space** | 6 GiB for container image + project storage and `texmf-local` packages |
| **Shell Tooling** | Bash + cURL (Linux/macOS) or PowerShell 5.1+ / 7+ (Windows) |

---

## 1. Quick Standalone Installation

### Linux & macOS

```bash
git clone https://github.com/codemolabs/overleaf.git
cd overleaf
chmod +x scripts/*.sh
./scripts/install.sh
```

Useful installer flags:

| Flag | Default | Description |
| :--- | :--- | :--- |
| `--port` | `80` | Host HTTP port mapped to container port `80` |
| `--listen` | `127.0.0.1` | Host bind IP (`0.0.0.0` exposes to local lab/office LAN) |
| `--projects-dir` | `./data/projects` | Host directory bind-mounted to `/projects` inside the container |
| `--app-name` | `Overleaf: COSL Edition for Enterprises` | Initial page title & system branding name |
| `--image` | `codemolabs/overleaf:latest` | Prebuilt image tag or custom local build tag |
| `--no-start` | `false` | Write `.env` and initialize directories without starting containers |

Example binding LAN access on port `8080` synced to `/home/user/ResearchProjects`:

```bash
./scripts/install.sh \
  --listen 0.0.0.0 \
  --port 8080 \
  --projects-dir /home/user/ResearchProjects
```

### Windows (PowerShell / Command Prompt)

Open PowerShell inside the cloned repository and run:

```powershell
.\scripts\install.ps1
```

Or specify a Windows host folder (automatically translated safely for Docker Desktop bind mounts):

```powershell
.\scripts\install.ps1 -ProjectsDir "C:\Users\researcher\OverleafProjects" -Port 8080 -ListenIp "127.0.0.1"
```

From `cmd.exe`:

```bat
scripts\install.cmd -ProjectsDir "C:\Users\researcher\OverleafProjects" -Port 8080
```

> **Windows Path Tip**: Never pass host paths directly inside container UI modals. Always choose paths inside `/projects` in the web modal (e.g., `/projects/OverleafProjects/Paper2026`); the container mount maps `/projects` directly to your chosen Windows directory (`C:\Users\researcher\OverleafProjects`).

---

## 2. First-Time Workspace Setup

Once the installer reports Overleaf is online:

1. Open `http://localhost/launchpad` (or `http://localhost:<PORT>/launchpad`).
2. Create the initial Administrator account.
3. Sign in to reach `/project`, verify **Folder Location** points to `/projects/OverleafProjects`, and open `/admin` or `/packages` to customize branding or install TeX packages.

For automated headless provisioning on fresh deployments, set these environment variables in `.env` or `docker-compose.yml` before first boot:

```env
OVERLEAF_ADMIN_EMAIL=admin@example.org
OVERLEAF_ADMIN_PASSWORD=replace-with-strong-password
OVERLEAF_ADMIN_NAME=Workspace Admin
OVERLEAF_ADMIN_INSTITUTION=COSL Research Lab
```

---

## 3. Daily ON / OFF Lifecycle (Hibernation & Recovery)

Because Docker containers reserve runtime RAM while idle, you can power down Overleaf safely whenever switching workloads and bring everything back identically.

### What `off` (`pause`) Does

1. Gracefully stops `sharelatex` first so active ShareDB/OT buffers flush cleanly to MongoDB.
2. Records collection document counts (`users`, `projects`, `docs`, `workspaceSettings`).
3. Streams a compressed `mongodump` archive to `data/backups/hibernate/latest.archive.gz`, verifies gzip integrity, and writes a `.sha256` checksum and `latest-state.json` manifest.
4. Triggers Redis `BGSAVE` cleanly and stops `redis` and `mongo`, dropping container RAM usage to `0 MiB`.

### What `on` (`resume`) Does

1. Starts `mongo` and `redis` and waits for replica set / Mongo readiness.
2. Checks live database collections against `latest-state.json`. If you wiped or migrated the DB directory, automatically restores from `latest.archive.gz` (or pass `--restore` / `-Restore` to force restore from the latest hibernate snapshot).
3. Starts `sharelatex`, reconciles local folder sync state, and waits until `/status` responds healthy.

### Cross-OS CLI Reference

| Action | Linux / macOS (`bash`) | Windows PowerShell | Windows `cmd.exe` |
| :--- | :--- | :--- | :--- |
| **Power Off + Backup** | `./scripts/overleaf-ctl.sh off` | `.\scripts\overleaf-ctl.ps1 off` | `scripts\overleaf-ctl.cmd off` |
| **Resume Online** | `./scripts/overleaf-ctl.sh on` | `.\scripts\overleaf-ctl.ps1 on` | `scripts\overleaf-ctl.cmd on` |
| **Force DB Restore + On** | `./scripts/overleaf-ctl.sh on --restore` | `.\scripts\overleaf-ctl.ps1 on -Restore` | `scripts\overleaf-ctl.cmd on -Restore` |
| **Backup Without Stopping** | `./scripts/overleaf-ctl.sh backup` | `.\scripts\overleaf-ctl.ps1 backup` | `scripts\overleaf-ctl.cmd backup` |
| **Inspect Status & Last Snapshot** | `./scripts/overleaf-ctl.sh status` | `.\scripts\overleaf-ctl.ps1 status` | `scripts\overleaf-ctl.cmd status` |

---

## 4. Overleaf Toolkit Integration

If you already operate upstream `overleaf-toolkit` (for example under `/home/user/overleaf-toolkit`):

1. Copy `scripts/overleaf-ctl.sh` (and `.ps1`/`.cmd` on Windows) into `/home/user/overleaf-toolkit/bin/`.
2. Copy `docker-compose.cross-os.example.yml` to `/home/user/overleaf-toolkit/config/docker-compose.override.yml`.
3. Set `IMAGE=codemolabs/overleaf:latest` (or your custom tag) in `config/overleaf.rc`.
4. Control hibernation directly via `/home/user/overleaf-toolkit/bin/overleaf-ctl.sh off` and `/home/user/overleaf-toolkit/bin/overleaf-ctl.sh on`.
