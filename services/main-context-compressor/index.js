'use strict';

const fs = require('fs');

// Deterministic, synchronous compression — no LLM call. tool_result_persist,
// the only OpenClaw hook allowed to rewrite a tool result before it's
// persisted, is synchronous-only: an awaited LLM completion inside it is
// silently discarded by the hook runner. So this stays fast, in-process,
// and predictable rather than semantic.
const DEFAULT_THRESHOLD_CHARS = 2000;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_CHARS = 400;

const ARCHIVE_LOG = process.env.MAIN_CONTEXT_COMPRESSION_ARCHIVE_LOG ||
  '/Users/aaronmacmini/.openclaw/logs/main-context-compression-archive.jsonl';

function compactValue(value, stats) {
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((v) => compactValue(v, stats));
    if (value.length > MAX_ARRAY_ITEMS) {
      stats.truncated = true;
      kept.push(`…(+${value.length - MAX_ARRAY_ITEMS} more items, see archive)`);
    }
    return kept;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = compactValue(v, stats);
    return out;
  }
  if (typeof value === 'string' && value.length > MAX_STRING_CHARS) {
    stats.truncated = true;
    return `${value.slice(0, MAX_STRING_CHARS)}…(+${value.length - MAX_STRING_CHARS} chars, see archive)`;
  }
  return value;
}

/**
 * Compress a tool result's raw text if it's over the threshold. Never
 * throws — callers must be able to treat any failure as "leave it alone".
 */
function compressText(rawText, opts = {}) {
  const thresholdChars = opts.thresholdChars ?? DEFAULT_THRESHOLD_CHARS;
  if (typeof rawText !== 'string' || rawText.length <= thresholdChars) {
    return { compressed: false, text: rawText };
  }

  const stats = { truncated: false };
  let bodyText;
  try {
    const parsed = JSON.parse(rawText);
    bodyText = JSON.stringify(compactValue(parsed, stats));
  } catch {
    const headLen = Math.floor(thresholdChars * 0.6);
    const tailLen = Math.floor(thresholdChars * 0.2);
    const head = rawText.slice(0, headLen);
    const tail = rawText.slice(-tailLen);
    const omitted = rawText.length - head.length - tail.length;
    bodyText = `${head}\n…[${omitted} chars omitted, see archive]…\n${tail}`;
    stats.truncated = true;
  }

  if (!stats.truncated || bodyText.length >= rawText.length) {
    // Re-serializing didn't actually shrink anything worth shrinking.
    return { compressed: false, text: rawText };
  }

  return { compressed: true, text: bodyText, originalLength: rawText.length };
}

/**
 * Fire-and-forget JSONL append of the original raw content, so nothing
 * compressed is ever truly lost. Never blocks or throws into the caller.
 */
function archiveRaw(entry, archiveLog = ARCHIVE_LOG) {
  const line = `${JSON.stringify({ timestamp: Date.now(), ...entry })}\n`;
  fs.promises.appendFile(archiveLog, line).catch(() => {});
}

/**
 * Build the replacement AgentMessage for a tool_result_persist hook, or
 * return null if the message shouldn't be touched (too small, not text
 * content, already compressed, etc).
 */
function compressToolResultMessage(message, opts = {}) {
  if (!message || !Array.isArray(message.content)) return null;

  let anyCompressed = false;
  const archiveId = `${message.toolCallId || 'unknown'}-${Date.now()}`;
  const newContent = message.content.map((block, idx) => {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
    const result = compressText(block.text, opts);
    if (!result.compressed) return block;
    anyCompressed = true;
    archiveRaw({
      archiveId: `${archiveId}-${idx}`,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      originalLength: result.originalLength,
      rawText: block.text,
    }, opts.archiveLog);
    return {
      ...block,
      text: `[compressed tool result — original ${result.originalLength} chars archived as ${archiveId}-${idx}]\n${result.text}`,
    };
  });

  if (!anyCompressed) return null;
  return { ...message, content: newContent };
}

module.exports = {
  compressText,
  compressToolResultMessage,
  archiveRaw,
  DEFAULT_THRESHOLD_CHARS,
  MAX_ARRAY_ITEMS,
  MAX_STRING_CHARS,
};
