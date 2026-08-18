'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  compressText,
  compressToolResultMessage,
  archiveRaw,
} = require('./index');

test('compressText leaves short content untouched', () => {
  const result = compressText('short text', { thresholdChars: 2000 });
  assert.equal(result.compressed, false);
  assert.equal(result.text, 'short text');
});

test('compressText leaves content exactly at the threshold untouched', () => {
  const text = 'a'.repeat(2000);
  const result = compressText(text, { thresholdChars: 2000 });
  assert.equal(result.compressed, false);
});

test('compressText compacts a large JSON array, keeping first N items', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }));
  const raw = JSON.stringify({ items }, null, 2); // pretty-printed, over threshold
  const result = compressText(raw, { thresholdChars: 200 });
  assert.equal(result.compressed, true);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.items.length, 21); // 20 kept + 1 truncation marker
  assert.equal(parsed.items[0].id, 0);
  assert.match(parsed.items[20], /\+80 more items/);
  assert.ok(result.text.length < raw.length);
});

test('compressText truncates long string fields within JSON', () => {
  const raw = JSON.stringify({ note: 'x'.repeat(1000) });
  const result = compressText(raw, { thresholdChars: 50 });
  assert.equal(result.compressed, true);
  const parsed = JSON.parse(result.text);
  assert.match(parsed.note, /\+600 chars/);
});

test('compressText falls back to head/tail truncation for non-JSON text', () => {
  const raw = `HEADER\n${'y'.repeat(5000)}\nFOOTER`;
  const result = compressText(raw, { thresholdChars: 1000 });
  assert.equal(result.compressed, true);
  assert.match(result.text, /chars omitted, see archive/);
  assert.ok(result.text.startsWith('HEADER'));
  assert.ok(result.text.endsWith('FOOTER'));
});

test('compressText never returns something longer than the original', () => {
  const raw = JSON.stringify({ a: 1, b: 2 }); // small, already compact
  const result = compressText(raw, { thresholdChars: 5 });
  // Even though it's over a tiny threshold, minifying {"a":1,"b":2} can't
  // shrink further — must not "compress" into something equal-or-bigger.
  assert.equal(result.compressed, false);
});

test('compressToolResultMessage returns null for small results', () => {
  const message = {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName: 'sessions_history',
    content: [{ type: 'text', text: 'small' }],
  };
  assert.equal(compressToolResultMessage(message), null);
});

test('compressToolResultMessage rewrites only oversized text blocks and preserves other fields', () => {
  const bigItems = Array.from({ length: 50 }, (_, i) => ({ id: i }));
  const bigText = JSON.stringify({ items: bigItems });
  const message = {
    role: 'toolResult',
    toolCallId: 'call_42',
    toolName: 'sessions_history',
    isError: false,
    timestamp: 12345,
    content: [{ type: 'text', text: bigText }],
  };
  const rewritten = compressToolResultMessage(message, { thresholdChars: 100 });
  assert.notEqual(rewritten, null);
  assert.equal(rewritten.role, 'toolResult');
  assert.equal(rewritten.toolCallId, 'call_42');
  assert.equal(rewritten.isError, false);
  assert.equal(rewritten.timestamp, 12345);
  assert.match(rewritten.content[0].text, /compressed tool result/);
  assert.match(rewritten.content[0].text, /archived as call_42-/);
});

test('compressToolResultMessage leaves non-text content blocks alone', () => {
  const message = {
    role: 'toolResult',
    toolCallId: 'call_x',
    content: [{ type: 'image', data: 'base64...' }],
  };
  assert.equal(compressToolResultMessage(message), null);
});

test('archiveRaw appends the full original content to the archive log', async () => {
  const tmpLog = path.join(os.tmpdir(), `mcc-archive-test-${Date.now()}.jsonl`);
  archiveRaw({ toolCallId: 'call_9', rawText: 'the full original content' }, tmpLog);
  // fire-and-forget: give the promise a tick to land
  await new Promise((resolve) => setTimeout(resolve, 50));
  const contents = fs.readFileSync(tmpLog, 'utf8').trim();
  const entry = JSON.parse(contents);
  assert.equal(entry.toolCallId, 'call_9');
  assert.equal(entry.rawText, 'the full original content');
  assert.equal(typeof entry.timestamp, 'number');
  fs.unlinkSync(tmpLog);
});
