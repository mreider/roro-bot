#!/bin/bash
# HOME PC — runs the WhatsApp bot
# This machine handles: WhatsApp connection, Claude AI, family tree management
# Requires: geni-config.json, geni-tokens.json (not in git — copy from DO server)

cd "$(dirname "$0")"
echo "[start-bot] WhatsApp bot starting on $(hostname)..."
exec node bot.js
