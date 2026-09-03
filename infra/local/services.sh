#!/usr/bin/env bash
# Runs the built services natively (no containers) for local development and drives.
# Usage: infra/local/services.sh start|stop|status|seed [service ...]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL="${MARITIME_LOCAL_DIR:-$ROOT/.local}"; RUN="$LOCAL/run"; LOG="$LOCAL/log"; mkdir -p "$RUN" "$LOG"
export EVENT_BUS="${EVENT_BUS:-nats}" NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}" AUTH_MODE="${AUTH_MODE:-local}"
ALL=$(ls "$ROOT/services")
pick() { if [ $# -gt 1 ]; then shift; echo "$@"; else echo "$ALL"; fi; }
port_of() { node -e "const s=require('$ROOT/services/$1/dist/env.js'); console.log(s.envSchema.parse({}).PORT)" 2>/dev/null; }
start_one() {
  local s="$1"; [ -f "$ROOT/services/$s/dist/main.js" ] || { echo "$s: not built"; return; }
  if [ -f "$RUN/$s.pid" ] && kill -0 "$(cat "$RUN/$s.pid")" 2>/dev/null; then echo "$s: already running"; return; fi
  # setsid detaches the service into its own session, so it survives the shell that started it
  (cd "$ROOT/services/$s" && setsid nohup node dist/main.js > "$LOG/$s.log" 2>&1 < /dev/null & echo $! > "$RUN/$s.pid")
  echo "$s: started (:$(port_of "$s"))"
}
stop_one() {
  local s="$1" p; p=$(port_of "$s")
  [ -f "$RUN/$s.pid" ] && kill "$(cat "$RUN/$s.pid")" 2>/dev/null
  # a stale pid file is common after a restart, so free the port itself as well
  [ -n "$p" ] && fuser -k "$p/tcp" 2>/dev/null
  rm -f "$RUN/$s.pid"; echo "$s: stopped"
}
status_one() {
  local s="$1" p; p=$(port_of "$s"); [ -n "$p" ] || { echo "$s: not built"; return; }
  if curl -fs "http://127.0.0.1:$p/health" >/dev/null 2>&1; then echo "$s: up (:$p)"; else echo "$s: down (:$p)"; fi
}
seed_one() { local s="$1"; [ -f "$ROOT/services/$s/dist/seed.js" ] && (cd "$ROOT/services/$s" && node dist/seed.js) || (cd "$ROOT/services/$s" && [ -f dist/migrate.js ] && node dist/migrate.js); }
cmd="${1:-status}"
for s in $(pick "$@"); do case "$cmd" in
  start) start_one "$s" ;; stop) stop_one "$s" ;; status) status_one "$s" ;; seed) seed_one "$s" ;;
  *) echo "usage: $0 start|stop|status|seed [service ...]" >&2; exit 2 ;;
esac; done
