# Handoff: Building a Voice Interface for an OpenClaw Agent

## Who this is for

You're picking this up to give a *different* OpenClaw agent (a food/calorie
tracker that lives elsewhere in Aaron's OpenClaw setup) the same kind of
voice interface the Spanish tutor agent has. This document is everything
learned building that first one — the architecture, the exact steps, and
every pitfall hit along the way, so you don't re-hit them.

This is not a "copy this folder and rename it" job — the two agents have
different tools, different databases, different things they need to talk
about. But the transport layer (browser mic → WebSocket → Gemini Live →
speech back, with function-calling into a SQLite-backed agent) is fully
reusable, and the deployment path (VPS, nginx, systemd, HTTPS) is identical.

## What exists today, as reference

Live example: `/Users/aaronmacmini/Vscode/Spanish Tutor/` on this Mac, deployed
at `https://aaronsagent.online`, running on a Hostinger VPS at `2.24.96.114`
(SSH alias `aaronsagent-vps`, key at `~/.ssh/aaronsagent_vps`).

```
Spanish Tutor/
  services/voice-orb/          <- the reusable part (Node WS server + browser UI)
    server.js                  <- HTTP + WebSocket server, static file serving
    lib/gemini-live.js         <- Gemini Live API WebSocket client
    lib/system-instruction.js  <- builds the system prompt from SOUL.md
    lib/progress-db.js         <- SQLite tool handlers + Gemini function declarations
    public/{index.html,app.js,style.css,pcm-worklet.js}  <- browser UI
  workspace-spanish-tutor/     <- the agent-specific part (swap this per-agent)
    SOUL.md                    <- personality + teaching method + tool usage rules
    progress.db                <- SQLite: sessions, concepts, mistakes, curriculum
    scripts/review-update.js   <- SM-2 spaced repetition script
  credentials/gemini-api-key.txt   <- local-dev only; VPS uses a systemd env file instead
```

Study `services/voice-orb/server.js` and `lib/progress-db.js` first — that's
the whole pattern: a `TOOLS` array of `{name, description, parameters, handler}`
objects gets handed to Gemini as function declarations, and each handler is
a plain function that reads/writes SQLite.

## Architecture

```
Browser (mic button)
  -> getUserMedia (mic capture)
  -> AudioWorkletNode (resample to 16kHz PCM16)
  -> WebSocket (wss://, same origin, path /ws)
Node server (server.js)
  -> bridges browser WebSocket <-> Gemini Live WebSocket
  -> handles Gemini's tool-calling by running handlers against SQLite
  -> streams Gemini's audio response back to the browser
nginx (reverse proxy, on the VPS)
  -> terminates TLS (Let's Encrypt)
  -> proxies HTTP + WebSocket upgrade to the Node process on 127.0.0.1
systemd
  -> keeps the Node process running, restarts on crash, starts on boot
```

No STT/TTS pipeline — it's Gemini Live's native speech-to-speech over a
single bidirectional WebSocket (`BidiGenerateContent`). Audio in is 16-bit
PCM/16kHz, audio out is 16-bit PCM/24kHz.

## Step-by-step: setting this up for a new agent

### 1. Scaffold the new project

```
<new-root>/
  services/voice-orb/       <- copy from Spanish Tutor/services/voice-orb, strip node_modules
  workspace-<agent-name>/   <- new, agent-specific
  credentials/gemini-api-key.txt   <- for local dev only
```

Keep the exact relative nesting (`services/voice-orb` two levels below
`<new-root>`, `workspace-<agent-name>` a sibling of `services/`) — the code
resolves paths via `__dirname`, not env vars, by default. (`TUTOR_DIR` env
var can override this — see `lib/progress-db.js` — useful once you're
deploying somewhere that doesn't preserve that layout, e.g. certain shared
hosts. See Pitfall 1.)

### 2. Rewrite the agent-specific layer

Everything in `workspace-<agent-name>/` and `lib/progress-db.js` is
food-tracker-specific and needs a rewrite, not a copy:

- **`SOUL.md`** — personality, teaching/coaching method, session lifecycle.
  Model structure on the Spanish tutor's, but content is entirely new
  (calorie goals, meal planning, pantry inventory instead of CEFR levels).
