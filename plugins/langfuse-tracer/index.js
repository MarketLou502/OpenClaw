import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Langfuse;

// ─── In-memory trace context store ───────────────────────────────────────────
// Maps sessionKey → { traceId, parentSpanId, generationId }
// Used to propagate trace context across sessions_send boundaries.
const traceMap = new Map();

function getConfig(key, fallback) {
  return process.env[key] || fallback;
}

function sanitizeForLangfuse(value, maxLen = 4096) {
  if (typeof value === 'string') return value.slice(0, maxLen);
  if (typeof value === 'object' && value !== null) {
    try {
      const str = JSON.stringify(value);
      return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
    } catch { return String(value).slice(0, maxLen); }
  }
  return String(value).slice(0, maxLen);
}

function truncateObject(obj, maxKeys = 50, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) return '[truncated]';
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    if (obj.length > 50) return [...obj.slice(0, 50), `…${obj.length - 50} more items`];
    return obj.map(v => truncateObject(v, maxKeys, maxDepth, depth + 1));
  }
  const keys = Object.keys(obj);
  if (keys.length > maxKeys) keys.splice(maxKeys);
  const result = {};
  for (const key of keys) {
    result[key] = truncateObject(obj[key], maxKeys, maxDepth, depth + 1);
  }
  return result;
}

function flattenToolArguments(args) {
  // Flatten key tool arguments for readable display while hiding secrets
  if (!args || typeof args !== 'object') return String(args || '');
  const flat = { ...args };
  if (flat.command && typeof flat.command === 'string') {
    flat.command = flat.command.split('\n')[0].slice(0, 160);
  }
  return sanitizeForLangfuse(truncateObject(flat, 20, 3), 2048);
}

function extractModelInfo(event) {
  if (event.modelId) return event.modelId;
  if (event.data?.model) return event.data.model;
  if (event.data?.provider) return `${event.data.provider}/${event.data.model || 'unknown'}`;
  if (event.provider && event.modelId) return `${event.provider}/${event.modelId}`;
  return 'unknown';
}

function hasParentContext(event) {
  // Check if this session has a sourceSessionKey indicating it was spawned by another agent
  return event.data?.sourceSessionKey || event.sourceSessionKey;
}

