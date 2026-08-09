import { createRequire } from 'node:module';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const require = createRequire(import.meta.url);
const { routeRoutineRequest } = require('../../services/shared-routine-router');
const fs = require('fs');

// Shared with services/ha-voice-adapter/server.js's own append helper — same
// file, same nightly-truncated log, so both channels show up together in the
// trace-noc Investigations view. Fire-and-forget, same as the voice adapter:
// never block the reply on the log write.
const VOICE_FASTPATH_LOG = process.env.HA_VOICE_FASTPATH_LOG ||
  '/Users/aaronmacmini/.openclaw/logs/voice-fastpath.jsonl';

function appendVoiceFastPathLog(entry) {
  const line = JSON.stringify({ timestamp: Date.now(), ...entry }) + '\n';
  fs.promises.appendFile(VOICE_FASTPATH_LOG, line).catch(() => {});
}

export default definePluginEntry({
  id: 'shared-routine-router',
  name: 'Shared Routine Router',
  description: 'Claims deterministic iMessage routines before local Main routing.',
  register(api) {
    api.on('inbound_claim', async (event) => {
      if (event.channel !== 'imessage' || event.isGroup) return { handled: false };
      const text = event.content || event.bodyForAgent || event.body;
      const routed = await routeRoutineRequest({
        text,
        channel: 'imessage',
        accountId: event.accountId,
        conversationId: event.conversationId || event.sessionKey,
        messageId: event.messageId,
      });
      // Logged on both outcomes — see the matching comment in
      // ha-voice-adapter/server.js. Previously iMessage routine attempts
      // left no trace at all, success or failure.
      appendVoiceFastPathLog({
        route: routed.handled ? 'router' : 'router-unhandled',
        intent: routed.route || null,
        request: text,
        reply: routed.reply || null,
        deviceSlug: 'imessage',
        stages: routed.stages || [],
      });
      if (!routed.handled) return { handled: false };
      api.logger.info(`shared-routine-router: ${routed.route} handled for iMessage`);
      return { handled: true, reply: { text: routed.reply } };
    }, { priority: 100, timeoutMs: 30000 });
  },
});
