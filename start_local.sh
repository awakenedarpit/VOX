#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Load local provider credentials without committing them to Git.
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
BACKEND_DIR="$ROOT_DIR/backend"
VENV="$BACKEND_DIR/.venv"

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install -r "$BACKEND_DIR/requirements.txt"
fi

cd "$BACKEND_DIR"
exec "$VENV/bin/python" -m uvicorn main:app --host "${VOX_HOST:-0.0.0.0}" --port "${VOX_PORT:-8000}"
