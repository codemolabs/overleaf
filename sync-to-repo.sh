#!/usr/bin/env bash
set -euo pipefail

# Sync Overleaf: COSL Edition for Enterprises staging assets into the git repository.

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-${OVERLEAF_REPO_DIR:-}}"

if [[ -z "$REPO_DIR" ]]; then
  echo "Usage: $0 <path-to-overleaf-repo>" >&2
  exit 1
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "Error: Target directory is not a git repository: $REPO_DIR" >&2
  exit 1
fi

echo "[sync] Staging source: $STAGING_DIR"
echo "[sync] Target repo:    $REPO_DIR"

# 1. Sync top-level distribution README, Compose files, and patch tool
cp "$STAGING_DIR/README.md" "$REPO_DIR/README.md"
cp "$STAGING_DIR/docker-compose.yml" "$REPO_DIR/docker-compose.yml"
cp "$STAGING_DIR/docker-compose.cross-os.example.yml" "$REPO_DIR/docker-compose.cross-os.example.yml"
cp "$STAGING_DIR/apply-patches.mjs" "$REPO_DIR/apply-patches.mjs"
cp "$STAGING_DIR/sync-to-repo.sh" "$REPO_DIR/sync-to-repo.sh"
chmod +x "$REPO_DIR/sync-to-repo.sh"

# Remove deprecated contribution README now replaced by README.md + docs/COSL_CHANGELOG.md
rm -f "$REPO_DIR/cosl-contribution-readme.md"

# 2. Sync brand artwork, UI screenshots, and documentation
mkdir -p "$REPO_DIR/doc" "$REPO_DIR/docs"
rsync -a --delete "$STAGING_DIR/doc/" "$REPO_DIR/doc/"
rsync -a --delete "$STAGING_DIR/docs/" "$REPO_DIR/docs/"

# 3. Sync cross-OS installer, ON/OFF hibernation scripts, and container tuning scripts
mkdir -p "$REPO_DIR/scripts" "$REPO_DIR/bin/shared"
rsync -a --exclude='*.log' "$STAGING_DIR/scripts/" "$REPO_DIR/scripts/"
chmod +x "$REPO_DIR/scripts/"*.sh

if [[ -f "$STAGING_DIR/bin/shared/mongodb-init-replica-set.js" ]]; then
  cp "$STAGING_DIR/bin/shared/mongodb-init-replica-set.js" "$REPO_DIR/bin/shared/mongodb-init-replica-set.js"
fi

# 4. Sync server-ce image configuration, init hooks, and runit daemons
mkdir -p "$REPO_DIR/server-ce/config" "$REPO_DIR/server-ce/init" "$REPO_DIR/server-ce/runit/package-hub" "$REPO_DIR/server-ce/runit/local-sync"
cp "$STAGING_DIR/server-ce/Dockerfile" "$REPO_DIR/server-ce/Dockerfile"
cp "$STAGING_DIR/server-ce/config/env.sh" "$REPO_DIR/server-ce/config/env.sh"
cp "$STAGING_DIR/server-ce/init/920_bootstrap_admin.sh" "$REPO_DIR/server-ce/init/920_bootstrap_admin.sh"
cp "$STAGING_DIR/server-ce/init/bootstrap-admin.mjs" "$REPO_DIR/server-ce/init/bootstrap-admin.mjs"
cp "$STAGING_DIR/server-ce/runit/package-hub/run" "$REPO_DIR/server-ce/runit/package-hub/run"
cp "$STAGING_DIR/server-ce/runit/local-sync/run" "$REPO_DIR/server-ce/runit/local-sync/run"
chmod +x "$REPO_DIR/server-ce/init/920_bootstrap_admin.sh" \
         "$REPO_DIR/server-ce/runit/package-hub/run" \
         "$REPO_DIR/server-ce/runit/local-sync/run"

# 5. Sync COSL microservices and web customization overlay
rsync -a \
  --exclude='node_modules' \
  --exclude='.cache' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='public/js' \
  --exclude='public/stylesheets' \
  --exclude='*.log' \
  "$STAGING_DIR/services/" "$REPO_DIR/services/"

echo "[ok] Sync completed cleanly into $REPO_DIR"
