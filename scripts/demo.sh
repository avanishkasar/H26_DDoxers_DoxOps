#!/usr/bin/env bash
# DoxOps end-to-end demo on macOS/Linux.  Usage: scripts/demo.sh [model] [max-deps, 0 = all at-risk]
set -euo pipefail
MODEL="${1:-gemma4:e4b}"
MAX_DEPS="${2:-0}"
cd "$(dirname "$0")/.."
uv python install 3.12 3.13
[ -d doxops/.venv ] || uv venv -p 3.12 doxops/.venv
VIRTUAL_ENV="$PWD/doxops/.venv" uv pip install -e ./doxops
doxops/.venv/bin/doxops doctor --model "$MODEL"
OUT="doxops-out/demo-$(date +%Y%m%d-%H%M%S)"
ARGS=(run https://github.com/rishrek/LinkWatch --model "$MODEL" --out "$OUT")
[ "$MAX_DEPS" -gt 0 ] && ARGS+=(--max-deps "$MAX_DEPS")
doxops/.venv/bin/doxops "${ARGS[@]}"
echo "Open $OUT/report.html"
