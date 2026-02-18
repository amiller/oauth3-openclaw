#!/bin/bash
# Wrapper for phala CLI that routes through the OAuth3 MITM gateway
# Usage: phala-tee <any phala command>

GATEWAY_PORT="${PHALA_GATEWAY_PORT:-3738}"

# Check gateway is running
if ! curl -sf "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then
  echo "[phala-tee] Gateway not running, starting..." >&2
  node /opt/phala-gateway/server.js >> /tmp/phala-gateway.log 2>&1 &
  sleep 1
fi

exec env \
  PHALA_CLOUD_API_PREFIX="http://127.0.0.1:${GATEWAY_PORT}" \
  PHALA_CLOUD_API_KEY="gateway-placeholder" \
  phala "$@"