// ─── Plugin entry ────────────────────────────────────────────────────────────
export default definePluginEntry({
  id: 'langfuse-tracer',
  name: 'Langfuse Observability',
  description: 'Captures real-time traces, spans, generations, and tool observations and sends them to Langfuse.',
  register(api) {
    const publicKey = getConfig('LANGFUSE_PUBLIC_KEY');
    const secretKey = getConfig('LANGFUSE_SECRET_KEY');
    const baseUrl = getConfig('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com');

    if (!publicKey || !secretKey) {
      api.logger.warn(
        'langfuse-tracer: LANGFUSE_PUBLIC_KEY and/or LANGFUSE_SECRET_KEY not set. ' +
        'Plugin loaded but inactive. Set environment variables to enable tracing.'
      );
      // Register a no-op plugin that logs once and does nothing
      api.on('gateway_start', async () => {
        api.logger.info(
          'langfuse-tracer: inactive — set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to enable'
        );
      });
      return;
    }

    // Lazy-import Langfuse SDK only when keys are present
    const { Langfuse: LangfuseClient } = require('langfuse');
    const langfuse = new LangfuseClient({
      publicKey,
      secretKey,
      baseUrl,
      flushAt: 10,
      flushInterval: 5000,
    });

    api.logger.info(`langfuse-tracer: active — tracing to ${baseUrl}`);

    // ─── EVENT: gateway_start ──────────────────────────────────────────────
    api.on('gateway_start', async () => {
      api.logger.info('langfuse-tracer: gateway started, Langfuse client initialized');
    });

    // ─── EVENT: gateway_stop ───────────────────────────────────────────────
    api.on('gateway_stop', async () => {
      try { await langfuse.flushAsync(); } catch { /* shutdown */ }
      await langfuse.shutdownAsync();
    }, { priority: -100 });

    // ─── EVENT: session_start — Create Trace (main) or Span (sub-agent) ───
    api.on('session_start', async (event) => {
      try {
        api.logger.debug(`langfuse-tracer: session_start event keys=${Object.keys(event).join(',')} type=${event.type} agentId=${event.data?.agentId || event.agentId || 'UNSET'} sessionKey=${event.sessionKey}`);
        const agentId = event.data?.agentId || event.agentId || 'unknown';
        const sessionKey = event.sessionKey || event.data?.sessionKey || '';
        const traceId = event.traceId || sessionKey || event.sessionId;

        if (agentId === 'main') {
          // ── Root trace (Chief of Staff) ──
          const channel = event.data?.messageChannel || event.data?.messageProvider || 'unknown';
          const name = `Chief of Staff — ${channel}`;
          const trace = langfuse.trace({
            id: traceId,
            name,
            sessionId: sessionKey,
            metadata: {
              agentId,
              sessionKey,
              channel,
              source: 'openclaw-gateway',
              traceSchema: event.traceSchema || 'openclaw.trace.v1',
            },
          });
          traceMap.set(sessionKey, { traceId, trace, parentSpanId: null, agentId: 'main' });
          api.logger.debug(`langfuse-tracer: root trace created ${traceId} for ${sessionKey}`);
        } else {
          // ── Sub-agent span — look up parent trace context ──
          const sourceKey = event.data?.sourceSessionKey;
          let parentCtx = null;
          if (sourceKey && traceMap.has(sourceKey)) {
            parentCtx = traceMap.get(sourceKey);
          } else {
            // Fallback: scan traceMap for any parent that may have spawned this
            for (const [key, ctx] of traceMap) {
              if (ctx.agentId === 'main') {
                parentCtx = ctx;
                break;
              }
            }
          }

          if (parentCtx) {
            const parentTrace = parentCtx.trace;
            const span = parentTrace.span({
              id: traceId,
              name: `Sub-agent: ${agentId}`,
              parentObservationId: parentCtx.parentSpanId || undefined,
              metadata: {
                agentId,
                sessionKey,
                sourceSessionKey: sourceKey || null,
                traceSchema: event.traceSchema || 'openclaw.trace.v1',
              },
            });
            traceMap.set(sessionKey, {
              traceId: parentCtx.traceId,
              trace: parentTrace,
              parentSpanId: span.id,
              span,
              agentId,
            });
            api.logger.debug(`langfuse-tracer: sub-agent span created ${span.id} for ${agentId} (${sessionKey})`);
          } else {
            // Orphan sub-agent — create its own trace
            const trace = langfuse.trace({
              id: traceId,
              name: `Sub-agent (orphan): ${agentId}`,
              metadata: { agentId, sessionKey, orphan: true },
            });
            traceMap.set(sessionKey, { traceId, trace, parentSpanId: null, agentId });
            api.logger.debug(`langfuse-tracer: orphan trace created for ${agentId} (${sessionKey})`);
          }
        }
      } catch (err) {
        api.logger.error(`langfuse-tracer: session_start error: ${err.message}`);
      }
    });

    // ─── EVENT: model_call_started → Generation start ──────────────────────
    api.on('model_call_started', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx) return;

        const generationId = event.runId || event.traceId || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const modelName = extractModelInfo(event);
        const input = sanitizeForLangfuse(
          event.input || event.data?.input || event.data?.prompt || event.prompt || ''
        );

        const generation = ctx.trace.generation({
          id: generationId,
          name: `LLM: ${modelName}`,
          parentObservationId: ctx.parentSpanId || ctx.span?.id || undefined,
          model: modelName,
          modelParameters: {
            temperature: event.data?.temperature || undefined,
            maxTokens: event.data?.maxTokens || undefined,
          },
          input,
          metadata: {
            provider: event.provider || event.data?.provider || 'unknown',
            agentId: ctx.agentId,
            sessionKey,
          },
        });

        // Store generation ref for completion in model_call_ended
        ctx.generationId = generationId;
        ctx.generation = generation;
        traceMap.set(sessionKey, ctx);
      } catch (err) {
        api.logger.error(`langfuse-tracer: model_call_started error: ${err.message}`);
      }
    });

    // ─── EVENT: model_call_ended → Generation end ──────────────────────────
    api.on('model_call_ended', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx || !ctx.generation) return;

        const output = sanitizeForLangfuse(
          event.output || event.data?.output || event.data?.response || event.response || ''
        );
        const usage = event.usage || event.data?.usage || {};
        const modelName = extractModelInfo(event);

        ctx.generation.end({
          output,
          usage: {
            input: Number(usage.inputTokens || usage.input || usage.promptTokens || 0),
            output: Number(usage.outputTokens || usage.output || usage.completionTokens || 0),
            totalTokens: Number(usage.totalTokens || usage.total || 0),
            unit: 'TOKENS',
          },
          level: event.error ? 'ERROR' : 'DEFAULT',
          statusMessage: event.error ? sanitizeForLangfuse(String(event.error), 500) : undefined,
          metadata: {
            model: modelName,
            stopReason: event.stopReason || event.data?.stopReason || null,
            durationMs: event.durationMs || event.data?.durationMs || undefined,
          },
        });

        // Clean up generation ref
        delete ctx.generationId;
        delete ctx.generation;
        traceMap.set(sessionKey, ctx);

        // Flush periodically to keep Langfuse UI responsive
        langfuse.flushAsync().catch(() => {});
      } catch (err) {
        api.logger.error(`langfuse-tracer: model_call_ended error: ${err.message}`);
      }
    });

    // ─── EVENT: before_tool_call → Tool span start ─────────────────────────
    api.on('before_tool_call', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx) return;

        const toolName = event.toolName || event.data?.toolName || event.name || 'unknown';
        const toolId = event.toolCallId || event.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const args = flattenToolArguments(event.arguments || event.data?.arguments || event.input || {});

        // Special handling: sessions_send is a delegation, not a regular tool
        const isDelegation = toolName === 'sessions_send';
        const spanName = isDelegation
          ? `Delegate: → ${event.arguments?.agentId || event.data?.arguments?.agentId || 'agent'}`
          : `Tool: ${toolName}`;

        const span = ctx.trace.span({
          id: toolId,
          name: spanName,
          parentObservationId: ctx.parentSpanId || ctx.span?.id || undefined,
          startTime: new Date(),
          metadata: {
            type: isDelegation ? 'delegation' : 'tool',
            toolName,
            agentId: ctx.agentId,
            sessionKey,
            arguments: truncateObject(event.arguments || event.data?.arguments || {}, 15, 3),
          },
          input: isDelegation ? undefined : args,
        });

        // Track this tool span for completion in after_tool_call
        if (!ctx.activeTools) ctx.activeTools = new Map();
        ctx.activeTools.set(toolId, { span, toolName, at: Date.now() });
        traceMap.set(sessionKey, ctx);
      } catch (err) {
        api.logger.error(`langfuse-tracer: before_tool_call error: ${err.message}`);
      }
    });

    // ─── EVENT: after_tool_call → Tool span end ────────────────────────────
    api.on('after_tool_call', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx || !ctx.activeTools) return;

        const toolCallId = event.toolCallId || event.id;
        const toolEntry = toolCallId ? ctx.activeTools.get(toolCallId) : null;
        if (!toolEntry) {
          // Fallback: match by tool name if no ID match
          const toolName = event.toolName || event.data?.toolName;
          if (toolName && ctx.activeTools.size > 0) {
            // Find the last unmatched tool with this name
            for (const [id, entry] of ctx.activeTools) {
              if (entry.toolName === toolName && !entry.ended) {
                toolEntry = entry;
                toolCallId = id;
                break;
              }
            }
          }
        }
        if (!toolEntry) return;

        // Determine status
        const result = event.result || event.data?.result || event.output || '';
        const details = event.details || event.data?.details || {};
        const exitCode = details.exitCode || (typeof result === 'object' && result !== null ? result.exitCode : null);
        const hasError = event.error || details.status === 'failed' || Number(exitCode) > 0;
        const level = hasError ? 'ERROR' : 'DEFAULT';

        const output = typeof result === 'string'
          ? result.slice(0, 4096)
          : sanitizeForLangfuse(truncateObject(result, 20, 3), 4096);

        toolEntry.span.end({
          endTime: new Date(),
          output: level === 'ERROR' ? undefined : output,
          level,
          statusMessage: hasError
            ? sanitizeForLangfuse(String(event.error || details.error || result), 500)
            : undefined,
          metadata: {
            toolName: toolEntry.toolName,
            durationMs: Date.now() - toolEntry.at,
            exitCode: exitCode !== null && exitCode !== undefined ? Number(exitCode) : undefined,
          },
        });

        toolEntry.ended = true;
        ctx.activeTools.delete(toolCallId);
        traceMap.set(sessionKey, ctx);

        langfuse.flushAsync().catch(() => {});
      } catch (err) {
        api.logger.error(`langfuse-tracer: after_tool_call error: ${err.message}`);
      }
    });

    // ─── EVENT: subagent_spawned → Delegation span ─────────────────────────
    api.on('subagent_spawned', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx) return;

        const targetAgent = event.data?.targetAgentId || event.agentId || 'unknown';
        const childSessionKey = event.data?.childSessionKey || event.childSessionKey || '';
        const taskName = event.data?.taskName || event.taskName || '';

        const span = ctx.trace.span({
          id: childSessionKey || `deleg-${Date.now()}`,
          name: `Sub-agent: ${targetAgent}`,
          parentObservationId: ctx.parentSpanId || ctx.span?.id || undefined,
          startTime: new Date(),
          metadata: {
            type: 'delegation',
            targetAgent,
            childSessionKey,
            task: taskName ? sanitizeForLangfuse(taskName, 500) : undefined,
            sourceSessionKey: sessionKey,
          },
          input: taskName ? sanitizeForLangfuse(taskName, 2048) : undefined,
        });

        // Register this child so the sub-agent's session_start can find it
        traceMap.set(childSessionKey, {
          traceId: ctx.traceId,
          trace: ctx.trace,
          parentSpanId: span.id,
          span,
          agentId: targetAgent,
          parentSessionKey: sessionKey,
        });
      } catch (err) {
        api.logger.error(`langfuse-tracer: subagent_spawned error: ${err.message}`);
      }
    });

    // ─── EVENT: subagent_ended → Delegation span end ───────────────────────
    api.on('subagent_ended', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const childSessionKey = event.data?.childSessionKey || event.childSessionKey;
        const ctx = (sessionKey && traceMap.get(sessionKey))
          || (childSessionKey && traceMap.get(childSessionKey))
          || null;
        if (!ctx || !ctx.span) return;

        const status = event.data?.status || event.status || 'success';
        const level = (status === 'error' || status === 'timeout' || status === 'failed') ? 'ERROR' : 'DEFAULT';
        const isFireAndForget = event.data?.timeoutSeconds === 0 || event.timeoutSeconds === 0;

        ctx.span.end({
          endTime: new Date(),
          level,
          statusMessage: level === 'ERROR'
            ? sanitizeForLangfuse(`Sub-agent ended with status: ${status}`, 500)
            : undefined,
          metadata: {
            status,
            isFireAndForget,
            durationMs: event.durationMs || undefined,
          },
        });

        langfuse.flushAsync().catch(() => {});
      } catch (err) {
        api.logger.error(`langfuse-tracer: subagent_ended error: ${err.message}`);
      }
    });

    // ─── EVENT: session_end → Trace finalization ───────────────────────────
    api.on('session_end', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx) return;

        const status = event.data?.status || event.status || 'success';
        const aborted = event.data?.aborted || event.aborted || false;
        const timedOut = event.data?.timedOut || event.timedOut || false;
        const hasError = status === 'error' || status === 'failed' || aborted || timedOut;

        // Update the trace's top-level status
        if (ctx.agentId === 'main' && ctx.trace) {
          ctx.trace.update({
            metadata: {
              ...(ctx.trace.metadata || {}),
              finalStatus: status,
              aborted,
              timedOut,
              durationMs: event.durationMs || undefined,
            },
            tags: hasError ? ['error'] : ['success'],
          });
        }

        // If there's an active span (sub-agent), end it
        if (ctx.span && !ctx.span._ended) {
          ctx.span.end({
            endTime: new Date(),
            level: hasError ? 'ERROR' : 'DEFAULT',
            statusMessage: hasError ? `Session ended with status: ${status}` : undefined,
          });
        }

        // Clean up trace map after a delay (to allow late-arriving events)
        setTimeout(() => traceMap.delete(sessionKey), 60_000);

        // Final flush before possible gateway shutdown
        try { await langfuse.flushAsync(); } catch { /* ignore flush errors on session end */ }
      } catch (err) {
        api.logger.error(`langfuse-tracer: session_end error: ${err.message}`);
      }
    });

    // ─── EVENT: agent_end → Post-hoc analysis hook ─────────────────────────
    api.on('agent_end', async (event) => {
      try {
        const sessionKey = event.sessionKey || event.data?.sessionKey;
        const ctx = sessionKey ? traceMap.get(sessionKey) : null;
        if (!ctx || ctx.agentId !== 'main') return;

        // Final metadata enrichment with completed conversation stats
        const turnCount = event.data?.turnCount || event.turnCount;
        if (turnCount && ctx.trace) {
          ctx.trace.update({
            metadata: {
              ...(ctx.trace.metadata || {}),
              turnCount,
              completedAt: new Date().toISOString(),
            },
          });
        }

        await langfuse.flushAsync();
      } catch (err) {
        api.logger.error(`langfuse-tracer: agent_end error: ${err.message}`);
      }
    });

    // ─── Periodic health flush ─────────────────────────────────────────────
    const flushHandle = setInterval(() => {
      langfuse.flushAsync().catch(() => {});
    }, 10_000);

    // Clean up interval on gateway stop
    api.on('gateway_stop', async () => {
      clearInterval(flushHandle);
    });
  },
});