- **`progress-db.js`** — the `TOOLS` array and their SQLite handlers. This is
  the actual integration point with the food agent's existing logic/data —
  **you need to find out first**: does the food agent already have a
  database schema for pantry items / meals / calorie logs? If yes, point
  this file's `db` connection at that same database and write handlers
  against its existing schema instead of inventing a parallel one. If the
  food agent currently only has OpenClaw-side memory/state (no SQLite), that
  itself is worth flagging back to whoever owns that agent before building
  this — a voice interface needs *some* durable, queryable store to build
  tool calls against, the same way `progress.db` is the source of truth here.
- **`system-instruction.js`** — same pattern, just points at the new
  `SOUL.md` and no longer needs the "Voice mode specifics" swap-out logic
  unless the food agent similarly has a legacy non-voice interface whose
  instructions need trimming.

### 3. Local dev loop

```bash
cd <new-root>/services/voice-orb
npm install        # rebuilds better-sqlite3 natively — never copy node_modules across machines
node server.js      # or npm start; defaults to 127.0.0.1:18798, override with VOICE_ORB_PORT
```

Open `http://localhost:18798`. Get this fully working locally — mic
permission, WebSocket connect, at least one real tool call round-trip —
before touching deployment at all.

### 4. Provision a VPS (don't use shared hosting — see Pitfall 2)

- Hostinger hPanel → VPS → cheapest KVM plan → **Ubuntu 24.04 LTS** (plain OS)
- Get the IP + root password from hPanel after provisioning
- From your Mac: generate a dedicated SSH key, `ssh-copy-id` it, add an
  `~/.ssh/config` alias. Don't keep using the password after that.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/<name>_vps -N "" -C "<name>-vps"
sshpass -p '<password>' ssh-copy-id -i ~/.ssh/<name>_vps.pub root@<ip>
# then add to ~/.ssh/config:
#   Host <name>-vps
#     HostName <ip>
#     User root
#     IdentityFile ~/.ssh/<name>_vps
```

### 5. Base server setup

```bash
ssh <name>-vps
apt-get update -y
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-nginx
ufw allow OpenSSH; ufw allow 'Nginx Full'; ufw --force enable
useradd -m -s /bin/bash <appname>
mkdir -p /opt/<appname>/services/voice-orb /opt/<appname>/workspace-<agent-name>
chown -R <appname>:<appname> /opt/<appname>
```

### 6. Deploy the code

```bash
# from your Mac
rsync -az --exclude node_modules -e "ssh -i ~/.ssh/<name>_vps" \
  <new-root>/services/voice-orb/ root@<ip>:/opt/<appname>/services/voice-orb/
rsync -az -e "ssh -i ~/.ssh/<name>_vps" \
  <new-root>/workspace-<agent-name>/ root@<ip>:/opt/<appname>/workspace-<agent-name>/
ssh <name>-vps "chown -R <appname>:<appname> /opt/<appname>"
ssh <name>-vps "su - <appname> -c 'cd /opt/<appname>/services/voice-orb && npm install --omit=dev'"
```

### 7. API key + config via systemd, not a file in the app tree

```bash
ssh <name>-vps
cat > /etc/voice-orb.env <<'EOF'
GEMINI_API_KEY=<key>
VOICE_ORB_HOST=127.0.0.1
VOICE_ORB_PORT=18798
TUTOR_DIR=/opt/<appname>/workspace-<agent-name>
EOF
chown root:<appname> /etc/voice-orb.env
chmod 640 /etc/voice-orb.env
```

`lib/progress-db.js` and `server.js` already check `process.env.GEMINI_API_KEY`
/ `process.env.TUTOR_DIR` first, falling back to file-based resolution for
local dev — no code changes needed for this step.

### 8. systemd unit

```
# /etc/systemd/system/voice-orb.service
[Unit]
Description=<Agent Name> Voice Orb
After=network.target

[Service]
Type=simple
User=<appname>
Group=<appname>
WorkingDirectory=/opt/<appname>/services/voice-orb
EnvironmentFile=/etc/voice-orb.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/<appname>/workspace-<agent-name> /opt/<appname>/services/voice-orb/logs
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
mkdir -p /opt/<appname>/services/voice-orb/logs
chown <appname>:<appname> /opt/<appname>/services/voice-orb/logs
systemctl daemon-reload
systemctl enable --now voice-orb
```

### 9. nginx — this is the part that actually matters for WebSocket

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name <domain>;

    location / {
        proxy_pass http://127.0.0.1:18798;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

The `Upgrade`/`Connection` headers and generous timeouts are not optional —
see Pitfall 2. Then:

```bash
ln -sf /etc/nginx/sites-available/<domain> /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d <domain> --non-interactive --agree-tos -m <email> --redirect
```

Certbot rewrites the config to add the 443 block and redirect — **after it
runs, re-check that `listen [::]:443 ssl;` and `listen [::]:80;` are present**
(see Pitfall 6, certbot doesn't add IPv6 listeners on its own in this setup).

### 10. DNS

Add an `A` record (`@` → VPS IPv4) and, if the registrar's default record set
includes one, confirm/update the `AAAA` record (`@` → VPS IPv6, from
`ip -6 addr show scope global` on the VPS) — don't leave a stale AAAA record
pointing nowhere.

### 11. Verify before declaring done

```bash
# HTTP works
curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/

