#!/bin/bash
# Wrapper for gh CLI that routes through the OAuth3 MITM gateway
# Usage: gh-tee <any gh command>

GATEWAY_PORT="${GH_GATEWAY_PORT:-3739}"

# Check gateway is running
if ! curl -sfk "https://127.0.0.1:${GATEWAY_PORT}/api/v3/zen" >/dev/null 2>&1; then
  echo "[gh-tee] Gateway not running, starting..." >&2
  nohup env \
    OAUTH3_SESSION_ID="${OAUTH3_SESSION_ID}" \
    OAUTH3_BEARER_TOKEN="${OAUTH3_BEARER_TOKEN}" \
    node /opt/gh-gateway/server.js >> /tmp/gh-gateway.log 2>&1 &
  sleep 1
fi

exec env \
  GH_HOST="localhost:${GATEWAY_PORT}" \
  GH_TOKEN="gateway-placeholder" \
  gh "$@"
