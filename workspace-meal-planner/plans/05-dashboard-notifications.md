# Workstream 5: Dashboard Notifications from Subagents

## Goal

Create a visible area on Aaron's kiosk dashboard where Meal Planner (and potentially other subagents) can leave messages — suggestions, reminders, nudges, or observations. Something like:

> "You have 600 calories to go today. A Boost Protein Shake (530 cal, 22g protein) and a ham sandwich would get you there. 🥪"

or

> "You haven't had your Tuna Salad Sandwich in a while — I've got the ingredients in your pantry if you want one!"

## Context — existing dashboard architecture

### Dashboard stack

- **Dashboard API server**: `/Users/aaronmacmini/.openclaw/services/dashboard-api/server.js` (port 18795)
- **Frontend**: `/Users/aaronmacmini/.openclaw/services/dashboard-api/kiosk-repo/dashboard-web/index.html` + `app.js`
- **SSE push**: Server broadcasts on named channels (`health`, `meal-planner`, `financials`, `grocery`, `tasks`, `goals`) — app.js listens via `EventSource`
- **Token auth**: Bearer token from `service-env/dashboard-api.token`

### Current layout

The dashboard has:
- **Top row**: Daily Goals bar + action buttons
- **Main row**: Calendar panel + Task columns (Work, Personal, Market Lou)
- **Bottom row**: Left side = Health panel + Financials panel. Right side = Meal Planner panel (shows "Today's Meals" stat + hamburger menu for grocery/recipes overlay)

### Meal Planner panel (current)

```html
<section class="panel grocery-panel">
  <div class="panel-title-row">
    <h2 class="panel-title">Meal Planner</h2>
    <button class="hamburger-btn" id="mealPlannerMenuButton" type="button">☰</button>
  </div>
  <button class="stat-tile meal-plan-summary" id="mealPlanDetailsButton" type="button">
    <span class="stat-label">Today's Meals</span>
    <span class="stat-value" id="mealPlanStat">—</span>
  </button>
</section>
```

## What to build

### Part A: Agent messages table in meal-planner.sqlite

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,         -- 'meal-planner', 'health-tracker', etc.
  message TEXT NOT NULL,            -- the actual message
  message_type TEXT NOT NULL DEFAULT 'info',  -- 'suggestion', 'reminder', 'achievement', 'info'
  priority INTEGER NOT NULL DEFAULT 0,  -- higher = more important
  category TEXT,                    -- 'meal-suggestion', 'stock-alert', 'preference-nudge', etc.
  action_label TEXT,                -- optional button text e.g. "Plan it"
  action_payload TEXT,              -- optional JSON payload for the action
  is_read INTEGER NOT NULL DEFAULT 0,
  is_dismissed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,                  -- optional expiry timestamp
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_active ON agent_messages(is_read, is_dismissed, expires_at);
```

### Part B: API endpoints in dashboard-api

```
GET /api/meal-planner/messages?limit=5&unread=true
```
Returns active, unread messages sorted by priority then recency.

```
PATCH /api/meal-planner/messages/:id
```
Mark as read or dismissed.

```
POST /api/meal-planner/messages
```
Post a new message. Body: `{ agent_name, message, message_type, priority, category, action_label?, action_payload? }`

This endpoint should also broadcast the message over SSE so the dashboard updates in real-time:
```javascript
broadcast('meal-planner', { type: 'new-message', message: result });
```

### Part C: Dashboard frontend — notification area

Add a notification area to the Meal Planner panel. Replace the current simple stat-tile with a richer layout:

```html
<section class="panel grocery-panel">
  <div class="panel-title-row">
    <h2 class="panel-title">Meal Planner</h2>
    <div class="panel-title-controls">
      <button class="hamburger-btn" id="mealPlannerMenuButton" type="button">☰</button>
    </div>
  </div>
  
  <!-- New: Agent message area -->
  <div class="agent-messages" id="agentMessages">
    <!-- Messages injected here by app.js -->
  </div>
  
  <!-- Existing: Meal plan summary (shrunk to compact form) -->
  <button class="stat-tile meal-plan-summary" id="mealPlanDetailsButton" type="button">
    <span class="stat-label">Today's Meals</span>
    <span class="stat-value" id="mealPlanStat">—</span>
  </button>
</section>
```

In `app.js`, add a listener for the `meal-planner` SSE channel that checks for new messages and injects them into `#agentMessages`. Each message renders as:

