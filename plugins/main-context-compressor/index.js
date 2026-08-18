import { createRequire } from 'node:module';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const require = createRequire(import.meta.url);
const { compressToolResultMessage } = require('../../services/main-context-compressor');

export default definePluginEntry({
  id: 'main-context-compressor',
  name: 'Main Context Compressor',
  description: 'Synchronously shortens large tool-call results in Main\'s session before persistence.',
  register(api) {
    // tool_result_persist is the only hook allowed to rewrite a tool
    // result before it's persisted, and it's synchronous-only — no LLM
    // call here, see services/main-context-compressor/index.js for why.
    api.on('tool_result_persist', (event, ctx) => {
      if (ctx?.agentId !== 'main') return;
      try {
        const newMessage = compressToolResultMessage(event.message);
        if (!newMessage) return;
        return { message: newMessage };
      } catch (err) {
        api.logger.error(`main-context-compressor: ${err?.message || err}`);
        return; // leave the original message untouched on any failure
      }
    }, { priority: 0, timeoutMs: 5000 });
  },
});