# WebSocket actually completes the handshake (the thing shared hosting couldn't do)
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://<domain>/ws');
ws.on('open', () => console.log('OPEN'));
ws.on('error', (e) => console.log('ERROR', e.message));
setTimeout(() => process.exit(0), 6000);
"
```

Run the WS check 2-3 times, not once — see Pitfall 2 on why "worked once" is
not sufficient evidence.

Then do a real browser test — Playwright MCP (`claude mcp add playwright --
npx @playwright/mcp@latest`, needs a session restart to pick up the tools)
is genuinely useful here: it can grant mic permission programmatically
(`getUserMedia`), click the orb, and read console/network state directly,
instead of relying on the user to screenshot a stuck UI back and forth.

## Pitfalls — read this before you start, not after

**1. Path resolution assumes a specific relative folder layout.**
`lib/progress-db.js` resolves the data directory as
`path.join(__dirname, '..', '..', '..', 'workspace-<name>')` by default —
three levels up from `lib/`. If your deployment target's build/deploy
pipeline doesn't preserve that exact nesting (ours didn't, see Pitfall 3),
either bundle the data directory *inside* `services/voice-orb/` as a
fallback (there's already a `BUNDLED_TUTOR_DIR` fallback wired in) or set
the `TUTOR_DIR` env var explicitly. Don't assume the local dev layout
survives deployment untouched — verify it.

**2. Shared/managed Node hosting (Phusion Passenger, cPanel-style panels)
does not reliably support persistent WebSocket connections.** We tried
Hostinger's "Business hosting" Node app feature first. HTTP worked fine.
WebSocket handshakes hung forever — sometimes. One test connection
succeeded right after a fresh deploy, then every subsequent attempt (from
both a browser and a plain Node client) timed out with zero response, no
error, nothing in server logs. Confirmed with the exact same URL, repeated
back-to-back. Passenger is built around a request/response HTTP model; the
CDN/caching edge layer in front of it compounds the problem. **If a hosting
product's marketing doesn't specifically say "WebSocket supported," assume
it isn't, for a real-time audio app.** This is why the actual deployment
here is a bare VPS with nginx as an explicit reverse proxy — full control
over the Upgrade/Connection headers, no CDN in the way. Don't skip straight
to "let's just try shared hosting, it's cheaper" — verify WS support first,
or go straight to a VPS/Fly.io/Render-style platform built for persistent
connections.

**3. Managed Node platforms that build from an uploaded archive may only
deploy your `root_directory`, silently dropping anything outside it.** On
Hostinger's Node app deploy, we set `root_directory: services/voice-orb` and
uploaded an archive with `workspace-spanish-tutor/` as a *sibling* directory
(matching local layout) — it never made it into the deployed app; only the
contents of `root_directory` got promoted to the actual app root. The app
crashed on startup (`better-sqlite3` couldn't create the DB file in a
directory that didn't exist) with no useful error surfaced to us — we had to
restart the app and inspect logs to find this. **If deploying via an
archive-upload flow with a "root directory" concept, nest all runtime data
*inside* that root directory, don't assume sibling directories survive.**
(Moot on the VPS path since we control the whole filesystem layout — but
worth knowing if a future deploy target uses this pattern again.)

**4. Browsers block `ws://` from an `https://` page (mixed content) —
silently, with no console error, no network request even attempted.** The
original code hardcoded `ws://${location.host}/ws`. Worked fine over
`http://localhost` in local dev, then silently failed on the HTTPS
deployment. Always derive the scheme: `location.protocol === 'https:' ?
'wss:' : 'ws:'`.

**5. `ScriptProcessorNode` (the "obvious" way to tap into mic audio) is
deprecated and has real bugs.** Use `AudioWorkletNode` instead — register a
small processor module (`audioContext.audioWorklet.addModule(...)`), and
route its output through a zero-gain `GainNode` to `destination` (a worklet
needs to be part of the audio graph to keep running, but you don't want raw
mic audio looping back to speakers).

