# Enterprise Community Edition Capabilities

This document details every feature built into **Overleaf: COSL Edition for Enterprises**, its configuration knobs, and its UI/API integration points.

---

## 1. Local Hosted LaTeX Package Hub (`/packages`)

Instead of rebuilding Docker images whenever a paper requires a new TeX style file, the integrated `@overleaf/package-hub` daemon (listening internally on port `3020` and proxied at `/api/packages/*`) manages TeX Live, CTAN, Starter Packs, and custom uploads on a persistent `/usr/local/texlive/texmf-local` volume.

- **Web UI**: Accessible from the left project sidebar (`Package Hub`), Admin Console shortcut, or `/packages`.
- **Sources Supported**:
  - Official TeX Live catalog (`tlmgr`) with live search and status chips (`All`, `Installed`, `Not Installed`, `Updates Available`, `Custom`, `Bundles`).
  - Automatic CTAN mirror fallback when a requested package is missing or held back in the frozen TeX Live release.
  - Custom `.sty`, `.cls`, `.bst`, and `.zip` package upload & collision validation.
  - One-click multi-package Starter Packs (e.g., IEEE/ACM Paper Bundle, Beamer Presentations, Chemistry & Physics).
- **OpenAPI Spec**: Live schema available at `/api/packages/docs`.

---

## 2. Bidirectional Host Folder Sync & 15s OT Flush (`@overleaf/local-sync`)

Upstream Overleaf stores document text exclusively inside MongoDB + ShareDB Redis buffers until periodic flushes occur, and offers no native filesystem mirror. COSL solves both problems together:

1. **Tuned Live OT Persistence**: `tune-sharelatex-memory.sh` and `docker-compose.yml` enforce `MAX_UNFLUSHED_AGE_SECONDS=15` and `CONTINUOUS_BACKGROUND_FLUSH=true` in `document-updater`. Edits typed in the browser CodeMirror editor flush safely into MongoDB continuously so page refreshes never snap back to stale revisions.
2. **Bidirectional Three-Way Reconciliation Engine**: `@overleaf/local-sync` (port `3025`) tracks content digests inside `.overleaf-sync.json` per project directory:
   - **External Editor -> Overleaf IDE**: Saving `.tex`, `.bib`, `.cls`, `.sty`, or image assets in VS Code, Cursor, Neovim, or Obsidian on Linux, macOS, or Windows pushes updates through `LocalProjectSyncManager.mjs` directly into live ShareDB/DocUpdater and notifies active browser sessions cleanly.
   - **Overleaf IDE -> Host Folder**: Browser OT edits sync cleanly back to disk without clobbering concurrent external changes.
   - **Conflict-Free Deletes & Binary Hashing**: Unchanged identical files skip redundant writes; true two-sided edits generate preserved conflict copies rather than silently overwriting work.

See **[docs/LOCAL_FOLDER_SYNC.md](LOCAL_FOLDER_SYNC.md)** for protocol and path details.

---

## 3. Custom Project Folder Allocation & Connected DB Workflows

- **Global Default Folder (`Folder Location`)**: Set any host-mapped path under `/projects` (for example `/projects/OverleafProjects` or `/projects/Thesis2026`) via the native directory browser modal on `/project`. Optionally migrate existing projects into the new base directory in one click.
- **Per-Project Mapping**: Click the 3-dot row menu on any project -> `Folder location` (or `Sync to local folder`) to allocate a specific subfolder such as `/projects/ResearchPapers/VisionPaper2026`.
- **DB Integrity Preserved**: Changing host folder allocation updates `localSync` path metadata on the project record without re-creating project IDs, ShareDB rooms, tags, collaborators, or compile history snapshots.

---

## 4. Cloud ZIP (`< 30 MB`) Export Optimizer

Local research workspaces often contain 40+ MB of uncompressed matplotlib/Illustrator diagrams, backup draft PDFs, scratch scripts, and unreferenced files that exceed Overleaf.com upload caps.

- **IDE Toolbar**: Click the project title dropdown (`#project-title-options`) -> **Download for Cloud (< 30 MB)**.
- **Dashboard Row Menu**: Click the 3-dot actions button (`...`) on any project -> **Download for Cloud (< 30 MB)**.
- **Three-Stage Pipeline (`ProjectCloudExportManager.mjs` + `cloud_zip_optimize.py`)**:
  1. Parses the root document (`main.tex`) recursively across `\input`, `\include`, `\bibliography`, `\includegraphics`, `\documentclass`, and `\usepackage` references so only required project artifacts are kept; draft PDFs (`.pdf` outputs not referenced as figures), scripts, build artifacts, and unused `.tex` files are listed under **Excluded local files**.
  2. Runs multi-tier media optimization (Pillow LANCZOS downscaling from `2200px` down to `760px` with lossless/palette `optipng` + progressive JPEG re-encoding + lossless `qpdf` stream compaction) targeting **25 MB (Recommended)** or **30 MB (Overleaf limit)**.
  3. Presents before/after byte savings, compressed asset breakdowns, excluded file reasons, and a temporary tokenized download endpoint.

---

## 5. Enterprise Admin Console, Network Sharing, Branding & Organize Tags

- **System Admin Console (`/admin`)**:
  - **Overview & Health**: Live status pills and response latencies for MongoDB, Redis, Local Folder Sync, Package Hub, and LaTeX Editor gate (`Open`/`Maintenance`).
  - **Users**: Instant creation, password resets, admin elevation, suspension, and deletion.
  - **Shared Projects & Network Access (`ProjectAccessPolicyService`)**: Share projects across `private`, `network` (IP/CIDR rules + auto-join on LAN requests), `all_users`, or `custom` role/institution/email filters (`viewer`, `readOnly`, `readAndWrite`).
  - **Settings & Maintenance**: Editor access toggle, disconnect-all broadcast, global system announcement banners, and **Organization Branding (`WorkspaceBrandingService`)** to replace the logo and header brand text workspace-wide.
- **Organize Tags Everywhere**: Available in both the **Bulk Selection Toolbar** when checking one or more projects and directly inside each **Single-Project 3-Dot Action Menu**.

---

## 6. Tuned 1.50 GiB Total RAM Budget

Every container carries strict Compose memory ceilings so Overleaf never starves host IDEs, browsers, or ML jobs:

| Container | `mem_limit` | Tuned Runtime Mechanism |
| :--- | :--- | :--- |
| `sharelatex` | `1184 MiB` | `scripts/tune-sharelatex-memory.sh` sets compact V8 `--max-old-space-size` caps (`web: 320m`, `document-updater: 256m`, `clsi: 192m`, `real-time: 128m`), skips optional telemetry/clutter services cleanly, and keeps worker concurrency bounded |
| `mongo` | `288 MiB` | `--wiredTigerCacheSizeGB 0.25` keeps WiredTiger cache compact while retaining replica set indexing |
| `redis` | `64 MiB` | `--maxmemory 48mb --appendonly yes` persists OT/session queues within 64 MiB ceiling |
| **Total Ceiling** | **`1536 MiB` (`1.50 GiB`)** | Observed active steady state stays around `0.70 - 1.15 GiB` |
