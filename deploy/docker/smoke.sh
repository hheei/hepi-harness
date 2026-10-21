#!/usr/bin/env bash
# Builds the one image this repository still ships and exercises it end to end, then removes everything it created.
#
#   deploy/docker/smoke.sh          # no arguments, no pnpm, no registry, no live provider credential
#
# It builds with the Docker daemon (the image installs pnpm itself), runs the backend on a loopback-published
# ephemeral port with a throwaway state directory, and checks:
#   - the backend answers its authenticated model catalog, and 401 without the token (readiness, not just a listen)
#   - a conversation created through the API survives a container restart on the same state volume
#   - both SQLite files exist in the state directory after the run
# The Web origin is not a container and is deliberately not exercised here: it is the client ingress, a systemd unit
# serving the Vite build (docs/client-runtime-release.md), and its own read-only smoke list lives in that guide. Its
# Next container, `hepi-web`, was retired, so there is no second image to build.
# No model provider is configured: the deployment states no default and offers no model, which is what the catalog
# check below asserts. No network, no credential, no cost. Nothing here talks to a live model, an SSH host or an
# external agent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOKEN="smoke-${RANDOM}${RANDOM}"
STATE="$(mktemp -d "${TMPDIR:-/tmp}/hepi-smoke-XXXXXX")"
BACKEND_CONTAINER="hepi-smoke-backend-$$"
NETWORK="hepi-smoke-net-$$"
FAILED=0

log() { printf '%s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
cleanup() {
  docker rm -f "$BACKEND_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}
trap cleanup EXIT

# An ephemeral host port, released immediately so docker can bind it.
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
BACKEND_PORT="$(free_port)"

wait_http() { # url, token, label
  local url="$1" token="$2" label="$3" attempt
  for attempt in $(seq 1 60); do
    if curl -fsS -m 5 -H "authorization: Bearer $token" "$url" >/dev/null 2>&1; then pass "$label"; return 0; fi
    sleep 1
  done
  fail "$label (no answer within 60s)"; return 1
}

log "== build =="
docker build --load -f "$ROOT/deploy/docker/backend.Dockerfile" -t hepi-backend:smoke "$ROOT"
pass "the backend image built"

log "== backend =="
# The container gets its own network rather than the host's, so the run cannot collide with a real deployment's
# loopback. host.docker.internal would not do for a caller on it: that is the bridge gateway and does not forward the
# host-published loopback socket.
docker network create "$NETWORK" >/dev/null
# The container binds 0.0.0.0 inside its own namespace so the published port works; only 127.0.0.1 on the host is
# reachable. This mirrors the split profile, and keeps the smoke test off the host-network loopback the deployment
# topology uses.
docker run -d --name "$BACKEND_CONTAINER" \
  --network "$NETWORK" \
  --user "$(id -u):$(id -g)" \
  -e HEPI_BIND_HOST=0.0.0.0 -e PORT=8787 \
  -e HEPI_AUTH_TOKEN="$TOKEN" \
  -e HEPI_DB=/var/lib/hepi/hepi.sqlite \
  -e HEPI_SKILL_REPOSITORY=/var/lib/hepi/skill-repository.sqlite \
  -p "127.0.0.1:$BACKEND_PORT:8787" \
  -v "$STATE:/var/lib/hepi" \
  hepi-backend:smoke >/dev/null
BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
wait_http "$BACKEND_URL/api/models" "$TOKEN" "backend /api/models answers 200 with the bearer token"
curl -fsS -m 5 -H "authorization: Bearer $TOKEN" "$BACKEND_URL/api/models" | grep -q '"defaultModel":null' && pass "an unconfigured backend states no default model" || fail "an unconfigured backend stated a default model"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/models")" = "401" ] && pass "unauthenticated /api/models answers 401" || fail "unauthenticated /api/models did not answer 401"

CREATED="$(curl -fsS -m 5 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"workspaceId":null}' "$BACKEND_URL/api/conversations")"
CONVERSATION="$(printf '%s' "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["conversationId"])')"
[ -n "$CONVERSATION" ] && pass "created conversation $CONVERSATION through the API" || fail "conversation creation returned no id"

log "== restart =="
docker restart "$BACKEND_CONTAINER" >/dev/null
wait_http "$BACKEND_URL/api/models" "$TOKEN" "backend answers again after restart"
curl -fsS -m 5 -H "authorization: Bearer $TOKEN" "$BACKEND_URL/api/conversations" | grep -q "\"$CONVERSATION\"" \
  && pass "conversation $CONVERSATION survived the restart" || fail "conversation $CONVERSATION was lost across the restart"
[ -f "$STATE/hepi.sqlite" ] && pass "conversation database persisted at hepi.sqlite" || fail "hepi.sqlite missing from the state directory"
[ -f "$STATE/skill-repository.sqlite" ] && pass "skill repository database persisted at skill-repository.sqlite" || fail "skill-repository.sqlite missing from the state directory"

log "== result =="
if [ "$FAILED" = "0" ]; then log "smoke: all checks passed"; else log "smoke: failures above"; fi
exit "$FAILED"
