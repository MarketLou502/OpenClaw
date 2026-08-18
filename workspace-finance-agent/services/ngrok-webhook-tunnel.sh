#!/bin/zsh
# Runs ngrok pointed at the Plaid webhook receiver (127.0.0.1:18797) and, on
# every start (boot, crash restart, manual restart), re-registers the fresh
# public URL with Plaid via configure_plaid_webhook.js. ngrok's free tier
# hands out a new random URL each time it starts, so this re-registration
# step is required every time, not just once.
set -uo pipefail

WORKSPACE="/Users/aaronmacmini/.openclaw/workspace-finance-agent"
LOG="$WORKSPACE/services/ngrok-tunnel.log"
NGROK="/opt/homebrew/bin/ngrok"
NODE="/opt/homebrew/opt/node@22/bin/node"

log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) [ngrok-tunnel] $1" >> "$LOG"; }

"$NGROK" http 18797 --log=stdout --log-format=json >> "$LOG" 2>&1 &
NGROK_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 30); do
  sleep 1
  PUBLIC_URL=$(curl -s http://127.0.0.1:4040/api/tunnels \
    | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const t=(j.tunnels||[]).find(x=>x.proto==="https");if(t)process.stdout.write(t.public_url);}catch{}})')
  [ -n "$PUBLIC_URL" ] && break
done

if [ -z "$PUBLIC_URL" ]; then
  log "ERROR: ngrok did not report a public URL within 30s; leaving tunnel running unregistered"
else
  log "public URL: $PUBLIC_URL"
  "$NODE" "$WORKSPACE/scripts/configure_plaid_webhook.js" "$PUBLIC_URL/plaid/webhook" >> "$LOG" 2>&1
  if [ $? -eq 0 ]; then
    log "registered webhook with Plaid successfully"
  else
    log "ERROR: failed to register webhook with Plaid"
  fi
fi

wait "$NGROK_PID"
