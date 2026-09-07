#!/usr/bin/env bash
# Runs the sandbox counterparts natively beside the platform — stand-ins for the external systems that have no
# public endpoint yet, speaking the contract the platform's adapter declares, so the live path is proved over the
# network. Usage: infra/local/counterparts.sh start|stop|status [icp ...]
# Each counterpart reads its environment from .local/counterparts/<name>.env when the file exists.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL="${MARITIME_LOCAL_DIR:-$ROOT/.local}"; RUN="$LOCAL/run"; LOG="$LOCAL/log"; CONF="$LOCAL/counterparts"; mkdir -p "$RUN" "$LOG" "$CONF"
ALL=$(ls "$ROOT/tools/counterparts")
pick() { if [ $# -gt 1 ]; then shift; echo "$@"; else echo "$ALL"; fi; }
port_of() { local f="$CONF/$1.env"; local p=""; [ -f "$f" ] && p=$(grep -E "^[A-Z_]*_PORT=" "$f" | head -1 | cut -d= -f2); echo "${p:-5710}"; }
start_one() {
  local s="$1"; [ -f "$ROOT/tools/counterparts/$s/sandbox.mjs" ] || { echo "$s: no such counterpart"; return; }
  if [ -f "$RUN/counterpart-$s.pid" ] && kill -0 "$(cat "$RUN/counterpart-$s.pid")" 2>/dev/null; then echo "$s: already running"; return; fi
  local envfile="$CONF/$s.env"
  if command -v setsid >/dev/null 2>&1; then
    (cd "$ROOT/tools/counterparts/$s" && { [ -f "$envfile" ] && set -a && . "$envfile" && set +a; } ; setsid nohup node sandbox.mjs > "$LOG/counterpart-$s.log" 2>&1 < /dev/null & echo $! > "$RUN/counterpart-$s.pid")
  else
    (cd "$ROOT/tools/counterparts/$s" && { [ -f "$envfile" ] && set -a && . "$envfile" && set +a; } ; nohup node sandbox.mjs > "$LOG/counterpart-$s.log" 2>&1 < /dev/null & echo $! > "$RUN/counterpart-$s.pid")
  fi
  echo "$s: started (:$(port_of "$s"))"
}
stop_one() {
  local s="$1"
  if [ -f "$RUN/counterpart-$s.pid" ]; then kill "$(cat "$RUN/counterpart-$s.pid")" 2>/dev/null; rm -f "$RUN/counterpart-$s.pid"; echo "$s: stopped"; else echo "$s: not running"; fi
}
status_one() {
  local s="$1" p; p=$(port_of "$s")
  if curl -fs "http://127.0.0.1:$p/health" >/dev/null 2>&1; then echo "$s: up (:$p)"; else echo "$s: down (:$p)"; fi
}
cmd="${1:-status}"
for s in $(pick "$@"); do case "$cmd" in
  start) start_one "$s" ;; stop) stop_one "$s" ;; status) status_one "$s" ;;
  *) echo "usage: $0 start|stop|status [counterpart ...]" >&2; exit 2 ;;
esac; done
