# TOOLS.md

## Data Source: CrazyNinjaOdds ONLY

All bet picks come from scraping CrazyNinjaOdds via the Playwright script. No other data sources. No Odds API. No Pinnacle feed. EV is pre-calculated by CrazyNinjaOdds — read it directly from scraper output.

If the scraper returns zero results: send one `message` tool call: `No results returned for [Book].` then output `NO_REPLY`.

---

## Discord Output Format — STRICT

Every word you output goes to Discord. No internal monologue. Only `message` tool calls — no text output at all.

**Sharp bet (2 lines exactly):**
```
[Away] @ [Home] Market: [Market]
Pick: [Pick] [Odds] EV: +[X.X]%
```

**Camouflage slot (3 lines):**
```
🎭 CAMO | [Sport]
Book: [Book]
Reminder: Place a random mainline bet on [Book] yourself (~$10)
```

**No qualifying bets:** `No qualifying bets for [Book] right now.`

**Message routing:** Do NOT include `target` field. Use `action: "send"` and `message: "..."` only. Adding a `target` sends a DM instead of channel.

---

## Operating Mode: WARMUP

In WARMUP: scrape and filter normally, send Discord alerts, but do NOT write to queue-state files.

To go PRODUCTION: Aaron says "go live" → change mode, initialize `memory/queue-state-YYYY-MM-DD.json`.

---

## How to Run the Scraper

```bash
node /Users/aaronmacmini/.openclaw/workspace-sports-betting/scripts/scrape-ev.js <bookname>
```

Valid booknames: `bet365`, `betmgm`, `fanatics`, `fanduel`, `caesars`, `draftkings`

Output is JSON to stdout. Parse it, apply EV rules, send qualifying bets via `message` tool calls only.

---

## EV Rules (Hard Limits)

| Rule | Value |
|------|-------|
| Minimum EV for sharp bet | +3% |
| Tier 1: Main Lines (spreads, moneylines, totals) | +3% to +12% EV → $30 stake |
| Tier 2: Player Props | +3% to +7% EV → $20 stake |
| Skip: Props above +8% EV | flagging risk |
| Skip: Anything above +14% EV | palpable error risk |

Fill Tier 1 first. Only use Tier 2 if Tier 1 quota unmet.

---

## Books & Daily Limits

| Book | Daily Limit |
|------|-------------|
| Bet365 | 4 bets |
| BetMGM | 5 bets |
| Fanatics | 4 bets |
| FanDuel | 5 bets |
| Caesars | 4 bets |
| DraftKings | 5 bets |

Rotation order: Bet365 → BetMGM → Fanatics → FanDuel → Caesars → DraftKings → repeat.
Every 5th bet must be camouflage (1 per book per day). Total daily cap: 24–30 bets.

---

## Betting Windows (EST)

| Window | Hours |
|--------|-------|
| 🟢 Golden Window | 10:00 AM – 2:00 PM |
| 🟢 Prime Time | 6:00 PM – 9:00 PM |
| 🔴 Dead Zone | 1:00 AM – 8:00 AM |

Outside windows: reply `HEARTBEAT_OK`, do nothing.

---

## Queue State File

`memory/queue-state-YYYY-MM-DD.json` format:
```json
{
  "date": "YYYY-MM-DD",
  "totalBetsToday": 0,
  "books": {
    "Bet365":     { "betsToday": 0, "dailyLimit": 4, "camoSent": false, "complete": false },
    "BetMGM":     { "betsToday": 0, "dailyLimit": 5, "camoSent": false, "complete": false },
    "Fanatics":   { "betsToday": 0, "dailyLimit": 4, "camoSent": false, "complete": false },
    "FanDuel":    { "betsToday": 0, "dailyLimit": 5, "camoSent": false, "complete": false },
    "Caesars":    { "betsToday": 0, "dailyLimit": 4, "camoSent": false, "complete": false },
    "DraftKings": { "betsToday": 0, "dailyLimit": 5, "camoSent": false, "complete": false }
  }
}
```

---

## Aaron's Phone / Pikkit

- Phone: +15023218025
- Pikkit syncs books automatically, tracks P&L and CLV
- CLV analysis: if avg CLV < 0 for 2+ consecutive weeks, flag for recalibration
