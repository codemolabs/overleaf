#!/usr/bin/env bash
set -euo pipefail

# Cross-Unix (Linux / macOS) one-step setup for Overleaf: COSL Edition for Enterprises.
# Usage:
#   ./scripts/install.sh [--projects-dir PATH] [--port PORT] [--image IMAGE]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECTS_DIR="${OVERLEAF_PROJECTS_HOST_DIR:-$HOME/OverleafProjects}"
PORT="${OVERLEAF_PORT:-80}"
IMAGE="${OVERLEAF_IMAGE_NAME:-codemolabs/overleaf:latest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --projects-dir)
      PROJECTS_DIR="${2:?Missing path for --projects-dir}"
      shift 2
      ;;
    --port)
      PORT="${2:?Missing value for --port}"
      shift 2
      ;;
    --image)
      IMAGE="${2:?Missing image name for --image}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--projects-dir PATH] [--port PORT] [--image IMAGE]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is required and the Docker daemon must be running." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: Docker Compose v2 ('docker compose') is required." >&2
  exit 1
fi

mkdir -p \
  "$ROOT_DIR/data/overleaf" \
  "$ROOT_DIR/data/mongo" \
  "$ROOT_DIR/data/redis" \
  "$ROOT_DIR/data/texlive-local" \
  "$ROOT_DIR/data/backups/hibernate" \
  "$PROJECTS_DIR/OverleafProjects"

upsert_env() {
  local file="$1"
  local key="$2"
  local val="$3"
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    python3 -c '
import sys, pathlib
p = pathlib.Path(sys.argv[1])
key, val = sys.argv[2], sys.argv[3]
lines = p.read_text(encoding="utf-8").splitlines()
out = [f"{key}={val}" if l.startswith(f"{key}=") else l for l in lines]
p.write_text("\n".join(out) + "\n", encoding="utf-8")
' "$file" "$key" "$val"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

ENV_FILE="$ROOT_DIR/.env"
upsert_env "$ENV_FILE" "OVERLEAF_IMAGE_NAME" "$IMAGE"
upsert_env "$ENV_FILE" "OVERLEAF_PORT" "$PORT"
upsert_env "$ENV_FILE" "OVERLEAF_PROJECTS_HOST_DIR" "$PROJECTS_DIR"

echo "=== Starting Overleaf: COSL Edition for Enterprises ==="
echo "  Workspace sync root : $PROJECTS_DIR"
echo "  Web URL             : http://localhost:${PORT}"
echo "  Docker image        : $IMAGE"

docker compose -f "$ROOT_DIR/docker-compose.yml" up -d
"$SCRIPT_DIR/overleaf-ctl.sh" resume

echo ""
echo "[ok] Installation complete."
echo "     Open http://localhost:${PORT} in your browser to finish /launchpad setup."
echo "     To pause cleanly (backup DB + free RAM):  $SCRIPT_DIR/overleaf-ctl.sh off"
echo "     To resume right where you left off:       $SCRIPT_DIR/overleaf-ctl.sh on"
