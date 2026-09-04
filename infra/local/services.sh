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
  # Detach so the service outlives the shell that started it. setsid is util-linux and is
  # absent on macOS, so fall back to plain nohup there — the subshell exits immediately and
  # the process is reparented, which achieves the same thing.
  if command -v setsid >/dev/null 2>&1; then
    (cd "$ROOT/services/$s" && setsid nohup node dist/main.js > "$LOG/$s.log" 2>&1 < /dev/null & echo $! > "$RUN/$s.pid")
  else
    (cd "$ROOT/services/$s" && nohup node dist/main.js > "$LOG/$s.log" 2>&1 < /dev/null & echo $! > "$RUN/$s.pid")
  fi
  echo "$s: started (:$(port_of "$s"))"
}
# Free a TCP port whatever the platform: fuser is util-linux, lsof is what macOS has.
kill_port() {
  local port="$1"; [ -n "$port" ] || return 0
  if command -v fuser >/dev/null 2>&1 && fuser -V >/dev/null 2>&1; then
    fuser -k "$port/tcp" >/dev/null 2>&1
  elif command -v lsof >/dev/null 2>&1; then
    local pids; pids=$(lsof -ti "tcp:$port" 2>/dev/null)
    [ -n "$pids" ] && kill $pids 2>/dev/null
  fi
  return 0
}
stop_one() {
  local s="$1" p; p=$(port_of "$s")
  [ -f "$RUN/$s.pid" ] && kill "$(cat "$RUN/$s.pid")" 2>/dev/null
  # a stale pid file is common after a restart, so free the port itself as well
  [ -n "$p" ] && kill_port "$p"
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
