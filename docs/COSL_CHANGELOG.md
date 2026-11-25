# COSL Engineering Changelog & Architecture Notes

**Distribution:** Overleaf: COSL Edition for Enterprises (`codemolabs/overleaf`)  
**Upstream Base:** `overleaf/overleaf` Community Edition

This document tracks every subsystem added or modified in the COSL Enterprise distribution, how each mechanism works internally, and why design choices were made.

---

## Summary of Architecture Additions

| Component | Path(s) | Responsibility |
| :--- | :--- | :--- |
| **Package Install Hub Daemon** | `services/package-hub/`, `server-ce/runit/package-hub/run` | Internal HTTP service on port `3020` indexing TeX Live (`tlmgr`), CTAN mirrors, Starter Packs, and custom `.sty`/`.cls` uploads on `/usr/local/texlive/texmf-local` |
| **Package Hub Web Integration** | `services/web/app/src/Features/PackageHub/`, `services/web/frontend/js/features/package-hub/` | Admin/user routes under `/packages` and `/api/packages/*` with React catalog UI, Activity Log, settings, and OpenAPI schema |
| **Local Folder Sync Daemon** | `services/local-sync/`, `server-ce/runit/local-sync/run` | Host-container file watcher and HTTP sync server on port `3025` across Linux, macOS, and Windows Docker mounts |
| **3-Way Sync & OT Bridge** | `services/web/app/src/Features/LocalSync/`, `services/web/frontend/js/features/project-list/components/local-folder/` | Reconciles `.overleaf-sync.json` SHA-256 baselines with live ShareDB/DocUpdater state; supports default folder migration and per-project subfolder mapping |
| **Cloud ZIP Optimizer (< 30 MB)** | `services/web/app/src/Features/Downloads/{ProjectCloudExportManager.mjs,cloud_zip_optimize.py}`, `cloud-export-modal.tsx` | Builds minimal Overleaf.com-compatible archives by traversing `\input`/`\include`/`\includegraphics`/`\bibliography` graphs and adaptively shrinking heavy images/PDFs |
| **Enterprise Admin, Access & Branding** | `services/web/app/src/Features/{ServerAdmin,Authorization}/`, `WorkspaceBrandingService.mjs` | Unified `/admin` console, `private`/`network`/`all_users`/`custom` project sharing scopes, and live custom logo + title branding |
| **Memory Ceiling & Live OT Flush** | `scripts/tune-sharelatex-memory.sh`, `server-ce/config/env.sh`, `docker-compose.yml` | Keeps total 3-container RAM usage within `1.50 GiB` while enabling `MAX_UNFLUSHED_AGE_SECONDS=15` and `CONTINUOUS_BACKGROUND_FLUSH=true` |
| **Cross-OS Installer & Hibernation** | `scripts/install.{sh,ps1,cmd}`, `scripts/overleaf-ctl.{sh,ps1,cmd}` | Native Linux, macOS, and Windows setup and `off`/`on` (`pause`/`resume`) lifecycle with gzip + SHA-256 `mongodump`/`mongorestore` |

---

## Key Engineering Fixes & Design Decisions

### 1. Live Editor Persistence + External File Edits (No Stale Revert)
Upstream Overleaf batches OT operations inside Redis (`document-updater`) before writing back to MongoDB, which caused recent browser edits to disappear if a user refreshed or restarted quickly, or conflicted when external editors touched synced files on disk.
- Configured `MAX_UNFLUSHED_AGE_SECONDS=15` and `CONTINUOUS_BACKGROUND_FLUSH=true` so ShareDB edits persist continuously.
- Normalized baseline hashing in `@overleaf/local-sync` and `LocalProjectSyncManager.mjs` using `.overleaf-sync.json` so external edits and browser edits reconcile deterministically without ping-pong write loops or silent clobbering.

### 2. Cloud ZIP (`< 30 MB`) Smart Export for Overleaf.com Compatibility
Self-hosted local projects frequently accumulate raw uncompressed figures, build logs, scratch notes, and draft PDFs exceeding cloud limits.
- `ProjectCloudExportManager.mjs` parses the TeX dependency graph from the root document (`main.tex` fallback) and excludes unused local artifacts automatically with clear per-file reasons in the modal.
- `cloud_zip_optimize.py` runs progressive resolution + Pillow LANCZOS / OptiPNG / JPEG / QPDF passes targeting `25 MB` (or `30 MB`) while preserving exact TeX-referenced paths.
- Exposed in IDE **File -> Download** (`menu-bar.tsx`), `#project-title-options` (`project-title.tsx`), and on `/project` directly in the row Actions download bar (`actions-cell.tsx`), 3-dot dropdown (`actions-dropdown.tsx`), and selection toolbar (`project-tools.tsx`).

### 3. Streamlined Dashboard & Row Controls
- Added **Organize Tags** directly inside each single-project 3-dot row menu alongside the bulk action bar.
- Removed redundant dashboard header controls (`Packages` and redundant footer chrome on `/project`) in favor of unified left-sidebar entries (`Package Hub`, `Folder Location`).
- Interpolates custom organization title and uploaded PNG/SVG branding network-wide via `WorkspaceBrandingService`.

### 4. Cross-Platform Docker & Hibernation Lifecycle (`OFF` / `ON`)
- `docker-compose.yml` binds host project folders into container `/projects` identically across Linux (`./data/projects`), macOS (`$HOME/OverleafProjects`), and Windows (`C:\Users\...\OverleafProjects`), preventing OS path separator mismatches via `services/local-sync/path-utils.mjs`.
- `overleaf-ctl.sh` (Linux/macOS) and `overleaf-ctl.ps1` / `.cmd` (Windows, with async stderr draining on `mongodump` to prevent buffer deadlocks) prioritize standalone `docker-compose.yml` over any Toolkit install so test or workspace instances never cross-contaminate backups.
