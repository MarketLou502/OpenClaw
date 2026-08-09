'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SECRET_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential)/i;
const PHONE = /\+?1?[-. (]*\d{3}[-. )]*\d{3}[-. ]*\d{4}/g;
const MAX_SOURCE_CHARS = 16_000;

function normalizeText(value) {
  return String(value || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
}

function redact(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.replace(PHONE, '[REDACTED PHONE]').slice(0, MAX_SOURCE_CHARS);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function timestampOf(record) {
  return Date.parse(record?.timestamp || record?.message?.timestamp || 0) || Number(record?.message?.timestamp || 0) || 0;
}

async function readJsonl(file) {
  const records = [];
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially appended final JSONL line is normal while OpenClaw is running.
    }
  }
  return records;
}

function parseInterSession(text) {
  const firstLine = String(text || '').split('\n', 1)[0];
  if (!firstLine.startsWith('[Inter-session message]')) return null;
  const value = (name) => firstLine.match(new RegExp(`${name}=([^ ]+)`))?.[1] || null;
  return {
    sourceSessionKey: value('sourceSession'),
    sourceChannel: value('sourceChannel'),
    sourceTool: value('sourceTool'),
    payload: String(text || '').split('\n').slice(1).join('\n').trim()
  };
}

function assistantMetadata(message) {
  return {
    provider: message.provider || null,
    model: message.model || null,
    api: message.api || null,
    local: isLocalModel(message.provider, message.model),
    usage: message.usage || null,
    stopReason: message.stopReason || null,
    responseId: message.responseId || null
  };
}

function isLocalModel(provider, model) {
  const candidate = `${provider || ''}/${model || ''}`.toLowerCase();
  return /(^|\/)(ollama|lmstudio|mlx|vllm|local)(\/|$)|localhost|127\.0\.0\.1/.test(candidate);
}

function spanStatus(toolResult) {
  const details = toolResult?.message?.details || {};
  const text = contentText(toolResult?.message?.content);
  if (details.status === 'failed' || Number(details.exitCode) > 0 || /command exited with code [1-9]/i.test(text)) return 'error';
  return 'success';
}

function tryJson(text) {
  const candidates = String(text || '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  for (const candidate of candidates.reverse()) {
    try { return JSON.parse(candidate); } catch { /* keep looking */ }
  }
  return null;
}

// Maps a deterministic router route to the sub-agent that actually handles it.
// The shared-routine-router dispatches to different workflows based on intent;
// this lets the QA Agent Dashboard highlight the correct sub-agent on the network map.
// Board/list/habit operations each go to their own specialist, not the Dashboard API itself.
function routeToAgent(route) {
  switch (route) {
    // Board operations → boards
    case 'dashboard-add':
    case 'dashboard-list':
    case 'dashboard-complete':
    case 'dashboard-complete-any':
    case 'dashboard-remove':
    case 'dashboard-schedule':
    case 'dashboard-reschedule':
    case 'dashboard-unschedule':
      return 'boards';

    // Habit operations → goals
    case 'dashboard-list-habits':
    case 'dashboard-complete-habit':
      return 'goals';

    // Custom list operations → lists
    case 'dashboard-list-lists':
    case 'dashboard-create-list':
    case 'dashboard-add-list-item':
    case 'dashboard-show-list':
    case 'dashboard-complete-list-item':
    case 'dashboard-edit-list-item':
    case 'dashboard-remove-list-item':
    case 'dashboard-rename-list':
    case 'dashboard-delete-list':
      return 'lists';

    // Calendar operations → scheduler
    case 'calendar-add':
    case 'calendar-list':
    case 'calendar-delete':
    case 'calendar-reschedule':
      return 'scheduler';

    // Health operations → health-tracker
    case 'workout-log':
    case 'daily-run-log':
    case 'health-list-today':
    case 'health-activity-today':
    case 'health-correct-food':
    case 'health-remove-food':
    case 'health-undo':
    case 'usda':
    case 'food-log-recipe':
      return 'health-tracker';

    // Finance operations → finance-agent
    case 'finance-balance':
    case 'finance-budget-forecast':
    case 'finance-add-expense':
      return 'finance-agent';

    // Meal planner operations → meal-planner
    case 'meal-planner-get-plan':
    case 'meal-planner-list-recipes':
    case 'meal-planner-find-recipe':
    case 'meal-planner-confirm-plan':
    case 'meal-planner-assemble-plan':
    case 'meal-planner-add-plan-item':
      return 'meal-planner';

    case 'nevermind-cancel':
      return null; // no agent was dispatched

    default:
      return null;
  }
}

