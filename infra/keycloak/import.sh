#!/usr/bin/env bash
# Imports the `maritime` realm (infra/keycloak/realm-maritime.json) into a running Keycloak with
# kcadm.sh and proves the web client's password grant works. Idempotent: an existing realm is left
# untouched unless --reset is passed, in which case it is deleted and recreated.
#
# Usage: infra/keycloak/import.sh [--reset] [--no-verify]
# Environment (all optional):
#   KC_URL                     Keycloak base URL                     default http://127.0.0.1:8180
#   KC_ADMIN, KC_ADMIN_PASSWORD bootstrap admin of the master realm  default admin / admin
#   KC_HOME                    Keycloak distribution with bin/kcadm.sh (auto-detected under .local/keycloak-*)
#   KC_GATEWAY_CLIENT_SECRET   secret of the confidential `gateway` client (default: development value)
#   DEMO_PASSWORD              password used by the token-grant verification (default: the demo password)
# Placeholders of the form ${NAME:default} in the realm file are resolved from the environment before the
# realm is posted; Keycloak resolves the same placeholders itself when it imports the file at startup
# (--import-realm), which is how infra/compose/docker-compose.yml loads it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REALM_FILE="$ROOT/infra/keycloak/realm-maritime.json"
REALM="maritime"
KC_URL="${KC_URL:-http://127.0.0.1:8180}"
KC_ADMIN="${KC_ADMIN:-admin}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-admin}"
LOCAL="${MARITIME_LOCAL_DIR:-$ROOT/.local}"
KC_HOME="${KC_HOME:-$(ls -d "$LOCAL"/keycloak-* 2>/dev/null | head -1 || true)}"
RESET=false; VERIFY=true
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=true ;;
    --no-verify) VERIFY=false ;;
    *) echo "usage: $0 [--reset] [--no-verify]" >&2; exit 2 ;;
  esac
done
[ -n "$KC_HOME" ] && [ -x "$KC_HOME/bin/kcadm.sh" ] || { echo "kcadm.sh not found under $LOCAL; set KC_HOME" >&2; exit 1; }
[ -f "$REALM_FILE" ] || { echo "realm file missing: $REALM_FILE" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required to render placeholders" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [ -n "${KCADM_JAVA_TOOL_OPTIONS:-}" ]; then export JAVA_TOOL_OPTIONS="$KCADM_JAVA_TOOL_OPTIONS"; else unset JAVA_TOOL_OPTIONS; fi   # keep sandbox JVM flags out of kcadm output
kcadm() { "$KC_HOME/bin/kcadm.sh" "$@" --config "$WORK/kcadm.config"; }

echo "keycloak: $KC_URL (realm $REALM)"
kcadm config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD" >/dev/null
if kcadm get "realms/$REALM" --fields realm >/dev/null 2>&1; then
  if $RESET; then
    echo "realm $REALM: exists, deleting (--reset)"
    kcadm delete "realms/$REALM"
  else
    echo "realm $REALM: already present, nothing to import (use --reset to recreate)"
    SKIP_IMPORT=true
  fi
fi
if [ "${SKIP_IMPORT:-false}" != true ]; then
  # Resolve ${NAME:default} placeholders (uppercase names only; Keycloak's own ${username} labels are untouched).
  node -e '
    const fs = require("fs");
    const src = fs.readFileSync(process.argv[1], "utf8");
    const out = src.replace(/\$\{([A-Z][A-Z0-9_]*)(?::([^}]*))?\}/g, (_m, name, def) => process.env[name] ?? def ?? "");
    fs.writeFileSync(process.argv[2], out);
  ' "$REALM_FILE" "$WORK/realm.json"
  kcadm create realms -f "$WORK/realm.json"
  echo "realm $REALM: imported from $(basename "$REALM_FILE")"
fi

ISSUER="$KC_URL/realms/$REALM"
if $VERIFY; then
  echo "verifying password grant for client web / user admin"
  curl -fsS -X POST "$ISSUER/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=web -d username=admin -d scope=openid \
    --data-urlencode "password=${DEMO_PASSWORD:-Demo@2026}" > "$WORK/token.json"
  node -e '
    const j = require(process.argv[1]);
    if (!j.access_token) { console.error("no access_token in response", JSON.stringify(j)); process.exit(1); }
    const p = JSON.parse(Buffer.from(j.access_token.split(".")[1], "base64url").toString());
    console.log(`token grant ok: iss=${p.iss} sub=${p.sub} user=${p.preferred_username} roles=${(p.realm_access || {}).roles} groups=${p.groups} expires_in=${j.expires_in}s`);
  ' "$WORK/token.json"
fi
echo "issuer:  $ISSUER"
echo "jwks:    $ISSUER/protocol/openid-connect/certs"
echo "openid:  $ISSUER/.well-known/openid-configuration"
