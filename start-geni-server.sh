#!/bin/bash
# DO SERVER (roro.mreider.com / 144.126.210.189) — runs the Geni OAuth endpoints
# This machine handles: OAuth callback, privacy policy, terms, deauthorize webhook
# Requires: geni-config.json, geni-tokens.json (created by geni-auth.js during OAuth)
# Nginx reverse proxies port 443 → 3000

cd "$(dirname "$0")"
echo "[start-geni-server] Geni OAuth server starting on $(hostname)..."
exec node geni-auth.js
