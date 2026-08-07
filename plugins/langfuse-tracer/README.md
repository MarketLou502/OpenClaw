# Langfuse Tracer — OpenClaw Observability Plugin

Real-time execution tracing for OpenClaw using [Langfuse](https://langfuse.com).

## How it works

Every user request to the Chief of Staff (Main) agent creates a **Langfuse Trace** with a hierarchy of spans:

```
User Request (Trace)
 ├── Chief of Staff session
 │   ├── LLM Generation (model_call_started/ended)
 │   ├── Tool: sessions_send → scheduler (Span)
 │   ├── Tool: log-food (Span)
 │   └── ...
 ├── Sub-agent: health-tracker (Span)
 │   ├── LLM Generation
 │   ├── Tool: nutrition-lookup (Span)
 │   └── ...
 └── Sub-agent: systems-qa (Span, fire-and-forget on error)
     └── ...
```

### Hook mapping

| OpenClaw Hook | Langfuse Concept |
|---|---|
| `session_start` (agentId === 'main') | **Trace** (root) |
| `session_start` (sub-agent) | **Span** (child of parent trace) |
| `model_call_started` / `model_call_ended` | **Generation** (LLM input/output) |
| `before_tool_call` / `after_tool_call` | **Span** (tool execution; ERROR level on failure) |
| `subagent_spawned` / `subagent_ended` | **Span** (delegation; ERROR for timeouts) |
| `session_end` | Trace metadata update + flush |

## Setup

### 1. Environment variables

Add to your `.env` or shell profile:

```bash
export LANGFUSE_PUBLIC_KEY="pk-..."
export LANGFUSE_SECRET_KEY="sk-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # or http://localhost:3000 for local
```

### 2. Plugin registration

Already configured in `openclaw.json` under `plugins.load.paths`.

### 3. Verify

Check the Gateway logs for:
```
langfuse-tracer: active — tracing to https://cloud.langfuse.com
```

## Local Langfuse (optional)

Run Langfuse locally with Docker for fully offline operation:

```bash
docker run -d -p 3000:3000 \
  -e LANGFUSE_PUBLIC_KEY=pk-lf-... \
  -e LANGFUSE_SECRET_KEY=sk-lf-... \
  langfuse/langfuse
```

Then set `LANGFUSE_BASE_URL=http://localhost:3000`.

## Non-blocking design

All Langfuse SDK calls are fire-and-forget from the Gateway's perspective:
- `await` is only used for the final `flushAsync()` on `session_end` / `gateway_stop`
- `flushAsync()` calls are never `await`ed during hooks
- Periodic flush every 10 seconds in the background
- The plugin uses the in-memory `traceMap` for O(1) trace context propagation across `sessions_send` boundaries