function toolSuspicion(toolName, resultText) {
  const parsed = tryJson(resultText);
  if (!parsed) return null;
  if (parsed.ok === true && parsed.dashboard?.attempted === true && parsed.dashboard?.ok === true) {
    const expectedFlags = parsed.operation === 'log-daily-run' ? ['runGoalUpdated']
      : parsed.operation === 'log-workout' ? ['healthUpdated']
      : [];
    const updateFlags = expectedFlags.filter((key) => parsed.dashboard[key] === false);
    if (updateFlags.length) {
      return {
        severity: 'warning',
        code: 'NO_VISIBLE_PROJECTION_UPDATE',
        title: 'Mutation succeeded, but dashboard projection did not update',
        detail: `${toolName} returned success while ${updateFlags.join(', ')} remained false.`
      };
    }
  }
  if (parsed.ok === false) {
    return {
      severity: 'error',
      code: parsed.error?.code || 'TOOL_REPORTED_FAILURE',
      title: parsed.error?.message || `${toolName} reported a failure`,
      detail: 'The tool returned a structured failure result.'
    };
  }
  return null;
}

class TraceStore {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxFiles = options.maxFiles || 350;
    this.cacheTtlMs = options.cacheTtlMs || 2_000;
    this._cache = null;
    this._cacheAt = 0;
  }

  async snapshot(force = false) {
    if (!force && this._cache && Date.now() - this._cacheAt < this.cacheTtlMs) return this._cache;
    const sessions = await this.loadSessions();
    const requests = this.buildRequests(sessions);
    // Merge voice fast-path requests (deterministic router, no Main session)
    const fastpathRequests = await this.loadVoiceFastpath();
    // Merge dashboard mutation events (kiosk-originated data changes)
    const dashboardMutations = await this.loadDashboardMutations();
    const all = [...requests, ...fastpathRequests, ...dashboardMutations];
    all.sort((a, b) => b.startedAtMs - a.startedAtMs);
    this._cache = { generatedAt: new Date().toISOString(), sessions, requests: all };
    this._cacheAt = Date.now();
    return this._cache;
  }

  sessionFiles() {
    const agentsDir = path.join(this.rootDir, 'agents');
    if (!fs.existsSync(agentsDir)) return [];
    const grouped = new Map();
    for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const dir = path.join(agentsDir, agent.name, 'sessions');
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.endsWith('.trajectory.jsonl')) continue;
        const match = entry.name.match(/^([0-9a-f-]+)\.jsonl(?:\.reset\..+)?$/i);
        if (!match) continue;
        const file = path.join(dir, entry.name);
        const stat = fs.statSync(file);
        const sessionId = match[1];
        const key = `${agent.name}:${sessionId}`;
        const candidate = { file, agentId: agent.name, sessionId, mtimeMs: stat.mtimeMs, archived: entry.name.includes('.jsonl.reset.') };
        const prior = grouped.get(key);
        // Prefer an active transcript; otherwise use the newest compacted/reset
        // transcript so historical investigations remain discoverable.
        if (!prior || (prior.archived && !candidate.archived) || (prior.archived === candidate.archived && candidate.mtimeMs > prior.mtimeMs)) grouped.set(key, candidate);
      }
    }
    return [...grouped.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.maxFiles);
  }

  async loadSessions() {
    const files = this.sessionFiles();
    return Promise.all(files.map(async (meta) => {
      const records = await readJsonl(meta.file);
      const trajectoryFile = path.join(path.dirname(meta.file), `${meta.sessionId}.trajectory.jsonl`);
      const trajectory = fs.existsSync(trajectoryFile) ? await readJsonl(trajectoryFile) : [];
      const started = trajectory.find((event) => event.type === 'session.started');
      return {
        ...meta,
        relativeFile: path.relative(this.rootDir, meta.file),
        sessionKey: started?.sessionKey || null,
        channel: started?.data?.messageChannel || started?.data?.messageProvider || null,
        records,
        trajectory
      };
    }));
  }

  async loadVoiceFastpath() {
    const fpFile = path.join(this.rootDir, 'logs', 'voice-fastpath.jsonl');
    if (!fs.existsSync(fpFile)) return [];
    try {
      const records = await readJsonl(fpFile);
      return records.map((entry, i) => {
        const ts = Number(entry.timestamp) || 0;
        const startedAtMs = ts;
        const id = `voice-fastpath:${i}:${ts}`;
        const spanId = `span:${id}:input`;
        const text = String(entry.request || '');
        // A request that reached the router but died mid-pipeline (grammar
        // matched, then a slot failed to parse, etc.) is logged as
        // 'router-unhandled' — see project-calendar-period-time-separator-bug-2026-08-08.
        // Surface that as a failed span instead of the old always-'success'
        // status, which could only ever represent requests that worked.
        const routerFailed = entry.route === 'router-unhandled';
        // Use entry.intent (e.g. 'dashboard-list') to determine the sub-agent, not
        // entry.route which is the literal string 'router' (the component name).
        const mappedAgent = !routerFailed ? routeToAgent(entry.intent) : null;
        const agents = mappedAgent
          ? ['shared-routine-router', mappedAgent]
          : ['shared-routine-router'];
        const stages = Array.isArray(entry.stages) ? entry.stages : [];
        // Build a separate tool-call span so the network map can highlight
        // the sub-agent node that owns the workflow being invoked directly
        // by the Routine Router. Includes the workflow script name and the
        // reply text so the inspector panel shows what tool was called.
        const spans = [{
          id: spanId,
          parentId: null,
          kind: 'input',
          title: 'Voice fast path',
          subtitle: routerFailed
            ? `unhandled / ${stages[stages.length - 1]?.stage || 'unknown stage'}`
            : `${entry.route || 'router'} / ${entry.intent || 'unknown'}`,
          status: routerFailed ? 'failed' : 'success',
          startedAt: new Date(startedAtMs).toISOString(),
          durationMs: 0,
          agentId: 'shared-routine-router',
          evidence: {
            text, channel: 'voice', intent: entry.intent, route: entry.route,
            reply: entry.reply, deviceSlug: entry.deviceSlug, stages,
          }
        }];
        // Add a tool-call span for the sub-agent that owns the workflow,
        // so highlightNetworkPath() on the frontend can find its node.
        if (mappedAgent) {
          const toolSpanId = `span:${id}:tool:${mappedAgent}`;
          const scriptName = entry.intent && entry.intent.startsWith('dashboard-')
            ? 'dashboard-workflow.js'
            : entry.intent && entry.intent.startsWith('calendar-')
            ? 'calendar-workflow.js'
            : entry.intent && entry.intent.startsWith('finance-')
            ? 'finance-workflow.js'
            : entry.intent && entry.intent.startsWith('meal-planner-')
            ? 'meal-planner-workflow.js'
            : entry.intent && ['workout-log', 'daily-run-log', 'health-list-today', 'health-activity-today', 'health-correct-food', 'health-remove-food', 'health-undo', 'usda'].includes(entry.intent)
            ? 'health-workflow.js'
            : 'workflow.js';
          spans.push({
            id: toolSpanId,
            parentId: spanId,
            kind: 'tool',
            title: mappedAgent,
            subtitle: scriptName,
            status: 'success',
            startedAt: new Date(startedAtMs).toISOString(),
            durationMs: 0,
            agentId: mappedAgent,
            toolName: scriptName,
            evidence: {
              intent: entry.intent,
              route: entry.route,
              reply: entry.reply || null,
              result: entry.reply || null,
              script: scriptName
            }
          });
        }
        return {
          id,
          text,
          startedAt: new Date(startedAtMs).toISOString(),
          startedAtMs,
          durationMs: 0,
          channel: 'voice-fastpath',
          rootAgent: 'shared-routine-router',
          status: routerFailed ? 'failed' : 'success',
          agents,
          models: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
          toolCount: mappedAgent ? 2 : 1,
          notices: [],
          firstSuspiciousSpanId: null,
          spans,
          links: []
        };
      });
    } catch { return []; }
  }

  async loadDashboardMutations() {
    const mutFile = path.join(this.rootDir, 'logs', 'dashboard-mutations.jsonl');
    if (!fs.existsSync(mutFile)) return [];
    try {
      const records = await readJsonl(mutFile);
      return records.map((entry, i) => {
        const ts = Number(entry.timestamp) || 0;
        const startedAtMs = ts;
        const id = `dashboard:${i}:${ts}`;
        const spanId = `span:${id}:input`;
        const text = String(entry.summary || entry.path || '');
        const isError = entry.status === 'error';
        return {
          id,
          text,
          startedAt: new Date(startedAtMs).toISOString(),
          startedAtMs,
          durationMs: 0,
          channel: 'kiosk',
          rootAgent: 'dashboard-api',
          status: isError ? 'error' : 'success',
          agents: ['dashboard-api'],
          models: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
          toolCount: 1,
          notices: isError ? [{ spanId, severity: 'error', code: 'MUTATION_ERROR', title: entry.error || 'Dashboard mutation failed', detail: entry.summary }] : [],
          firstSuspiciousSpanId: isError ? spanId : null,
          spans: [{
            id: spanId,
            parentId: null,
            kind: 'input',
            title: entry.resource ? `Kiosk: ${entry.resource}` : 'Kiosk mutation',
            subtitle: `${entry.method || 'UNKNOWN'} ${entry.path || ''}`,
            status: isError ? 'error' : 'success',
            startedAt: new Date(startedAtMs).toISOString(),
            durationMs: 0,
            agentId: 'dashboard-api',
            notice: isError ? { severity: 'error', code: 'MUTATION_ERROR', title: entry.error || 'Error', detail: entry.summary } : null,
            evidence: { text, method: entry.method, path: entry.path, resource: entry.resource, error: entry.error || null }
          }],
          links: []
        };
      });
    } catch { return []; }
  }

  buildRequests(sessions) {
    const requests = [];
    for (const session of sessions) {
      for (let index = 0; index < session.records.length; index += 1) {
        const record = session.records[index];
        const message = record?.message;
        if (record.type !== 'message' || message?.role !== 'user') continue;
        const text = contentText(message.content);
        if (!text || parseInterSession(text)) continue;
        const end = this.nextOwnerMessage(session.records, index + 1);
        const request = this.makeRequest(session, record, index, end, sessions);
        requests.push(request);
      }
    }
    return requests.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  nextOwnerMessage(records, start) {
    for (let index = start; index < records.length; index += 1) {
      const record = records[index];
      if (record?.type !== 'message' || record?.message?.role !== 'user') continue;
      if (!parseInterSession(contentText(record.message.content))) return index;
    }
    return records.length;
  }

  nextUserMessage(records, start) {
    for (let index = start; index < records.length; index += 1) {
      if (records[index]?.type === 'message' && records[index]?.message?.role === 'user') return index;
    }
    return records.length;
  }

  makeRequest(session, record, start, end, sessions) {
    const text = contentText(record.message.content);
    const startedAtMs = timestampOf(record);
    const id = `${session.agentId}:${session.sessionId}:${record.id || startedAtMs}`;
    const root = {
      id: `span:${id}:input`,
      parentId: null,
      kind: 'input',
      title: 'Request received',
      subtitle: session.channel || session.sessionKey || session.agentId,
      status: 'success',
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: 0,
      agentId: session.agentId,
      evidence: redact({ text, channel: session.channel, sessionKey: session.sessionKey, messageId: record.id, sourceFile: session.relativeFile })
    };
    const spans = [root];
    const links = [];
    const delegateCalls = [];
    this.appendConversationSpans({ session, records: session.records.slice(start + 1, end), parentId: root.id, spans, delegateCalls });

    for (const call of delegateCalls) {
      const child = this.findChildSession(call, session, sessions);
      if (!child) {
        call.span.status = call.span.status === 'error' ? 'error' : 'warning';
        call.span.notice = { severity: 'warning', code: 'UNRESOLVED_DELEGATION', title: 'Delegated session could not be correlated', detail: 'No matching inter-session provenance record was found.' };
        continue;
      }
      const childRecords = child.session.records.slice(child.index + 1, this.nextUserMessage(child.session.records, child.index + 1));
      const childRootId = `span:${id}:agent:${child.session.agentId}:${child.record.id || child.index}`;
      spans.push({
        id: childRootId,
        parentId: call.span.id,
        kind: 'agent',
        title: child.session.agentId,
        subtitle: 'Delegated agent session',
        status: 'success',
        startedAt: new Date(timestampOf(child.record)).toISOString(),
        durationMs: 0,
        agentId: child.session.agentId,
        confidence: child.confidence,
        evidence: redact({ provenance: child.provenance, sessionKey: child.session.sessionKey, sessionId: child.session.sessionId, sourceFile: child.session.relativeFile })
      });
      links.push({ from: call.span.id, to: childRootId, confidence: child.confidence, reason: child.reason });
      const nestedDelegates = [];
      this.appendConversationSpans({ session: child.session, records: childRecords, parentId: childRootId, spans, delegateCalls: nestedDelegates });
    }

    const notices = spans.filter((span) => span.notice).map((span) => ({ spanId: span.id, ...span.notice }));
    const endedAtMs = Math.max(startedAtMs, ...spans.map((span) => Date.parse(span.startedAt) + (span.durationMs || 0)).filter(Number.isFinite));
    const agents = [...new Set(spans.map((span) => span.agentId).filter(Boolean))];
    const models = [...new Map(spans.filter((span) => span.model).map((span) => [`${span.provider}/${span.model}`, { provider: span.provider, model: span.model, local: span.local }])).values()];
    const tools = spans.filter((span) => span.kind === 'tool');
    const modelSpans = spans.filter((span) => span.kind === 'model');
    const usage = modelSpans.reduce((total, span) => {
      const item = span.usage || {};
      total.input += Number(item.input || 0);
      total.output += Number(item.output || 0);
      total.cacheRead += Number(item.cacheRead || 0);
      total.cacheWrite += Number(item.cacheWrite || 0);
      total.reasoning += Number(item.reasoningTokens || 0);
      total.totalTokens += Number(item.totalTokens ?? item.total ?? 0);
      total.cost += Number(item.cost?.total || 0);
      return total;
    }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 });
    return {
      id,
      text: redact(text),
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      channel: session.channel || 'unknown',
      rootAgent: session.agentId,
      status: notices.some((notice) => notice.severity === 'error') ? 'error' : notices.length ? 'warning' : 'success',
      agents,
      models,
      usage,
      toolCount: tools.length,
      notices,
      firstSuspiciousSpanId: notices[0]?.spanId || null,
      spans,
      links
    };
  }

  appendConversationSpans({ session, records, parentId, spans, delegateCalls }) {
    const toolCalls = new Map();
    let lastParent = parentId;
    for (const record of records) {
      const message = record?.message;
      if (record.type !== 'message' || !message) continue;
      const at = timestampOf(record);
      if (message.role === 'assistant') {
        const metadata = assistantMetadata(message);
        const modelSpanId = `span:${session.sessionId}:${record.id || at}:model`;
        spans.push({
          id: modelSpanId,
          parentId: lastParent,
          kind: 'model',
          title: metadata.local ? 'Local model response' : 'Remote model response',
          subtitle: `${metadata.provider || 'unknown'} / ${metadata.model || 'unknown'}`,
          status: message.stopReason === 'error' ? 'error' : 'success',
          startedAt: new Date(at).toISOString(),
          durationMs: 0,
          agentId: session.agentId,
          ...metadata,
          evidence: redact({ text: contentText(message.content), stopReason: message.stopReason, responseId: message.responseId, usage: message.usage, sourceFile: session.relativeFile })
        });
        lastParent = modelSpanId;
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part?.type !== 'toolCall') continue;
          const spanId = `span:${session.sessionId}:${part.id}:tool`;
          const span = {
            id: spanId,
            parentId: modelSpanId,
            kind: part.name === 'sessions_send' ? 'delegation' : 'tool',
            title: part.name === 'sessions_send' ? `Delegate to ${part.arguments?.agentId || 'agent'}` : part.name,
            subtitle: part.arguments?.command ? String(part.arguments.command).split('\n')[0].slice(0, 130) : 'Tool call',
            status: 'running',
            startedAt: new Date(at).toISOString(),
            durationMs: 0,
            agentId: session.agentId,
            toolName: part.name,
            evidence: redact({ arguments: part.arguments, toolCallId: part.id, sourceFile: session.relativeFile })
          };
          spans.push(span);
          toolCalls.set(part.id, { span, at, part });
          if (part.name === 'sessions_send') delegateCalls.push({ span, part, at });
        }
      }
      if (message.role === 'toolResult') {
        const call = toolCalls.get(message.toolCallId);
        if (!call) continue;
        const resultText = contentText(message.content);
        call.span.status = spanStatus(record);
        call.span.durationMs = Math.max(0, at - call.at);
        call.span.evidence.result = redact(resultText);
        call.span.evidence.details = redact(message.details || null);
        call.span.notice = toolSuspicion(message.toolName || call.span.toolName, resultText);
      }
    }
    for (const call of toolCalls.values()) {
      if (call.span.status === 'running') call.span.status = 'unknown';
    }
  }

  findChildSession(call, parentSession, sessions) {
    const targetAgent = call.part.arguments?.agentId;
    const targetMessage = normalizeText(call.part.arguments?.message);
    let best = null;
    for (const session of sessions) {
      if (targetAgent && session.agentId !== targetAgent) continue;
      for (let index = 0; index < session.records.length; index += 1) {
        const record = session.records[index];
        if (record?.type !== 'message' || record?.message?.role !== 'user') continue;
        const inter = parseInterSession(contentText(record.message.content));
        if (!inter) continue;
        const provenanceSource = record.message.provenance?.sourceSessionKey || inter.sourceSessionKey;
        const messageMatches = targetMessage && normalizeText(inter.payload) === targetMessage;
        const sourceMatches = parentSession.sessionKey && provenanceSource === parentSession.sessionKey;
        const delta = Math.abs(timestampOf(record) - call.at);
        if (delta > 5 * 60_000) continue;
        const score = (sourceMatches ? 100 : 0) + (messageMatches ? 50 : 0) - delta / 1000;
        if (!best || score > best.score) {
          best = {
            score,
            session,
            record,
            index,
            provenance: record.message.provenance || inter,
            confidence: sourceMatches && messageMatches ? 'exact' : sourceMatches ? 'high' : 'heuristic',
            reason: sourceMatches && messageMatches ? 'Inter-session provenance and delegated message matched.' : sourceMatches ? 'Inter-session source session matched.' : 'Agent, message, and timestamp were heuristically matched.'
          };
        }
      }
    }
    return best;
  }

  async listRequests(filters = {}) {
    const snapshot = await this.snapshot();
    const query = normalizeText(filters.query);
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    return snapshot.requests
      .filter((request) => !query || normalizeText(request.text).includes(query))
      .filter((request) => !filters.status || request.status === filters.status)
      .filter((request) => !filters.agent || request.agents.includes(filters.agent))
      .slice(0, limit)
      .map(({ spans, links, startedAtMs, ...summary }) => summary);
  }

  async getRequest(id) {
    const snapshot = await this.snapshot();
    return snapshot.requests.find((request) => request.id === id) || null;
  }
}

module.exports = { TraceStore, normalizeText, parseInterSession, redact, toolSuspicion, isLocalModel, routeToAgent };