```html
<div class="agent-message" data-message-id="uuid" data-priority="0">
  <div class="agent-message-icon">🍽️</div>
  <div class="agent-message-body">
    <p class="agent-message-text">You have 600 calories to go today...</p>
    <div class="agent-message-actions">
      <button class="agent-message-btn" data-action="plan-it">Plan it</button>
      <button class="agent-message-dismiss">✕</button>
    </div>
  </div>
</div>
```

### Part D: CSS styles

Add styles to `style.css` for the message area:

```css
.agent-messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.agent-message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: var(--surface);
  border-radius: 8px;
  border-left: 3px solid var(--accent);
}

.agent-message[data-priority="1"] {
  border-left-color: #f59e0b;  /* amber for suggestions */
}

.agent-message[data-priority="2"] {
  border-left-color: #ef4444;  /* red for important */
}

.agent-message-icon {
  font-size: 1.2em;
  flex-shrink: 0;
}

.agent-message-text {
  font-size: 0.85em;
  line-height: 1.3;
  color: var(--text);
  margin: 0;
}

.agent-message-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.agent-message-btn {
  padding: 2px 8px;
  font-size: 0.75em;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--surface);
  color: var(--accent);
  cursor: pointer;
}

.agent-message-dismiss {
  padding: 2px 6px;
  font-size: 0.75em;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}
```

### Part E: Generate messages from meal planner workflow

Add a command to `meal-planner-workflow.js`:

```bash
node scripts/meal-planner-workflow.js generate-messages
```

This analyzes the current state (remaining calorie budget, preference profile, pantry stock) and creates relevant messages. Examples:

- **Budget suggestion**: If `remaining.calories > 200` and there's a recipe that fits, suggest it
- **Preference nudge**: If a high-preference recipe hasn't been used in 10+ days, suggest it
- **Pantry alert**: If an ingredient is expiring or low, suggest a recipe that uses it
- **Achievement**: If takeout ratio dropped this week, send a positive reinforcement message

Messages are written to `agent_messages` table and posted to the dashboard API.

## Dashboard API routing

Add to `server.js`:

```javascript
// ── /api/meal-planner/messages ──
if (a === 'messages') {
  if (!b && req.method === 'GET') {
    const limit = url.searchParams.get('limit') || 5;
    const unreadOnly = url.searchParams.get('unread') === 'true';
    // Query agent_messages table
    const messages = mpDb.prepare(`
      SELECT * FROM agent_messages 
      WHERE is_dismissed = 0 
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ${unreadOnly ? 'AND is_read = 0' : ''}
      ORDER BY priority DESC, created_at DESC 
      LIMIT ?
    `).all(Number(limit));
    return sendJson(res, 200, { messages });
  }
  if (!b && req.method === 'POST') {
    const body = await readBody(req);
    // Insert new message
    const id = crypto.randomUUID();
    mpDb.prepare(`INSERT INTO agent_messages (...) VALUES (...)`)
      .run(id, body.agentName, body.message, body.messageType || 'info', 
           body.priority || 0, body.category || null, 
           body.actionLabel || null, body.actionPayload || null,
           nowIso());
    const message = mpDb.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
    broadcast('meal-planner', { type: 'new-message', message });
    return sendJson(res, 201, message);
  }
  if (b && !c && req.method === 'PATCH') {
    const body = await readBody(req);
    const updates = [];
    if (body.isRead !== undefined) updates.push('is_read = ?');
    if (body.isDismissed !== undefined) updates.push('is_dismissed = ?');
    if (updates.length) {
      const values = [body.isRead ?? body.isDismissed ?? 0, b];
      mpDb.prepare(`UPDATE agent_messages SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
    return sendJson(res, 200, { ok: true });
  }
}
```

## Success criteria

- Messages can be posted, read, and dismissed via API
- Dashboard displays active messages in the Meal Planner panel
- Messages from `generate-messages` suggest meals based on remaining budget, preferences, and pantry
- Message actions (e.g., "Plan it") are clickable and trigger the right workflow
- Old/expired messages are automatically hidden
- Real-time SSE updates when a new message arrives

## Dependencies

- Works with or without the other workstreams — message generation is richer with food log data (Workstream 2) and preferences (Workstream 3), but the messaging infrastructure works independently
- The dashboard frontend changes must be coordinated with the existing app.js patterns