# OpenClaw Setup Notes

**System:** Mac mini sandbox
**Owner:** Aaron (EST)
**Last updated:** 2026-03-04

---

## Architecture Overview

This is a multi-agent OpenClaw deployment with a supervisor/specialist pattern:

- **One supervisor agent (Clawd)** — operates the Mac, manages calendar/files, and is the gatekeeper for all other agent actions. Aaron's primary interface.
- **Specialist agents (fbb-agent, daily-tracker, etc.)** — each has a single domain of responsibility, isolated context, and its own Discord bot. They do not know about each other or about OpenClaw internals.

**Key principle:** Specialist agents are self-contained. Adding a new specialist never requires touching the supervisor's context or workspace files.

---

## What Has Been Verified and Working

### 1. OpenClaw running with OpenRouter + local Ollama fallback
- Primary model: `ollama/qwen2.5:7b` (local, free)
- Fallback 1: `openrouter/anthropic/claude-sonnet-4-5` (via OpenRouter API)
- Fallback 2: `openrouter/openrouter/auto`
- OpenRouter provider uses `api: "openai-completions"` — this is required, not `"openai"`

### 2. Multi-bot Discord with hard channel isolation
Two separate Discord bots, each scoped to one channel. The bots do not cross-respond.
- **Clawd bot** → `#general` only
- **fbb-agent bot** → `#2026-fbb-agent` only

Isolation is achieved by putting the `guilds` config **inside each account**, not at the top level of `channels.discord`. Top-level `guilds` would be shared across all bots.

### 3. execApprovals wired to #general
Agent actions that require human approval surface to Aaron in Discord with approve/deny buttons. Only Clawd's bot posts these (via the main account).

### 4. Context isolation confirmed
Each agent has its own workspace directory and its own Discord bot. Messages from one channel cannot reach the other agent's context window. Verified by testing both channels independently.

---

## Config Patterns

### Multi-bot Discord (the key structure)

```json
"channels": {
  "discord": {
    "enabled": true,
    "accounts": {
      "main": {
        "token": "<CLAWD_BOT_TOKEN>",
        "guilds": {
          "<GUILD_ID>": {
            "requireMention": false,
            "users": ["<AARON_DISCORD_USER_ID>"],
            "channels": {
              "<GENERAL_CHANNEL_ID>": { "allow": true }
            }
          }
        }
      },
      "fbb": {
        "token": "<FBB_BOT_TOKEN>",
        "guilds": {
          "<GUILD_ID>": {
            "requireMention": false,
            "users": ["<AARON_DISCORD_USER_ID>"],
            "channels": {
              "<FBB_CHANNEL_ID>": { "allow": true }
            }
          }
        }
      }
    },
    "groupPolicy": "allowlist",
    "streaming": "off",
    "execApprovals": {
      "enabled": true,
      "approvers": ["<AARON_DISCORD_USER_ID>"],
      "target": "channel",
      "cleanupAfterResolve": true
    }
  }
}
```

### Bindings (routes Discord accounts to agents)

```json
"bindings": [
  {
    "agentId": "main",
    "match": { "channel": "discord", "accountId": "main" }
  },
  {
    "agentId": "fbb-agent",
    "match": { "channel": "discord", "accountId": "fbb" }
  }
]
```

**How routing works:** Each Discord bot token = one `accountId`. The binding maps `accountId → agentId`. The agent's workspace files are the only context it ever sees — no cross-contamination.

### Agents list

```json
"agents": {
  "defaults": {
    "model": {
      "primary": "ollama/qwen2.5:7b",
      "fallbacks": ["openrouter/anthropic/claude-sonnet-4-5", "openrouter/openrouter/auto"]
    },
    "workspace": "/Users/aaronmacmini/.openclaw/workspace",
    "compaction": { "mode": "safeguard" },
    "heartbeat": { "model": "ollama/qwen2.5:7b" }
  },
  "list": [
    {
      "id": "main",
      "name": "Main",
      "workspace": "/Users/aaronmacmini/.openclaw/workspace-main",
      "agentDir": "/Users/aaronmacmini/.openclaw/agents/main/agent"
    },
    {
      "id": "fbb-agent",
      "name": "fbb-agent",
      "workspace": "/Users/aaronmacmini/.openclaw/workspace-fbb-agent",
      "agentDir": "/Users/aaronmacmini/.openclaw/agents/fbb-agent/agent"
    }
  ]
}
```

---

## Workspace File Conventions

