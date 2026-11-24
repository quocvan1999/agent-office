#!/usr/bin/env bash
set -euo pipefail

HUB_URL="${HUB_URL:-http://127.0.0.1:4789}"
ACTION="${1:-TEST: rm -rf ./tmp-demo (dev test approval)}"

curl -sS -X POST "${HUB_URL}/api/dev/test-approval" \
  -H "content-type: application/json" \
  -d "$(printf '{"action":"%s"}' "${ACTION//\"/\\\"}")"
echo ""
