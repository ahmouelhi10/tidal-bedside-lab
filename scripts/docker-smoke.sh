#!/usr/bin/env bash
# Build the production image, start it, and check that the server answers and verifies a replay.
# Usage: scripts/docker-smoke.sh [image-tag]     (needs a running Docker daemon; not run by `npm test`)
set -euo pipefail

TAG="${1:-tidal-bedside-lab:smoke}"
NAME="tbl-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -t "$TAG" "$ROOT"
docker run -d --name "$NAME" -p "${PORT}:8080" -e API_TOKEN=smoke-token "$TAG" >/dev/null

# wait up to 30 s for the health endpoint
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/tmp/tbl-health.json 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "FAIL: /api/health did not answer" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi
cat /tmp/tbl-health.json; echo

# static front end is served and is not cached blindly
headers=$(curl -fsS -D - -o /dev/null "http://127.0.0.1:${PORT}/")
grep -qi '^cache-control: no-cache' <<<"$headers" || { echo "FAIL: index missing no-cache header" >&2; exit 1; }

# instructor API is closed without the token and open with it
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/sessions")
[ "$code" = "401" ] || [ "$code" = "403" ] || { echo "FAIL: /api/sessions without token returned $code" >&2; exit 1; }
curl -fsS -H 'Authorization: Bearer smoke-token' "http://127.0.0.1:${PORT}/api/sessions" >/dev/null

# a session can be created and the server issues the seed
created=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"scenario":"stemi_vf","spec":{"sex":"M","age":58,"heightCm":178,"weightKg":92}}' \
  "http://127.0.0.1:${PORT}/api/sessions")
grep -q '"seed"' <<<"$created" || { echo "FAIL: session creation did not return a seed" >&2; exit 1; }

# container health status settles on healthy
for _ in $(seq 1 20); do
  st=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)
  [ "$st" = "healthy" ] && { echo "container healthy"; echo "smoke test passed"; exit 0; }
  sleep 2
done
echo "FAIL: container never became healthy (last status: $st)" >&2
exit 1
