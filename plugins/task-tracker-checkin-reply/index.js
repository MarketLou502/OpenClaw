import { createRequire } from 'node:module';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requestAgentReply } = require('../../workspace-main/scripts/lib/agent-turn');

// NOT the archived legacy inbound watcher (archives/legacy-routing-2026-07-31/,
// which must never run alongside the native Gateway iMessage channel) — this
// is new, purpose-built, and scoped only to matching a reply against a
// pending Task Tracker due-date check-in. Everything else falls through
// unclaimed to normal Main routing, same as shared-routine-router does for
// non-matching text.

const PENDING_CHECKINS_FILE = process.env.OPENCLAW_PENDING_CHECKINS_FILE ||
  '/Users/aaronmacmini/.openclaw/workspace-daily-tracker/memory/pending-checkins.json';
const REPLY_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h — separate from the 24h ledger expiry sweep

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

function findAwaitingReplies(now) {
  const doc = readJson(PENDING_CHECKINS_FILE, { checkins: [] });
  const checkins = Array.isArray(doc.checkins) ? doc.checkins : [];
  return checkins.filter((c) => c.status === 'awaiting-reply' && (now - new Date(c.sentAt).getTime()) <= REPLY_MATCH_WINDOW_MS);
}

// Marks entries replied only once we have a composed response ready — if
// composing fails we leave the ledger untouched and fall through to Main,
// rather than silently eating Aaron's reply with no usable response.
function markReplied(ids) {
  const doc = readJson(PENDING_CHECKINS_FILE, { checkins: [] });
  const checkins = Array.isArray(doc.checkins) ? doc.checkins : [];
  const idSet = new Set(ids);
  for (const c of checkins) if (idSet.has(c.id)) c.status = 'replied';
  atomicWriteJson(PENDING_CHECKINS_FILE, { checkins });
}

function replyFacts(matches, replyText) {
  const lines = [`Aaron just replied to a due-date check-in text. His reply: "${replyText}"`, ''];
  if (matches.length === 1) {
    const m = matches[0];
    lines.push(`This was in reply to this check-in Aaron was sent: "${m.text}" (board: ${m.board}, task id: ${m.taskId}).`);
    lines.push('');
    lines.push('Respond naturally, like someone rooting for him, not tracking him. If he committed to time or reported progress, log it via dashboard-workflow.js log-progress (30-min blocks, half-blocks ok). If he says he didn\'t get to it, that\'s fine — accept it plainly, no guilt trip, no re-asking; you\'ll check back another time. Reply with ONLY the message text to send back, nothing else.');
  } else {
    lines.push('There is more than one check-in awaiting a reply right now, so it is ambiguous which task he means:');
    for (const m of matches) lines.push(`- "${m.text}" (board: ${m.board}, id: ${m.taskId})`);
    lines.push('');
    lines.push('Ask him which one he means, briefly. Reply with ONLY the message text to send back, nothing else.');
  }
  return lines.join('\n');
}

export default definePluginEntry({
  id: 'task-tracker-checkin-reply',
  name: 'Task Tracker Check-in Reply Router',
  description: 'Claims iMessage replies to a pending Task Tracker due-date check-in before Main routing.',
  register(api) {
    api.on('inbound_claim', async (event) => {
      if (event.channel !== 'imessage' || event.isGroup) return { handled: false };
      const text = event.content || event.bodyForAgent || event.body;
      if (!text || !text.trim()) return { handled: false };

      const matches = findAwaitingReplies(Date.now());
      if (!matches.length) return { handled: false };

      const composed = requestAgentReply('task-tracker', replyFacts(matches, text), { timeoutSeconds: 25 });
      if (!composed.ok || !composed.text.trim()) {
        api.logger.warn(`task-tracker-checkin-reply: compose failed (${composed.error || 'no text'}), falling through to Main`);
        return { handled: false };
      }

      markReplied(matches.map((m) => m.id));
      api.logger.info(`task-tracker-checkin-reply: matched ${matches.length} pending check-in(s), routed to task-tracker`);
      return { handled: true, reply: { text: composed.text.trim() } };
    }, { priority: 90, timeoutMs: 30000 });
  },
});