**6. `getUserMedia()` can hang indefinitely with zero error, zero timeout,
zero console output, if a permission decision made via the browser's
address-bar UI (rather than the initial prompt) doesn't cleanly resolve an
already-in-flight call.** Always wrap it in `Promise.race` with an explicit
timeout (we used 15s) that surfaces a clear "try reloading the page"
message. Also: **the UI status text should update as soon as the mic
permission resolves, not stay frozen on "Requesting microphone…" through
the entire WebSocket handshake** — that mapping (one static status string
covering two different async waits) is what made a real WebSocket-hang bug
look identical to a mic-permission-hang bug from the user's side. Give each
distinct wait its own status text.

**7. nginx doesn't listen on IPv6 by default even if you write `listen 443
ssl;`** — you need an explicit `listen [::]:443 ssl;` line too (same for
port 80). Certbot's auto-config in our case didn't add these on its own. If
the domain has an AAAA record (many registrars add one by default), verify
`curl -6` actually reaches the site — don't assume IPv4 working means IPv6
does too.

**8. SQLite in WAL mode: never `cp` just the `.db` file for a live
database.** Recent writes may still be sitting in the `-wal` sidecar file,
not yet checkpointed into the main file. Copying only `progress.db` gave us
a database that looked plausible but was missing the last several sessions'
worth of writes. Either copy `.db` + `-wal` + `-shm` together, or (safer)
stop the process that holds the DB open before copying/migrating it, so
there's no concurrent writer and no WAL inconsistency risk.

**9. Running a Node script from a directory other than the one holding its
`node_modules` fails module resolution**, even with an absolute path to the
script. `require('some-native-module')` resolves relative to the *requiring
file's* location, not `process.cwd()`. If a script (e.g. a one-off DB
migration) lives outside `services/voice-orb/` but needs its dependencies,
run it with `NODE_PATH=/path/to/services/voice-orb/node_modules node
script.js`.

**10. When importing a third-party dataset (e.g. curriculum/content data
from GitHub), check the license before treating it as freely reusable.**
The dataset used here (a CEFR Spanish curriculum) is AGPL-3.0-licensed —
fine for this personal, non-redistributed use, but worth an explicit check
(and a NOTICE file with attribution) before assuming any GitHub repo's data
is unencumbered. If the food-tracker's meal/nutrition data comes from a
similar third-party source, check its license the same way before bulk-
importing.

**11. An AI-generated suggestion to "search GitHub for topic X" is not the
same as topic X actually existing.** We were told to search for
`spanish-grammar-cefr` and `spanish-curriculum-json` as GitHub topics — both
return zero results; they don't exist as real topics. Always verify a
specific external resource exists before planning around it — search
broadly and evaluate real candidates rather than trusting a
plausible-sounding pointer at face value.

**12. Playwright MCP (or any newly-added MCP server) doesn't appear
mid-session — the tool list loads at session start.** After `claude mcp add
playwright -- npx @playwright/mcp@latest`, the CLI shows it as connected
immediately, but the running Claude Code session needs an actual restart
before `ToolSearch` can find its tools. Don't assume a newly-added MCP
server is usable without restarting.

**13. There's a known, still-unresolved issue in the Spanish tutor's Gemini
Live session handling worth knowing about before you build the same thing
again:** Gemini Live enforces a session duration cap (~10 minutes observed,
closing with WebSocket code 1008). The current code doesn't auto-reconnect
or handle the `goAway` warning message Gemini sends before closing — the
session just silently ends and the UI quietly resets to "Off." If you want
long, uninterrupted voice sessions with the food agent (e.g. a full meal-
planning conversation), build the reconnect/goAway handling in from the
start rather than inheriting this gap.

## What's genuinely reusable vs. what to rebuild

**Copy as-is:** `server.js`, `lib/gemini-live.js`, `public/pcm-worklet.js`,
`public/app.js`'s WebSocket/audio plumbing (not its UI text), the nginx
config template, the systemd unit template, the whole VPS provisioning
sequence.

**Rebuild per-agent:** `SOUL.md`, the `TOOLS` array and handlers in
`progress-db.js`, `system-instruction.js`'s override text, the database
schema, `public/index.html`'s copy/branding.

**Investigate before building anything:** what does the food-tracking agent
currently use for storage? If it's OpenClaw in-memory/session state with no
SQLite backing, that's the first real design decision to make — voice tool-
calling needs a durable, queryable store the same way `progress.db` is one
here, not just conversational memory.
