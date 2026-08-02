import { createRequire } from 'node:module';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const require = createRequire(import.meta.url);
const { routeRoutineRequest } = require('../../services/shared-routine-router');

export default definePluginEntry({
  id: 'shared-routine-router',
  name: 'Shared Routine Router',
  description: 'Claims deterministic iMessage routines before local Main routing.',
  register(api) {
    api.on('inbound_claim', async (event) => {
      if (event.channel !== 'imessage' || event.isGroup) return { handled: false };
      const routed = await routeRoutineRequest({
        text: event.content || event.bodyForAgent || event.body,
        channel: 'imessage',
        accountId: event.accountId,
        conversationId: event.conversationId || event.sessionKey,
        messageId: event.messageId,
      });
      if (!routed.handled) return { handled: false };
      api.logger.info(`shared-routine-router: ${routed.route} handled for iMessage`);
      return { handled: true, reply: { text: routed.reply } };
    }, { priority: 100, timeoutMs: 30000 });
  },
});
