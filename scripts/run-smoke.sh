#!/usr/bin/env bash
# Uso: scripts/run-smoke.sh scripts/smoke-part-update.ts
# Levanta un server opencode aislado (--pure: sin plugins ni auth) y corre un
# smoke contra él. Cada smoke crea y borra sus propias sesiones; no toca
# sesiones reales. PORT y LOG se pueden pasar por entorno.
set -euo pipefail

SMOKE="${1:?uso: run-smoke.sh <ruta-al-smoke.ts>}"
PORT="${PORT:-4711}"
LOG="${LOG:-/tmp/opencode/distill-smoke-server.log}"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "puerto $PORT ocupado; elegí otro con PORT=..." >&2
  exit 1
fi

opencode serve --hostname 127.0.0.1 --port "$PORT" --pure >"$LOG" 2>&1 &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 100); do
  grep -q "listening" "$LOG" 2>/dev/null && break
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "el server murió:" >&2
    sed -n '1,40p' "$LOG" >&2
    exit 1
  fi
  sleep 0.2
done

OPENCODE_URL="http://127.0.0.1:$PORT" bun run "$SMOKE"