Each agent's workspace contains these `.md` files loaded into system prompt at session start:

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Name, role, emoji, vibe |
| `SOUL.md` | Core responsibilities, operating principles, boundaries |
| `AGENTS.md` | Session startup checklist, workflow, memory rules, safety |
| `USER.md` | Aaron's info — name, timezone, Discord ID, preferences |
| `TOOLS.md` | Available integrations and their status |
| `HEARTBEAT.md` | What to check periodically; state tracked in `memory/heartbeat-state.json` |
| `BOOTSTRAP.md` | First-run identity setup script — **delete after identity is established** |

`BOOTSTRAP.md` should be deleted once the agent's workspace files are populated. It signals "this agent hasn't been set up yet."

---

## Supervisor vs Specialist Design

### Supervisor (Clawd / main agent)
- Knows about all other agents (listed in its `AGENTS.md`)
- Reviews and approves/denies/escalates specialist agent actions via `execApprovals`
- Has full Mac access — file system, calendar, scripts
- Bound to `#general` in Discord

### Specialist agents (fbb-agent, daily-tracker, etc.)
- Know nothing about the supervisor or other agents
- Know nothing about OpenClaw internals
- Their `AGENTS.md` describes only their own role and workflow
- Bound to their own dedicated Discord channel and bot

**Why this works:** Specialists route significant actions through OpenClaw's `execApprovals` mechanism. Clawd sees the request, evaluates it against the agent's stated goals, and approves/denies/escalates to Aaron. The specialist never needs to know about Clawd.

---

## How to Add a New Specialist Agent

1. **Discord Developer Portal**
   - Create new application + bot
   - Copy: App ID, Bot Token
   - Enable: Send Messages, Read Message History permissions

2. **Discord Server**
   - Create a dedicated channel for the agent
   - Copy the channel ID (right-click channel → Copy Channel ID)
   - The guild ID is obtained by right-clicking the server name

3. **openclaw.json — add the account**
   ```json
   "accounts": {
     "new-agent-id": {
       "token": "<NEW_BOT_TOKEN>",
       "guilds": {
         "<GUILD_ID>": {
           "requireMention": false,
           "users": ["541159481933955093"],
           "channels": {
             "<NEW_CHANNEL_ID>": { "allow": true }
           }
         }
       }
     }
   }
   ```

4. **openclaw.json — add the binding**
   ```json
   { "agentId": "new-agent-id", "match": { "channel": "discord", "accountId": "new-agent-id" } }
   ```

5. **openclaw.json — add to agents list**
   ```json
   { "id": "new-agent-id", "name": "New Agent", "workspace": "/Users/aaronmacmini/.openclaw/workspace-new-agent-id", "agentDir": "/Users/aaronmacmini/.openclaw/agents/new-agent-id/agent" }
   ```

6. **Populate workspace files** — write SOUL.md, AGENTS.md, USER.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md. Delete BOOTSTRAP.md.

7. **Update Clawd's AGENTS.md** — add the new agent to the roster so Clawd can intelligently evaluate its approval requests.

8. **Restart OpenClaw**

9. **Invite the bot** — Discord Dev Portal → OAuth2 → URL Generator → scope: `bot` → permissions: Send Messages + Read Message History → copy URL → invite to Openclaw server.

10. **Test** — send a message in the new channel. Only the new bot should respond. Clawd should stay silent.

---

## Known Gotchas

- **`openrouter/auto` and tool use:** OpenRouter's auto-routing may select a model without structured tool use support. This causes the model to print raw tool call syntax as text instead of executing the tool. Fix: pin to a specific capable model (`anthropic/claude-sonnet-4-5`) rather than using `openrouter/auto` as primary.

- **Top-level `guilds` in discord config is shared across all bots.** If you put `guilds` at the `channels.discord` level instead of inside each `accounts.*` entry, all bots will see all allowed channels and respond to all of them. Always put `guilds` inside the account.

- **`openclaw doctor` may reset `agents.list` to `[]`.** After running doctor, check that your agents list is intact. Re-add any cleared entries.

- **Two tokens in play after doctor runs.** If doctor writes a new token to config but you have a `.env` file with a different (fresher) token, use the `.env` token — it's more likely to be correct. OpenClaw does not support env var substitution in config; the token must be in the JSON directly.

- **Bot display names in Discord may lag.** After renaming a bot in the Developer Portal, the name may not update immediately in Discord UI. Kicking and re-inviting the bot with a fresh OAuth URL forces the refresh. This does not affect the token, config, or any OpenClaw behavior.

---

## Current Actual Values (reference)

| Item | Value |
|------|-------|
| Guild ID | `1478772029208662160` |
| #general channel ID | `1478772030349508661` |
| #2026-fbb-agent channel ID | `1478805554032939110` |
| Aaron's Discord User ID | `541159481933955093` |
| Gateway port | `18789` |
| Config path | `/Users/aaronmacmini/.openclaw/openclaw.json` |
