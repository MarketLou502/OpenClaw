'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TraceStore, isLocalModel, toolSuspicion, redact } = require('../lib/trace-store');

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function msg(id, timestamp, role, content, extra = {}) {
  return { type: 'message', id, timestamp, message: { role, content, timestamp: Date.parse(timestamp), ...extra } };
}

test('classifies local providers and redacts sensitive evidence', () => {
  assert.equal(isLocalModel('ollama', 'llama3.1:8b'), true);
  assert.equal(isLocalModel('openrouter', 'anthropic/claude-haiku-4-5'), false);
  assert.deepEqual(redact({ apiKey: 'secret', caller: '+1 (502) 321-8025' }), { apiKey: '[REDACTED]', caller: '[REDACTED PHONE]' });
});

test('does not flag food mutations that intentionally avoid cached health patches', () => {
  const notice = toolSuspicion('exec', '{"ok":true,"operation":"log-food","dashboard":{"attempted":true,"ok":true,"healthUpdated":false}}');
  assert.equal(notice, null);
});

test('flags an operation that omitted its required dashboard update', () => {
  const notice = toolSuspicion('exec', '{"ok":true,"operation":"log-workout","dashboard":{"attempted":true,"ok":true,"healthUpdated":false}}');
  assert.equal(notice.code, 'NO_VISIBLE_PROJECTION_UPDATE');
  assert.equal(notice.severity, 'warning');
});

test('reconstructs a main-to-health-tracker yogurt trace', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-noc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainFile = path.join(root, 'agents/main/sessions/11111111-1111-4111-8111-111111111111.jsonl');
  const childFile = path.join(root, 'agents/health-tracker/sessions/22222222-2222-4222-8222-222222222222.jsonl');

  writeJsonl(mainFile, [
    msg('u1', '2026-08-03T11:37:04.532Z', 'user', 'I had a half a cup of yogurt.'),
    msg('a1', '2026-08-03T11:37:08.266Z', 'assistant', [{ type: 'toolCall', id: 'send1', name: 'sessions_send', arguments: { agentId: 'health-tracker', message: 'I had a half a cup of yogurt.', timeoutSeconds: 30 } }], { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', stopReason: 'toolUse', usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.001 } } }),
    msg('r1', '2026-08-03T11:37:38.500Z', 'toolResult', [{ type: 'text', text: 'accepted' }], { toolCallId: 'send1', toolName: 'sessions_send', details: { status: 'completed', exitCode: 0 } }),
    msg('a2', '2026-08-03T11:37:38.923Z', 'assistant', [{ type: 'text', text: 'Already confirmed — half cup of yogurt is logged.' }], { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', stopReason: 'stop' })
  ]);
  writeJsonl(mainFile.replace('.jsonl', '.trajectory.jsonl'), [
    { type: 'session.started', sessionKey: 'agent:main:home_assistant:voice-pe-kitchen', data: { messageChannel: 'webchat' } }
  ]);
  writeJsonl(childFile, [
    msg('u2', '2026-08-03T11:37:08.744Z', 'user', '[Inter-session message] sourceSession=agent:main:home_assistant:voice-pe-kitchen sourceChannel=webchat sourceTool=sessions_send isUser=false\nI had a half a cup of yogurt.', { provenance: { kind: 'inter_session', sourceSessionKey: 'agent:main:home_assistant:voice-pe-kitchen', sourceTool: 'sessions_send' } }),
    msg('a3', '2026-08-03T11:37:28.648Z', 'assistant', [{ type: 'toolCall', id: 'log1', name: 'exec', arguments: { command: 'node health-workflow.js log-food' } }], { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', stopReason: 'toolUse', usage: { input: 200, output: 20, cacheRead: 50, totalTokens: 270, cost: { total: 0.002 } } }),
    msg('r2', '2026-08-03T11:37:28.877Z', 'toolResult', [{ type: 'text', text: '{"ok":true,"operation":"log-food","mutationId":"m1","dashboard":{"attempted":true,"ok":true,"healthUpdated":false,"runGoalUpdated":false}}' }], { toolCallId: 'log1', toolName: 'exec', details: { status: 'completed', exitCode: 0 } })
  ]);
  writeJsonl(childFile.replace('.jsonl', '.trajectory.jsonl'), [
    { type: 'session.started', sessionKey: 'agent:health-tracker:main', data: { messageChannel: 'webchat' } }
  ]);

  const store = new TraceStore(root, { maxFiles: 10 });
  const requests = await store.listRequests({ query: 'yogurt' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'success');
  assert.deepEqual(requests[0].agents, ['main', 'health-tracker']);
  const trace = await store.getRequest(requests[0].id);
  assert.equal(trace.links[0].confidence, 'exact');
  assert.equal(trace.notices.length, 0);
  assert.equal(trace.usage.totalTokens, 380);
  assert.equal(trace.usage.cacheRead, 50);
  assert.equal(trace.usage.cost, 0.003);
});

test('discovers the newest reset transcript when compaction removed the active file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-noc-reset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'agents/main/sessions');
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  writeJsonl(path.join(dir, `${sessionId}.jsonl.reset.2026-08-03T11-45-21.817Z`), [
    msg('u1', '2026-08-03T11:37:04.532Z', 'user', 'I had a half a cup of yogurt.')
  ]);
  writeJsonl(path.join(dir, `${sessionId}.trajectory.jsonl`), [
    { type: 'session.started', sessionKey: 'agent:main:voice', data: { messageChannel: 'webchat' } }
  ]);
  const store = new TraceStore(root);
  const requests = await store.listRequests({ query: 'yogurt' });
  assert.equal(requests.length, 1);
  assert.match(requests[0].id, new RegExp(sessionId));
});
