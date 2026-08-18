'use strict';

const state = {
  requests: [], trace: null,
  selectedRequestId: null, selectedSpanId: null,
  status: '', query: '',
  netZoom: 1,
  netPan: { x: 0, y: 0 },
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);
const duration = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s` : `${Math.round(ms || 0)}ms`;
const money = (value) => value >= .01 ? `$${value.toFixed(3)}` : value > 0 ? `$${value.toFixed(6)}` : '$0';
const number = (value) => new Intl.NumberFormat([], { notation: value >= 100000 ? 'compact' : 'standard', maxFractionDigits: 1 }).format(value || 0);
const dateTime = (date) => new Intl.DateTimeFormat([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).format(new Date(date));

const KIND_ICON = { input:'IN', model:'M', tool:'⚙', delegation:'↗', agent:'A' };
const KIND_LABEL = { input:'Input', model:'LLM', tool:'Tool', delegation:'Delegation', agent:'Agent' };

// ─── Custom SVG network topology ─────────────────────────────────────────────
// Nodes: id, label, x, y (percentage of SVG w/h), group, icon, detail
const NETWORK_NODES_DATA = [
  // Row 1 — Inputs
  { id:'phone',    label:'iMessage',      x:12, y:6,  group:'input',    icon:'💬', detail:'iMessage via imsg CLI' },
  { id:'voice',    label:'Jarvis', x:33, y:6,  group:'input',    icon:'🎤', detail:'Home Assistant Voice PE' },
  { id:'kiosk',    label:'Kiosk',         x:58, y:6,  group:'input',    icon:'🖥️', detail:'Echo Show dashboard → Dashboard API' },
  { id:'cron',     label:'Cron / System', x:82, y:6,  group:'input',    icon:'⏰', detail:'Scheduled jobs, heartbeats' },

  // Row 2 — Processing
  { id:'router',   label:'Routine Router', x:15, y:22, group:'process',  icon:'🔀', detail:'Deterministic intent router — iMessage & Voice, plugin inside Gateway' },
  { id:'dashapi',  label:'Dashboard API',  x:82, y:22, group:'process',  icon:'📊', detail:'Port 18795 — data mutation endpoint' },

  // Row 3 — Main (Chief of Staff)
  { id:'main',     label:'Main',           x:38, y:47, group:'agent',   icon:'🧠', detail:'main agent — owns conversations, delegates tasks' },

  // Row 4 — Sub-agents (spread across)
  // 'tracker' merged from three former agents (scheduler+boards+goals) on
  // 2026-08-10 — see plans/TaskTracker_Unified_Agent_Design.md. Node id kept
  // as 'tracker' (not 'sched'/'boards'/'goals') since it now represents a
  // distinct merged identity, not a rename of any one predecessor.
  { id:'tracker',  label:'Task Tracker',   x:8,  y:64, group:'subagent',icon:'🗂️', detail:'Calendar, task boards + due dates, daily habits — DeepSeek via OpenRouter' },
  { id:'health',   label:'health-tracker', x:26, y:64, group:'subagent',icon:'❤️', detail:'Food logging, nutrition — DeepSeek via OpenRouter' },
  { id:'lists',    label:'lists',          x:44, y:64, group:'subagent',icon:'📝', detail:'Custom lists — local Ollama' },
  { id:'meal',     label:'meal-planner',   x:62, y:64, group:'subagent',icon:'🍽️', detail:'Meals & grocery — DeepSeek via OpenRouter' },
  { id:'finance',  label:'finance-agent',  x:80, y:64, group:'subagent',icon:'💰', detail:'Finance queries — local Ollama' },
  { id:'research', label:'research',       x:13, y:78, group:'subagent',icon:'🔍', detail:'Web search Q&A — DeepSeek via OpenRouter' },
  { id:'systemsqa',label:'systems-qa',     x:30, y:78, group:'subagent',icon:'🔧', detail:'Diagnostics — local Ollama, fire-and-forget' },

  // Row 5 — Models / Storage
  { id:'openrouter',label:'OpenRouter',    x:38, y:90, group:'storage', icon:'☁️', detail:'Cloud frontier models — Haiku, DeepSeek' },
  { id:'json',     label:'JSON Files',     x:75, y:90, group:'storage', icon:'📁', detail:'Task boards, habits, grocery, lists' },
  { id:'financedb',label:'finance.db',     x:90, y:90, group:'storage', icon:'💾', detail:'SQLite — transactions, expenses, budgets' },
  { id:'plaid',    label:'Plaid API',       x:55, y:90, group:'storage', icon:'🏦', detail:'External banking API — Plaid Link, transactions, balances, webhooks' },
];

// Edges: [fromId, toId, label]
const NETWORK_EDGES = [
  // ─── Inputs → Router / Main ──────────────────────────────────────────
  // iMessage, Jarvis, and Cron all feed into the Routine Router (a plugin
  // inside the Gateway framework). If the router matches, it handles the
  // intent directly (fast path). If not, the message falls through to Main.
  ['phone',   'router',   'iMessage'],
  ['voice',   'router',   'Jarvis'],
  ['cron',    'router',   'heartbeat'],
  ['router',  'main',     'fallback'],
  ['kiosk',   'dashapi',  'HTTP bearer'],
  ['main',    'tracker',  'sessions_send'],
  ['main',    'health',   'sessions_send'],
  ['main',    'lists',    'sessions_send'],
  ['main',    'meal',     'sessions_send'],
  ['main',    'finance',  'sessions_send'],
  ['main',    'research', 'sessions_send'],
  ['main',    'systemsqa','fire-and-forget'],
  ['main',    'openrouter','primary model'],

  ['router',  'health',   'route intent'],
  ['router',  'tracker',  'route intent'],
  ['router',  'lists',    'route intent'],
  ['router',  'finance',  'route intent'],
  ['router',  'meal',     'route intent'],

  ['health',  'dashapi',  'sync'],
  ['tracker', 'dashapi',  'sync'],
  ['lists',   'dashapi',  'sync'],
  ['meal',    'dashapi',  'sync'],
  ['finance', 'financedb','SQLite'],
  ['dashapi',  'json',    'read/write'],
  ['dashapi',  'financedb','read'],
  ['plaid',   'financedb','webhook'],
];

// Map channel/agent IDs to node IDs for highlighting
const CHANNEL_TO_NODE = {
  imessage:         ['phone', 'router'],
  'voice-fastpath': ['voice', 'router'],
  voice:            ['voice', 'router', 'main'],
  kiosk:            ['kiosk', 'dashapi'],
  heartbeat:        ['cron', 'router'],
};

const AGENT_TO_NODE = {
  'task-tracker':       ['tracker'],
  'health-tracker':     ['health'],
  lists:                ['lists'],
  'meal-planner':       ['meal'],
  'finance-agent':      ['finance'],
  research:             ['research'],
  'systems-qa':         ['systemsqa'],
  'shared-routine-router': ['router'],
  'dashboard-api':       ['dashapi'],
  main:                 ['main'],
};

// Maps a deterministic router route to the sub-agent that handles it.
// Calendar/board/habit operations all go to task-tracker (merged
// 2026-08-10 from three former specialists — scheduler/boards/goals); list
// operations go to their own specialist, not the Dashboard API itself —
// that's the data service, not the agent.
function routeToAgent(route) {
  switch (route) {
    // Board, habit, and calendar operations → task-tracker
    case 'dashboard-add':
    case 'dashboard-list':
    case 'dashboard-complete':
    case 'dashboard-complete-any':
    case 'dashboard-remove':
    case 'dashboard-schedule':
    case 'dashboard-reschedule':
    case 'dashboard-unschedule':
    case 'dashboard-list-habits':
    case 'dashboard-complete-habit':
    case 'calendar-add':
    case 'calendar-list':
    case 'calendar-delete':
    case 'calendar-reschedule':
      return 'task-tracker';

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

    // Health operations → health-tracker
    case 'workout-log':
    case 'daily-run-log':
    case 'health-list-today':
    case 'health-activity-today':
    case 'health-correct-food':
    case 'health-remove-food':
    case 'health-undo':
    case 'usda':
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

// Reverse mapping: node ID → agent ID(s) for trace span filtering
const NODE_TO_AGENT_IDS = {};
for (const [agentId, nodeIds] of Object.entries(AGENT_TO_NODE)) {
  for (const nodeId of nodeIds) {
    if (!NODE_TO_AGENT_IDS[nodeId]) NODE_TO_AGENT_IDS[nodeId] = [];
    NODE_TO_AGENT_IDS[nodeId].push(agentId);
  }
}
// Also map a few special node IDs that don't have direct agent mappings
NODE_TO_AGENT_IDS['dashapi'] = ['dashboard-api'];
NODE_TO_AGENT_IDS['openrouter'] = ['openrouter'];
NODE_TO_AGENT_IDS['phone'] = ['imessage'];
NODE_TO_AGENT_IDS['voice'] = ['voice'];
NODE_TO_AGENT_IDS['kiosk'] = ['kiosk'];
NODE_TO_AGENT_IDS['cron'] = ['cron'];

// ─── API helper ──────────────────────────────────────────────────────────────

async function api(path) {
  const r = await fetch(path, { cache:'no-store' });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error || 'Request failed');
  return b;
}

// ─── Request list ─────────────────────────────────────────────────────────────

// Static router decision-tree reference (see lib/router-tree.js) — fetched
// once since it only changes when the router's grammar/delegation files do.
let routerTreeData = null;
async function loadRouterTree() {
  try {
    const body = await api('/api/router-tree');
    routerTreeData = body.tree;
  } catch {
    routerTreeData = null;
  }
}

async function loadRequests() {
  $('requestList').innerHTML = '<div class="loading">Reading OpenClaw evidence…</div>';
  const params = new URLSearchParams({ limit:'200' });
  if (state.query) params.set('query', state.query);
  if (state.status) params.set('status', state.status);
  try {
    const body = await api(`/api/requests?${params}`);
    // Kiosk (Echo Show → Dashboard API) traffic is high-volume, low-signal
    // noise for this list — Aaron wants the left column scoped to what he
    // actually said or typed (voice/HA, iMessage) plus cron/system jobs,
    // not every dashboard sync ping. Filtered client-side rather than at
    // the API so the raw evidence stays queryable elsewhere if needed.
    state.requests = body.requests.filter(r => r.channel !== 'kiosk');
    renderRequests();
    if (!state.selectedRequestId) {
      const first = state.requests[0];
      if (first) await selectRequest(first.id);
    }
  } catch (e) {
    $('requestList').innerHTML = `<div class="no-results">${escapeHtml(e.message)}</div>`;
  }
}

function renderRequests() {
  if (!state.requests.length) return $('requestList').innerHTML = '<div class="no-results">No matching requests found.</div>';
  $('requestList').innerHTML = state.requests.map(r => `
    <button class="request-card ${r.id === state.selectedRequestId ? 'active' : ''}" data-request-id="${escapeHtml(r.id)}">
      <span class="request-meta"><span>${escapeHtml(r.channel)}</span><time>${escapeHtml(dateTime(r.startedAt))}</time></span>
      <div class="request-text">${escapeHtml(r.text)}</div>
      <div class="request-bottom"><span class="request-agents"><i class="status-dot ${escapeHtml(r.status)}"></i>${escapeHtml(r.agents.join(' → '))}</span><span>${r.toolCount} tools</span></div>
    </button>`).join('');
  document.querySelectorAll('[data-request-id]').forEach(b => b.addEventListener('click', () => selectRequest(b.dataset.requestId)));
}

// ─── Select & load trace ──────────────────────────────────────────────────────

async function selectRequest(id) {
  try {
    state.selectedRequestId = id;
    state.selectedSpanId = null;
    renderRequests();
    $('emptyState').style.display = 'none';
    $('traceContent').hidden = false;

    const traceBody = await api(`/api/requests/${encodeURIComponent(id)}`);
    state.trace = traceBody.trace;
    renderTrace();
    renderNetworkMap();
  } catch (e) {
    $('networkMapContainer').innerHTML = `<div class="no-results">Failed to load trace: ${escapeHtml(e.message)}</div>`;
  }
}

// ─── Flat path view ───────────────────────────────────────────────────────────

function renderTrace() {
  const trace = state.trace;
  if (!trace) return;
  $('traceTimestamp').textContent = `${trace.channel} · ${dateTime(trace.startedAt)}`;
  $('traceTitle').textContent = trace.text;
  $('traceStatus').className = `status-pill ${trace.status}`;
  $('traceStatus').textContent = trace.status === 'warning' ? 'Needs attention' : trace.status;
  const remote = trace.models.filter(m => !m.local);
  const local = trace.models.filter(m => m.local);
  $('summaryGrid').innerHTML = [
    ['Duration', duration(trace.durationMs)],
    ['Agents', trace.agents.join(' → ') || '—'],
    ['Cost', money(trace.usage.cost)],
    ['Tokens', number(trace.usage.totalTokens)],
    ['Tool calls', trace.toolCount],
    ['Models', (remote.length + local.length) ? `${remote.length} remote + ${local.length} local` : '—']
  ].map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  const first = trace.notices[0];
  $('findingBanner').hidden = !first;
  if (first) $('findingBanner').innerHTML = `<strong>First suspicious boundary</strong>${escapeHtml(first.title)}`;

  if (trace.firstSuspiciousSpanId) {
    selectSpan(trace.firstSuspiciousSpanId);
  }
}

// ─── Custom SVG Network Map ──────────────────────────────────────────────────

function renderNetworkMap() {
  const container = $('networkMapContainer');
  if (!container) return;

  // The canvas fills the container exactly — no fixed aspect ratio — so the
  // draggable/pannable area always matches the visible box, edge to edge.
  const w = container.clientWidth || 960;
  const h = container.clientHeight || 580;
  const pad = 0; // no internal padding — map fills the full viewBox

  const toSvg = (pct) => pad + (pct / 100) * (w - 2 * pad);
  const toSvgY = (pct) => pad + (pct / 100) * (h - 2 * pad);

  // Build node map
  const nodeMap = {};
  for (const n of NETWORK_NODES_DATA) {
    n.cx = toSvg(n.x);
    n.cy = toSvgY(n.y);
    nodeMap[n.id] = n;
  }

  // Group colors
  const groupColors = {
    input:    { fill:'rgba(185,194,199,0.12)', stroke:'#4C5A61', text:'#B9C2C7' },
    process:  { fill:'rgba(201,211,238,0.10)', stroke:'#33468A', text:'#C9D3EE' },
    agent:    { fill:'rgba(201,211,238,0.15)', stroke:'#33468A', text:'#C9D3EE' },
    subagent: { fill:'rgba(201,211,238,0.07)', stroke:'#33468A', text:'#a0b0d0' },
    storage:  { fill:'rgba(195,228,225,0.10)', stroke:'#1F6F69', text:'#C3E4E1' },
  };

  // Compute edge paths (simple bezier curves)
  const edgeLines = [];
  for (const [from, to, label] of NETWORK_EDGES) {
    const f = nodeMap[from], t = nodeMap[to];
    if (!f || !t) continue;

    // Control points for curve: midpoint with vertical offset
    const mx = (f.cx + t.cx) / 2;
    const my = (f.cy + t.cy) / 2;
    const dx = t.cx - f.cx, dy = t.cy - f.cy;
    const cpx = mx, cpy = my - Math.abs(dy) * 0.15; // slight arc upward

    const d = `M${f.cx},${f.cy} Q${cpx},${cpy} ${t.cx},${t.cy}`;
    edgeLines.push({ from, to, d, label, id: `${from}-${to}` });
  }

  // Dimension nodes by their visual weight
  const nodeSize = (n) => {
    if (n.id === 'main') return { rw: 130, rh: 32, fs: 12 };
    if (n.group === 'input' || n.group === 'storage') return { rw: 90, rh: 26, fs: 11 };
    if (n.group === 'process') return { rw: 100, rh: 26, fs: 11 };
    return { rw: 76, rh: 22, fs: 10 };
  };

  // Build SVG markup
  const edgesSvg = edgeLines.map(e =>
    `<path id="edge-${e.id}" class="net-edge" d="${e.d}" data-from="${e.from}" data-to="${e.to}" data-edge-id="${e.id}"/>`
  ).join('\n');

  const nodesSvg = NETWORK_NODES_DATA.map(n => {
    const s = nodeSize(n);
    const c = groupColors[n.group] || groupColors.process;
    const rx = 8, ry = 8;
    return `<g class="net-node" data-node-id="${n.id}" data-group="${n.group}" data-detail="${escapeHtml(n.detail)}" transform="translate(${n.cx},${n.cy})">
      <rect class="net-node-bg" x="${-s.rw/2}" y="${-s.rh/2}" width="${s.rw}" height="${s.rh}" rx="${rx}" ry="${ry}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>
      <text class="net-node-label" x="0" y="1" text-anchor="middle" dominant-baseline="middle" fill="${c.text}" font-size="${s.fs}px" font-weight="500">${n.icon} ${escapeHtml(n.label)}</text>
    </g>`;
  }).join('\n');

  // Row labels
  const rowLabels = [
    { label:'INPUTS', y: toSvgY(0), x: pad },
    { label:'PROCESSING', y: toSvgY(16), x: pad },
    { label:'ROUTING', y: toSvgY(26), x: pad },
    { label:'AGENTS', y: toSvgY(40), x: pad },
    { label:'SUB-AGENTS', y: toSvgY(58), x: pad },
    { label:'MODELS & STORAGE', y: toSvgY(82), x: pad },
  ];
  const labelsSvg = rowLabels.map(r =>
    `<text class="net-row-label" x="${r.x}" y="${r.y}" fill="var(--dim)" font-size="9px" letter-spacing="0.12em" text-anchor="start" font-weight="600">${r.label}</text>`
  ).join('\n');

  // Detail tooltip (hidden by default, shown on hover)
  const tooltipSvg = `
    <rect id="net-tooltip-bg" x="0" y="0" width="320" height="40" rx="6" fill="rgba(9,12,13,0.92)" stroke="var(--line-strong)" stroke-width="1" visibility="hidden"/>
    <text id="net-tooltip-text" x="12" y="24" fill="var(--text)" font-size="11px" visibility="hidden" text-anchor="start"> </text>
  `;

  const svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;">
    <defs>
      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="${w}" height="${h}" fill="transparent"/>
    ${labelsSvg}
    <g id="net-edges">${edgesSvg}</g>
    <g id="net-nodes">${nodesSvg}</g>
    ${tooltipSvg}
  </svg>`;

  container.innerHTML = svg;

  // ─── Bind interactions ─────────────────────────────────────────────────
  const tooltipBg = container.querySelector('#net-tooltip-bg');
  const tooltipText = container.querySelector('#net-tooltip-text');

  // Drag state — persistent positions saved to localStorage as percentages
  // (0–100 of the canvas), so saved layouts stay correct no matter how big
  // the container is when the map is reopened.
  if (!window._netNodePositions) {
    window._netNodePositions = new Map();
    // Load saved positions from localStorage
    try {
      const saved = localStorage.getItem('tracenoc_node_positions_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        for (const [id, pos] of Object.entries(parsed)) {
          window._netNodePositions.set(id, pos);
        }
      }
    } catch (_) { /* ignore corrupt localStorage */ }
  }
  const nodePositions = window._netNodePositions;
  // Initialize any nodes not yet saved (new nodes or clean slate)
  for (const n of NETWORK_NODES_DATA) {
    if (!nodePositions.has(n.id)) nodePositions.set(n.id, { px: n.x, py: n.y });
  }
  const nodeSizes = {};
  for (const n of NETWORK_NODES_DATA) nodeSizes[n.id] = nodeSize(n);

  function posToPx(pos) {
    return { cx: toSvg(pos.px), cy: toSvgY(pos.py) };
  }

  let dragState = null;

  function svgPt(e) {
    const svg = container.querySelector('svg');
    const rect = svg.getBoundingClientRect();
    const z = state.netZoom;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    // SVG viewBox content is centered within the element (preserveAspectRatio meet)
    const s = Math.min(cw / w, ch / h);
    const cw2 = w * s, ch2 = h * s;
    const ox = (cw - cw2) / 2, oy = (ch - ch2) / 2;
    // Screen point → element coords → untransformed → viewBox coords
    const ux = (e.clientX - rect.left) / z;
    const uy = (e.clientY - rect.top) / z;
    return {
      x: (ux - ox) / s,
      y: (uy - oy) / s,
    };
  }

  function updateEdgePath(edgeId, fromId, toId) {
    const f = nodePositions.get(fromId);
    const t = nodePositions.get(toId);
    if (!f || !t) return;
    const fpx = posToPx(f), tpx = posToPx(t);
    const mx = (fpx.cx + tpx.cx) / 2;
    const my = (fpx.cy + tpx.cy) / 2;
    const dy = tpx.cy - fpx.cy;
    const cpx = mx, cpy = my - Math.abs(dy) * 0.15;
    const el = container.querySelector(`[data-edge-id="${edgeId}"]`);
    if (el) el.setAttribute('d', `M${fpx.cx},${fpx.cy} Q${cpx},${cpy} ${tpx.cx},${tpx.cy}`);
  }

  function updateEdgesForNode(nodeId) {
    for (const [from, to] of NETWORK_EDGES) {
      if (from === nodeId || to === nodeId) {
        updateEdgePath(`${from}-${to}`, from, to);
      }
    }
  }

  function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const { nodeId, offsetX, offsetY } = dragState;
    const pt = svgPt(e);
    const pos = nodePositions.get(nodeId);
    if (!pos) return;
    // Clamp the node's full box (not just its center) inside the canvas,
    // so it can be dragged flush against an edge but never past it.
    const size = nodeSizes[nodeId] || { rw: 76, rh: 22 };
    const marginX = Math.min(size.rw / 2, w / 2);
    const marginY = Math.min(size.rh / 2, h / 2);
    const cx = Math.max(marginX, Math.min(w - marginX, pt.x - offsetX));
    const cy = Math.max(marginY, Math.min(h - marginY, pt.y - offsetY));
    pos.px = (cx / w) * 100;
    pos.py = (cy / h) * 100;

    const nodeEl = container.querySelector(`[data-node-id="${nodeId}"]`);
    if (nodeEl) nodeEl.setAttribute('transform', `translate(${cx},${cy})`);

    updateEdgesForNode(nodeId);
    dragState.moved = true;
  }

  function savePositions() {
    try {
      const obj = {};
      for (const [id, pos] of nodePositions) {
        obj[id] = { px: pos.px, py: pos.py };
      }
      localStorage.setItem('tracenoc_node_positions_v2', JSON.stringify(obj));
    } catch (_) { /* storage full or unavailable */ }
  }

  function onDragEnd() {
    if (!dragState) return;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    container.style.cursor = '';
    dragState = null;
    savePositions();
  }

  // Hover: show detail tooltip
  container.querySelectorAll('.net-node').forEach(el => {
    el.addEventListener('mouseenter', () => {
      if (dragState || panState) return;
      const detail = el.dataset.detail || el.dataset.nodeId;
      tooltipText.textContent = detail;
      tooltipBg.setAttribute('visibility', 'visible');
      tooltipText.setAttribute('visibility', 'visible');
      // Resize bg to fit text
      const len = detail.length;
      tooltipBg.setAttribute('width', Math.max(180, len * 7 + 24));
      el.classList.add('net-node-hover');
    });
    el.addEventListener('mousemove', (e) => {
      if (dragState || panState) return;
      const svgRect = container.querySelector('svg').getBoundingClientRect();
      const x = e.clientX - svgRect.left + 12;
      const y = e.clientY - svgRect.top - 50;
      tooltipBg.setAttribute('x', Math.min(x, w - 340));
      tooltipBg.setAttribute('y', Math.max(y, 4));
      tooltipText.setAttribute('x', Math.min(x + 12, w - 328));
      tooltipText.setAttribute('y', Math.max(y + 24, 28));
    });
    el.addEventListener('mouseleave', () => {
      if (dragState || panState) return;
      tooltipBg.setAttribute('visibility', 'hidden');
      tooltipText.setAttribute('visibility', 'hidden');
      el.classList.remove('net-node-hover');
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const nodeId = el.dataset.nodeId;
      const pos = nodePositions.get(nodeId);
      if (!pos) return;
      const pt = svgPt(e);
      const { cx, cy } = posToPx(pos);
      dragState = {
        nodeId,
        offsetX: pt.x - cx,
        offsetY: pt.y - cy,
        moved: false,
      };
      container.style.cursor = 'grabbing';
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragEnd);
    });
    el.addEventListener('click', (e) => {
      // Suppress click if this was a drag or a pan
      if (dragState?.moved || panSuppressedClick) {
        panSuppressedClick = false;
        return;
      }
      const nodeId = el.dataset.nodeId;
      const node = nodeMap[nodeId];
      if (!node) return;
      showNetworkNodeDetail(nodeId, node);
    });
    // Visual cue for draggability
    el.style.cursor = 'grab';
  });

  // Apply any previously dragged positions to the fresh SVG
  for (const [nodeId, pos] of nodePositions) {
    const nodeEl = container.querySelector(`[data-node-id="${nodeId}"]`);
    if (nodeEl) {
      const { cx, cy } = posToPx(pos);
      nodeEl.setAttribute('transform', `translate(${cx},${cy})`);
    }
  }
  for (const [from, to] of NETWORK_EDGES) {
    updateEdgePath(`${from}-${to}`, from, to);
  }

  // Highlight path if trace is selected
  highlightNetworkPath();
  applyPanZoom();
}

function highlightNetworkPath() {
  const container = $('networkMapContainer');
  if (!container || !state.trace) return;

  // Clear previous highlights
  container.querySelectorAll('.net-node-highlight').forEach(el => el.classList.remove('net-node-highlight'));
  container.querySelectorAll('.net-edge-highlight').forEach(el => el.classList.remove('net-edge-highlight'));

  // Collect node IDs to highlight
  const trace = state.trace;
  const highlightIds = new Set();
  const edgeIdsToHighlight = new Set();

  // From channel
  const channel = trace.channel;
  const channelNodes = CHANNEL_TO_NODE[channel];
  if (channelNodes) channelNodes.forEach(id => highlightIds.add(id));

  // Home Assistant Voice PE ("Jarvis") turns that fall through to Main are
  // tagged channel:'webchat' by the underlying session record (ha-voice-
  // adapter's own transport quirk, not a real webchat UI) — CHANNEL_TO_NODE
  // has no 'webchat' entry, so these traces never lit up Jarvis/Routine
  // Router on the map even though that's genuinely where they came from
  // (2026-08-08). Detect it narrowly via sessionKey rather than mapping
  // every 'webchat' trace to Jarvis, since a real browser webchat UI would
  // also report channel:'webchat' and should NOT show as voice-originated.
  if (channel === 'webchat') {
    const isHomeAssistantVoiceTurn = (trace.spans || []).some((span) => {
      const key = span.evidence && span.evidence.sessionKey;
      return typeof key === 'string' && key.includes('home_assistant:');
    });
    if (isHomeAssistantVoiceTurn) ['voice', 'router', 'main'].forEach(id => highlightIds.add(id));
  }

  // From agents
  for (const agentId of (trace.agents || [])) {
    const nodes = AGENT_TO_NODE[agentId.toLowerCase()];
    if (nodes) nodes.forEach(id => highlightIds.add(id));
  }

  // Derive the full path from the trace's spans themselves. This is the
  // authoritative record of which agents actually handled the request, and it
  // works even when the agents summary list is incomplete (e.g. voice
  // fast-path traces may only list the router even though a sub-agent handled
  // the routed intent).
  for (const span of (trace.spans || [])) {
    // Any distinct agent referenced by a span is part of the request path.
    if (span.agentId) {
      const nodes = AGENT_TO_NODE[span.agentId.toLowerCase()];
      if (nodes) nodes.forEach(id => highlightIds.add(id));
    }
    // The router dispatches based on intent; derive the target sub-agent from
    // the span's routing evidence so the whole downstream path lights up.
    const intent = span.evidence && span.evidence.intent;
    if (intent) {
      const derived = routeToAgent(intent);
      if (derived) {
        const nodes = AGENT_TO_NODE[derived];
        if (nodes) nodes.forEach(id => highlightIds.add(id));
      }
    }
  }

  // Also derive sub-agents from tool-call spans. Voice fast-path traces
  // created by loadVoiceFastpath() now include a 'tool'-kind span whose
  // agentId is set to the owning sub-agent (e.g. 'task-tracker' for a board
  // operation). This catches tool calls the Routine Router makes directly
  // without going through the sub-agent's own session.
  for (const span of (trace.spans || [])) {
    if (span.kind === 'tool' && span.agentId) {
      const nodes = AGENT_TO_NODE[span.agentId.toLowerCase()];
      if (nodes) nodes.forEach(id => highlightIds.add(id));
    }
    // Also catch delegation-kind spans that reference a target agent
    if (span.kind === 'delegation' && span.agentId) {
      const nodes = AGENT_TO_NODE[span.agentId.toLowerCase()];
      if (nodes) nodes.forEach(id => highlightIds.add(id));
    }
  }

  // Edge highlighting is handled in the evidence-based section below.
  // The old code here added router→sub-agent edges for every agent in
  // trace.agents whenever shared-routine-router appeared, which produced
  // false positives — removed 2026-08-09 (see project-overlight-edges-bug).

  // Also include Main for non-router agent-based requests
  if (trace.agents && trace.agents.length > 0 && !trace.agents.includes('shared-routine-router') && !trace.agents.includes('dashboard-api')) {
    highlightIds.add('main');

  }

  // From models used
  for (const model of (trace.models || [])) {
    if (!model.local) { highlightIds.add('openrouter'); }
  }

  // Downstream data flow: when a sub-agent that syncs to the Dashboard API
  // is highlighted, also highlight dashapi and kiosk so the full data path
  // (agent → Dashboard API → Kiosk display) is visible on the map.
  // Sub-agents that sync: health, tracker, lists, meal
  const SYNC_TO_DASHAPI = new Set(['health', 'tracker', 'lists', 'meal']);
  const hasSyncingAgent = [...highlightIds].some(id => SYNC_TO_DASHAPI.has(id));
  if (hasSyncingAgent) {
    highlightIds.add('dashapi');
  }

  // When dashapi is highlighted, also highlight kiosk since it's the
  // display frontend that reads from the Dashboard API
  if (highlightIds.has('dashapi')) {
    // If kiosk was the channel, it's already added; otherwise add it now
    // to show the full UI endpoint of the data flow
    highlightIds.add('kiosk');
    // dashapi almost always reads/writes JSON files (task boards, habits,
    // grocery, lists) — add the json storage node so the edge lights up
    highlightIds.add('json');
  }

  // Downstream data storage: when finance-agent is highlighted, also
  // highlight the SQLite database it writes to (financedb)
  if (highlightIds.has('finance')) {
    highlightIds.add('financedb');
  }

  // External data source: when finance-agent or financedb is highlighted,
  // also highlight the Plaid API it pulls from via webhook
  if (highlightIds.has('finance') || highlightIds.has('financedb')) {
    highlightIds.add('plaid');
  }

  // Find edges that were actually traversed by this trace.
  // Instead of lighting up every possible edge between any two highlighted
  // nodes (which creates false positives — e.g. lighting router→task-tracker
  // when the router only fell through to Main, which then delegated to
  // task-tracker), derive traversed edges from the trace's span evidence.
  const traversedEdges = new Set();

  // 1. Derive edges from span evidence
  for (const span of (trace.spans || [])) {
    // 1a. Delegation spans (main → sub-agent via sessions_send)
    if (span.kind === 'delegation' && span.agentId) {
      const sourceNode = (AGENT_TO_NODE[span.agentId.toLowerCase()] || [])[0];
      const targetAgent = span.evidence?.arguments?.agentId;
      if (sourceNode && targetAgent) {
        const targetNode = (AGENT_TO_NODE[targetAgent.toLowerCase()] || [])[0];
        if (targetNode) traversedEdges.add(`${sourceNode}-${targetNode}`);
      }
    }
    // 1b. Router dispatched via intent (shared-routine-router spans with
    //     a resolved intent -> routeToAgent determines the target sub-agent)
    if (span.agentId === 'shared-routine-router' && span.evidence?.intent) {
      const targetAgent = routeToAgent(span.evidence.intent);
      if (targetAgent) {
        const targetNode = (AGENT_TO_NODE[targetAgent] || [])[0];
        if (targetNode) traversedEdges.add(`router-${targetNode}`);
      }
    }
    // 1c. Tool-call spans in voice-fastpath traces (router directly called
    //     a sub-agent's workflow script)
    if (span.kind === 'tool' && span.agentId && span.parentId) {
      const parentSpan = trace.spans.find(s => s.id === span.parentId);
      if (parentSpan?.agentId === 'shared-routine-router' && span.agentId) {
        const targetNode = (AGENT_TO_NODE[span.agentId.toLowerCase()] || [])[0];
        if (targetNode) traversedEdges.add(`router-${targetNode}`);
      }
    }
  }

  // 2. Add the input channel → router edge (from CHANNEL_TO_NODE mapping)
  const channelNodeIds = CHANNEL_TO_NODE[channel] || [];
  if (channelNodeIds.length >= 2) {
    // The last element in CHANNEL_TO_NODE arrays is the first processing
    // node the channel feeds into; the preceding elements are input nodes.
    const inputNode = channelNodeIds.slice(0, -1)[0];
    const routerNode = channelNodeIds[channelNodeIds.length - 1];
    traversedEdges.add(`${inputNode}-${routerNode}`);
  }
  // Webchat (Home Assistant voice) gets the voice→router edge explicitly
  if (channel === 'webchat' && highlightIds.has('voice') && highlightIds.has('router')) {
    traversedEdges.add('voice-router');
  }

  // 3. Add the router → main fallback edge — only when the request came
  //    through the router and main was actually involved, but the router
  //    did NOT dispatch directly to any sub-agent (i.e. it fell through).
  const routerChannels = new Set(['imessage', 'voice', 'voice-fastpath', 'webchat', 'heartbeat']);
  if (routerChannels.has(channel) && highlightIds.has('main') && highlightIds.has('router')) {
    const routerDispatchedAnySubAgent = [...traversedEdges].some(e => e.startsWith('router-') && e !== 'router-main');
    if (!routerDispatchedAnySubAgent) {
      traversedEdges.add('router-main');
    }
  }

  // 4. Add main → sub-agent edges for agents that appear in the trace
  //    but weren't dispatched directly by the router. This covers the
  //    common case: router falls through → main delegates via sessions_send.
  for (const agentId of (trace.agents || [])) {
    if (['main', 'shared-routine-router', 'dashboard-api'].includes(agentId)) continue;
    const targetNode = (AGENT_TO_NODE[agentId.toLowerCase()] || [])[0];
    if (targetNode && highlightIds.has('main') && !traversedEdges.has(`router-${targetNode}`)) {
      traversedEdges.add(`main-${targetNode}`);
    }
  }

  // 5. Add downstream data-flow edges. These are inferred from highlighted
  //    nodes (not from span evidence), so a sub-agent that syncs to the
  //    Dashboard API always lights up its data path even in traces where
  //    the actual HTTP request isn't recorded as a span.
  const dataFlowEdges = [
    // Sub-agents that sync to Dashboard API
    ['health', 'dashapi'], ['tracker', 'dashapi'],
    ['lists', 'dashapi'], ['meal', 'dashapi'],
    // Dashboard API → data stores
    ['dashapi', 'json'],
    // Dashboard API → Kiosk display
    ['dashapi', 'kiosk'],
    // Finance → its SQLite database
    ['finance', 'financedb'],
    // Plaid webhook → finance database
    ['plaid', 'financedb'],
    // Model provider edges (always inferred from models used)
    ['main', 'openrouter'],
    ['health', 'openrouter'], ['tracker', 'openrouter'],
    ['meal', 'openrouter'], ['research', 'openrouter'],
  ];
  for (const [from, to] of dataFlowEdges) {
    if (highlightIds.has(from) && highlightIds.has(to)) {
      traversedEdges.add(`${from}-${to}`);
    }
  }

  // Copy traversed edges into edgeIdsToHighlight
  for (const edgeId of traversedEdges) {
    edgeIdsToHighlight.add(edgeId);
  }

  // Apply highlights to SVG
  for (const nodeId of highlightIds) {
    const el = container.querySelector(`[data-node-id="${nodeId}"]`);
    if (el) el.classList.add('net-node-highlight');
  }
  for (const edgeId of edgeIdsToHighlight) {
    const el = container.querySelector(`[data-edge-id="${edgeId}"]`);
    if (el) el.classList.add('net-edge-highlight');
  }
}

// ─── Network Node Detail Inspector ────────────────────────────────────────

function showNetworkNodeDetail(nodeId, node) {
  // Hide other panels, show node content
  $('inspectorEmpty').hidden = true;
  $('inspectorContent').hidden = true;
  $('inspectorNodeContent').hidden = false;
  document.querySelector('.inspector-panel').classList.add('open');

  // Basic info
  $('nodeKind').textContent = node.group;
  $('nodeStatus').textContent = state.trace ? 'active' : '—';
  $('nodeTitle').textContent = node.icon + ' ' + node.label;
  $('nodeSubtitle').textContent = node.detail;
  $('nodeNoticeCard').hidden = true;

  // Find related spans from the current trace
  const trace = state.trace;
  const agentIds = NODE_TO_AGENT_IDS[nodeId] || [nodeId];
  const relatedSpans = trace ? trace.spans.filter(s => {
    // Match by agentId, or by node label matching
    if (s.agentId && agentIds.includes(s.agentId)) return true;
    // Also match spans where the evidence mentions this node
    if (s.agentId === nodeId) return true;
    return false;
  }) : [];

  // Also match input nodes by trace channel. Input nodes (voice, phone,
  // kiosk, cron) don't create spans with their own agentId — the spans are
  // created by the agents processing the request (e.g. shared-routine-router,
  // boards). So we look up which channels map to this node via CHANNEL_TO_NODE
  // and include any input-kind spans from matching channels.
  if (trace) {
    const channel = trace.channel;
    const channelNodes = CHANNEL_TO_NODE[channel];
    if (channelNodes && channelNodes.includes(nodeId)) {
      const inputSpans = trace.spans.filter(s => s.kind === 'input');
      for (const span of inputSpans) {
        if (!relatedSpans.find(rs => rs.id === span.id)) {
          relatedSpans.push(span);
        }
      }
    }
  }

  // Sort by time
  relatedSpans.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  // The router node gets a purpose-built Routing section (with the full
  // decision tree, below) instead of the generic activity/span/evidence
  // dumps — those are low-signal for a deterministic dispatcher and the
  // tree is a much more direct way to answer "what could this have matched."
  const isRouterNode = nodeId === 'router' || agentIds.includes('shared-routine-router');

  // ── Request text section (input nodes only) ──────────────────────────
  // Show the original request text prominently for input nodes (voice,
  // phone, kiosk, cron). Pulls the text from the first input-kind span
  // or from the trace's own text field.
  const requestSection = $('nodeRequestSection');
  const requestTextEl = $('nodeRequestText');
  if (trace) {
    const channel = trace.channel;
    const channelNodes = CHANNEL_TO_NODE[channel];
    const isInputNode = channelNodes && channelNodes.includes(nodeId);
    if (isInputNode) {
      requestSection.hidden = false;
      // Prefer the input span's evidence.text (most detailed), fall back to trace.text
      const inputSpan = relatedSpans.find(s => s.kind === 'input');
      const spoken = inputSpan?.evidence?.text || trace.text || '';
      const channelLabel = { voice:'Voice (Jarvis)', 'voice-fastpath':'Voice (Jarvis fast path)', imessage:'iMessage', kiosk:'Kiosk', heartbeat:'Cron / System' }[channel] || channel;
      requestTextEl.innerHTML = `<span class="node-request-source">${escapeHtml(channelLabel)}</span>“${escapeHtml(spoken)}”`;
    } else {
      requestSection.hidden = true;
    }
  } else {
    requestSection.hidden = true;
  }

  // ── Activity section ─────────────────────────────────────────────────
  const activitySection = $('nodeActivitySection');
  const activityList = $('nodeActivityList');
  if (isRouterNode) {
    activitySection.hidden = true;
  } else if (relatedSpans.length > 0) {
    activitySection.hidden = false;
    $('nodeActivityCount').textContent = `(${relatedSpans.length})`;
    activityList.innerHTML = relatedSpans.map(span => {
      const icon = KIND_ICON[span.kind] || '·';
      const sev = span.notice?.severity || span.status || 'success';
      const detail = span.subtitle ? escapeHtml(span.subtitle) : '';
      const dur = span.durationMs ? escapeHtml(duration(span.durationMs)) : '';
      return `<div class="node-activity-item">
        <span class="activity-icon">${icon}</span>
        <span class="activity-label">${escapeHtml(span.title)}</span>
        <span class="activity-detail">${detail}${dur ? ' · ' + dur : ''}</span>
        <span class="activity-status ${sev}">${sev}</span>
      </div>`;
    }).join('');
  } else {
    activitySection.hidden = true;
  }

  // ── Data Sources / Tool Calls section ────────────────────────────────
  // Shows tool calls made by this node in the current request. Every sub-agent
  // gets a tool-call breakdown so the user can see which scripts/tools were
  // invoked and what results they returned. Agent-specific data sources (like
  // health-tracker's USDA index or finance-agent's Plaid) are shown inline.
  const dsSection = $('nodeDataSourcesSection');
  const dsList = $('nodeDataSourceList');
  const toolSpans = relatedSpans.filter(s => s.kind === 'tool' || s.kind === 'delegation');
  if (nodeId === 'health' || agentIds.includes('health-tracker')) {
    dsSection.hidden = false;
    const sources = [
      { id:'staple', icon:'', label:'Staple foods', tool:'find-staple', result:null, badges:[] },
      { id:'usda', icon:'', label:'USDA nutrition index', tool:'search', result:null, badges:[] },
      { id:'recipe', icon:'', label:'Recipe library', tool:'find-recipe', result:null, badges:[] },
      { id:'estimate', icon:'', label:'AI API estimate', tool:'haiku', result:null, badges:[] },
    ];
    for (const source of sources) {
      const match = toolSpans.filter(s => {
        const name = (s.toolName || s.title || '').toLowerCase();
        return name.includes(source.tool.toLowerCase());
      });
      if (match.length > 0) {
        const lastResult = match[match.length - 1]?.evidence?.result || '';
        const lastArgs = match[match.length - 1]?.evidence?.arguments || {};
        const query = lastArgs?.query || lastArgs?.name || '';
        if (lastResult.includes('not found') || lastResult.includes('no results') || lastResult.includes('null') || lastResult === 'null' || !lastResult) {
          source.result = query ? `"${query}" not found` : 'No match';
          source.badges = [{ cls:'not-found', text:'Not found' }];
        } else if (lastResult) {
          source.result = query ? `"${query}" → found` : 'Found';
          source.badges = [{ cls:'hit', text:'Hit' }];
        } else {
          source.result = 'Checked';
          source.badges = [{ cls:'miss', text:'Checked' }];
        }
      } else {
        source.result = 'Not queried';
        source.badges = [{ cls:'miss', text:'Not queried' }];
      }
      if (source.id === 'recipe') {
        source.result = 'Not implemented in protocol';
        source.badges = [{ cls:'miss', text:'N/A' }];
      }
    }
    dsList.innerHTML = sources.map(s =>
      `<div class="node-data-source">
        <span class="ds-icon">${s.icon}</span>
        <span class="ds-label">${s.label}</span>
        <span class="ds-result">${escapeHtml(s.result)}</span>
        ${s.badges.map(b => `<span class="ds-badge ${b.cls}">${b.text}</span>`).join('')}
      </div>`
    ).join('');
    // Also append any generic tool calls
    const otherToolSpans = toolSpans.filter(s => {
      const name = (s.toolName || s.title || '').toLowerCase();
      return !['find-staple', 'search', 'find-recipe', 'haiku'].some(t => name.includes(t));
    });
    if (otherToolSpans.length) {
      dsList.innerHTML += renderToolCallRows(otherToolSpans);
    }
  } else if (nodeId === 'finance' || nodeId === 'financedb' || agentIds.includes('finance-agent')) {
    dsSection.hidden = false;
    const plaidSources = [
      { id:'plaid-accounts', icon:'🏦', label:'Account balances (Plaid)', detail:'Latest balance per account via Plaid sync', badges:[] },
      { id:'plaid-transactions', icon:'💳', label:'Transaction history (Plaid)', detail:'Raw Plaid transaction sync results', badges:[] },
      { id:'plaid-webhook', icon:'🔔', label:'Plaid webhook receiver', detail:'SYNC_UPDATES_AVAILABLE via Tailscale Funnel', badges:[] },
    ];
    dsList.innerHTML = plaidSources.map(s =>
      `<div class="node-data-source">
        <span class="ds-icon">${s.icon}</span>
        <span class="ds-label">${s.label}</span>
        <span class="ds-result">${escapeHtml(s.detail)}</span>
      </div>`
    ).join('');
    // Also append any generic tool calls
    if (toolSpans.length) {
      dsList.innerHTML += renderToolCallRows(toolSpans);
    }
  } else if (agentIds.length > 0 && toolSpans.length > 0) {
    // Show tool calls for any sub-agent that has them in this request.
    // This catches task-tracker, lists, meal-planner, etc.
    dsSection.hidden = false;
    dsList.innerHTML = renderToolCallRows(toolSpans);
  } else {
    dsSection.hidden = true;
  }

  // ── Routing section (router specific) ─────────────────────────────────
  const routingSection = $('nodeRoutingSection');
  const routingInfo = $('nodeRoutingInfo');
  if (nodeId === 'router' || agentIds.includes('shared-routine-router')) {
    routingSection.hidden = false;
    // Find evidence about routing decisions
    const routerSpans = relatedSpans.filter(s => s.agentId === 'shared-routine-router');
    const routeEvidence = routerSpans.map(s => s.evidence || {}).find(e => e.intent || e.route);
    const routeData = [
      ['Intent', routeEvidence?.intent || '—'],
      ['Route', routeEvidence?.route || '—'],
      ['Channel', routeEvidence?.channel || '—'],
      ['Dispatched to', routeEvidence?.intent ? routeToAgent(routeEvidence.intent) || '—' : '—'],
      ['Handled', routeEvidence?.intent ? 'Yes' : 'No'],
    ];
    // Also check other spans for routing info
    const delegations = relatedSpans.filter(s => s.kind === 'delegation');
    if (delegations.length > 0) {
      routeData.push(['Delegation target', delegations.map(d => d.title || '?').join(', ')]);
    }
    routingInfo.innerHTML = routeData.map(([k, v]) =>
      `<div class="node-routing-item"><span class="ri-key">${escapeHtml(k)}</span><span class="ri-value">${escapeHtml(v)}</span></div>`
    ).join('');
    renderPipeline(routeEvidence?.stages);
    renderRouterTree(routeEvidence);
  } else {
    routingSection.hidden = true;
    $('nodePipeline').hidden = true;
    $('nodeRouterTree').innerHTML = '';
  }

  // ── Model thoughts section ────────────────────────────────────────────
  const thoughtsSection = $('nodeThoughtsSection');
  const thoughtsContent = $('nodeThoughtsContent');
  const modelSpans = relatedSpans.filter(s => s.kind === 'model');
  if (modelSpans.length > 0) {
    thoughtsSection.hidden = false;
    // Collect model response text from evidence
    const thoughts = modelSpans.map(s => {
      const text = s.evidence?.text || '';
      const model = s.model || 'unknown';
      const provider = s.provider || 'unknown';
      const local = s.local ? ' (local)' : ' (remote)';
      return `── ${provider}/${model}${local} ──\n${text.slice(0, 2000)}`;
    }).join('\n\n');
    thoughtsContent.textContent = thoughts || 'No model response text available.';
  } else {
    thoughtsSection.hidden = true;
  }

  // ── Related spans section ─────────────────────────────────────────────
  const spansSection = $('nodeRelatedSpansSection');
  const spanList = $('nodeSpanList');
  if (isRouterNode) {
    spansSection.hidden = true;
  } else if (relatedSpans.length > 0) {
    spansSection.hidden = false;
    $('nodeSpanCount').textContent = `(${relatedSpans.length})`;
    spanList.innerHTML = relatedSpans.map(span => {
      const icon = KIND_ICON[span.kind] || '·';
      const sev = span.notice?.severity || span.status || 'success';
      const dur = span.durationMs ? duration(span.durationMs) : '';
      return `<div class="node-span-link" data-span-id="${escapeHtml(span.id)}">
        <span class="sl-icon">${icon}</span>
        <span class="sl-title">${escapeHtml(span.title)}</span>
        <span class="sl-duration">${escapeHtml(dur)}</span>
        <span class="sl-status ${sev}"></span>
      </div>`;
    }).join('');
    // Bind click to jump to span
    spanList.querySelectorAll('[data-span-id]').forEach(el => {
      el.addEventListener('click', () => {
        selectSpan(el.dataset.spanId);
      });
    });
  } else {
    spansSection.hidden = true;
  }

  // ── Source evidence ───────────────────────────────────────────────────
  if (isRouterNode) {
    $('nodeEvidenceSection').hidden = true;
  } else {
    $('nodeEvidenceSection').hidden = false;
    $('inspectorNodeEvidence').textContent = relatedSpans.length > 0
      ? JSON.stringify(relatedSpans, null, 2)
      : 'No trace data available for this node. Select a request first.';
    $('copyNodeEvidence').hidden = false;
    $('copyNodeEvidence').onclick = async () => {
      await navigator.clipboard.writeText($('inspectorNodeEvidence').textContent);
      $('copyNodeEvidence').textContent = 'Copied';
      setTimeout(() => $('copyNodeEvidence').textContent = 'Copy', 1200);
    };
  }
}

// ─── Routine router pipeline (per-request trace) ───────────────────────────
// Renders shared-routine-router's own `stages` trace (input -> escape-hatch
// -> grammar-match -> slot-parse -> dispatch), one row per stage the request
// actually reached, so a silent mid-pipeline failure (e.g. a slot matched
// the grammar but its value didn't parse) shows exactly where and why —
// instead of the flat "Handled: No" that used to be the only signal.
// Added 2026-08-08 — see project-calendar-period-time-separator-bug-2026-08-08.
const PIPELINE_STAGE_LABELS = {
  'input': 'Received',
  'escape-hatch': 'Never-mind check',
  'grammar-match': 'Grammar match',
  'food-report-parse': 'Food-log phrasing check',
  'food-recipe-tier': 'Food fast path: recipe match',
  'food-usda-tier': 'Food fast path: USDA match',
  'slot-parse': 'Slot / value parse',
  'dispatch': 'Workflow dispatch',
};

const PIPELINE_STATUS_ICON = { pass: '✓', matched: '✓', fail: '✕', skip: '–' };

function pipelineStageDetailHtml(stage) {
  const d = stage.detail || {};
  switch (stage.stage) {
    case 'input':
      return d.text ? `“${escapeHtml(d.text)}”` : escapeHtml(d.reason || '');
    case 'escape-hatch':
      return stage.status === 'matched' ? `matched: ${escapeHtml(d.pattern || '')}` : '';
    case 'grammar-match': {
      if (stage.status === 'fail') return `cleaned: “${escapeHtml(d.cleaned || '')}” — ${escapeHtml(d.reason || '')}`;
      const slotsStr = d.slots ? Object.entries(d.slots).map(([k, v]) => `${k}="${v}"`).join(', ') : '';
      return `intent <strong>${escapeHtml(d.intent || '')}</strong> — cleaned: “${escapeHtml(d.cleaned || '')}”${slotsStr ? ` — slots: ${escapeHtml(slotsStr)}` : ''}`;
    }
    case 'food-report-parse':
      return stage.status === 'skip'
        ? escapeHtml(d.reason || '')
        : `extracted: “${escapeHtml(d.description || '')}”`;
    case 'food-recipe-tier':
      return stage.status === 'pass'
        ? `matched personal recipe <strong>${escapeHtml(d.recipeName || '')}</strong>`
        : escapeHtml(d.reason || '');
    case 'food-usda-tier': {
      const parts = [];
      const fuzzyTag = d.searchFuzzy ? ` <span class="pipeline-tag">fuzzy${d.similarity != null ? ` ${escapeHtml((d.similarity * 100).toFixed(0))}%` : ''}</span>` : '';
      if (stage.status === 'pass') {
        parts.push(`matched <strong>${escapeHtml(d.candidate || '')}</strong>${fuzzyTag} — confidence ${escapeHtml(String(d.confidence ?? ''))}`);
      } else {
        parts.push(escapeHtml(d.reason || ''));
      }
      if (d.searchQuery) parts.push(`search: “${escapeHtml(d.searchQuery)}”${d.searchFuzzy && stage.status !== 'pass' ? ' (strict match found nothing — this was the fuzzy fallback)' : ''}`);
      if (d.candidate && stage.status !== 'pass') parts.push(`best candidate: “${escapeHtml(d.candidate)}”${fuzzyTag}${d.confidence != null ? ` (confidence ${escapeHtml(String(d.confidence))})` : ''}`);
      if (Array.isArray(d.candidates) && d.candidates.length) {
        parts.push(`considered: ${d.candidates.map((c) => `“${escapeHtml(c)}”`).join(', ')}`);
      }
      const qp = d.quantityParse;
      if (qp) {
        const qpParts = [`parsed food name: “${escapeHtml(qp.parsedFoodName || '')}”`, `${escapeHtml(String(qp.quantity ?? ''))}x, ${escapeHtml(String(qp.grams ?? ''))}g${qp.unit ? ` (unit: ${escapeHtml(qp.unit)})` : ''}`];
        if (Array.isArray(qp.strippedSizeWords) && qp.strippedSizeWords.length) {
          qpParts.push(`size words stripped: ${qp.strippedSizeWords.map((w) => escapeHtml(w)).join(', ')}`);
        }
        parts.push(`<span class="pipeline-subdetail">quantity parser — ${qpParts.join(', ')}</span>`);
      }
      return parts.filter(Boolean).join('<br>');
    }
    case 'slot-parse':
      return stage.status === 'fail' ? escapeHtml(d.reason || '') : `route <strong>${escapeHtml(d.route || '')}</strong>`;
    case 'dispatch':
      return stage.status === 'fail'
        ? `route <strong>${escapeHtml(d.route || '')}</strong> failed${d.error ? `: ${escapeHtml(d.error)}` : ''}`
        : `route <strong>${escapeHtml(d.route || '')}</strong> succeeded`;
    default:
      return '';
  }
}

function renderPipeline(stages) {
  const container = $('nodePipeline');
  if (!Array.isArray(stages) || stages.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = stages.map((s) => {
    const label = PIPELINE_STAGE_LABELS[s.stage] || s.stage;
    const icon = PIPELINE_STATUS_ICON[s.status] || '?';
    const detail = pipelineStageDetailHtml(s);
    return `<div class="pipeline-step pipeline-${escapeHtml(s.status)}">
      <span class="pipeline-icon">${icon}</span>
      <div class="pipeline-body">
        <div class="pipeline-label">${escapeHtml(label)}</div>
        ${detail ? `<div class="pipeline-detail">${detail}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── Routine router decision tree (reference view) ────────────────────────
// Static tree of every rule the router actually has, fetched once via
// loadRouterTree(). `evidence` is the current trace's routing evidence
// (evidence.route is 'router' when routeRoutineRequest handled the request
// — via grammar match OR the food-logging fast path, both live inside the
// shared router as of 2026-08-08 — and evidence.intent is the specific
// matched route string). When there's no evidence (request missed
// everything and fell to Main), nothing is highlighted — the tree stays a
// plain reference for manually scanning which rule should have caught it.
const FOOD_LOGGING_ROUTES = new Set(['food-log-recipe', 'usda']);

function renderRouterTree(evidence) {
  const container = $('nodeRouterTree');
  if (!routerTreeData) {
    container.innerHTML = '<p class="muted router-tree-loading">Loading router rules…</p>';
    return;
  }
  const matchedTier = evidence?.route || null;
  const matchedRoute = matchedTier === 'router' ? evidence?.intent : null;
  container.innerHTML = routerTreeData.tiers.map((tier) => renderRouterTreeTier(tier, matchedTier, matchedRoute)).join('');
}

function renderRouterTreeTier(tier, matchedTier, matchedRoute) {
  const foodHit = matchedTier === 'router' && FOOD_LOGGING_ROUTES.has(matchedRoute);
  let tierHit = tier.id === 'tier-grammar' && foodHit;
  let body = '';

  if (tier.id === 'tier-grammar' && tier.domains) {
    body = tier.domains.map((domain) => {
      let domainHit = false;
      const intentsHtml = domain.intents.map((intent) => {
        const hit = matchedTier === 'router' && intent.routes.includes(matchedRoute);
        if (hit) domainHit = true;
        const phrases = intent.phrases.map((p) => `<li>"${escapeHtml(p)}"</li>`).join('');
        return `<details class="router-tree-intent${hit ? ' router-tree-hit' : ''}"${hit ? ' open' : ''}>
          <summary>${escapeHtml(intent.name)} <span class="router-tree-count">${intent.phrases.length}</span>${hit ? '<span class="router-tree-badge">Matched this request</span>' : ''}</summary>
          <ul class="router-tree-phrases">${phrases}</ul>
        </details>`;
      }).join('');
      if (domainHit) tierHit = true;
      return `<details class="router-tree-domain"${domainHit ? ' open' : ''}>
        <summary>${escapeHtml(domain.label)} <span class="router-tree-count">${domain.intentCount}</span></summary>
        ${intentsHtml}
      </details>`;
    }).join('');
    if (tier.foodLogging?.steps) {
      const stepsHtml = tier.foodLogging.steps.map((s) => `<div class="router-tree-step"><strong>${escapeHtml(s.label)}</strong> — ${escapeHtml(s.detail)}</div>`).join('');
      body += `<details class="router-tree-domain${foodHit ? ' router-tree-hit' : ''}"${foodHit ? ' open' : ''}>
        <summary>${escapeHtml(tier.foodLogging.label)}${foodHit ? '<span class="router-tree-badge">Matched this request</span>' : ''}</summary>
        <p class="router-tree-desc">${escapeHtml(tier.foodLogging.description)}</p>
        ${stepsHtml}
      </details>`;
    }
  } else if (tier.id === 'tier-main' && tier.rules) {
    body = tier.rules.map((r) => `<div class="router-tree-step"><span class="router-tree-agent">${escapeHtml(r.agent)}</span> ${escapeHtml(r.description)}</div>`).join('');
  }

  return `<details class="router-tree-tier${tierHit ? ' router-tree-hit' : ''}"${tierHit ? ' open' : ''}>
    <summary>${escapeHtml(tier.label)}</summary>
    ${tier.description ? `<p class="router-tree-desc">${escapeHtml(tier.description)}</p>` : ''}
    ${body}
  </details>`;
}

// ─── Inspector ────────────────────────────────────────────────────────────────

function selectSpan(id) {
  state.selectedSpanId = id;

  const span = state.trace?.spans.find(s => s.id === id);
  if (!span) return;
  $('inspectorEmpty').hidden = true;
  $('inspectorContent').hidden = false;
  $('inspectorNodeContent').hidden = true;
  document.querySelector('.inspector-panel').classList.add('open');
  $('inspectorKind').textContent = KIND_LABEL[span.kind] || span.kind;
  $('inspectorStatus').textContent = span.notice?.severity || span.status;
  $('inspectorTitle').textContent = span.title;
  $('inspectorSubtitle').textContent = span.subtitle || '';
  $('noticeCard').hidden = !span.notice;
  if (span.notice) $('noticeCard').innerHTML = `<strong>${escapeHtml(span.notice.title)}</strong>${escapeHtml(span.notice.detail)}`;
  const facts = [
    ['Started', dateTime(span.startedAt)], ['Duration', duration(span.durationMs)], ['Agent', span.agentId || '—'],
    ['Provider', span.provider || '—'], ['Model', span.model || '—'], ['Execution', span.model ? (span.local ? 'Local' : 'Remote') : '—'],
    ['Tokens', span.usage ? number(span.usage.totalTokens ?? span.usage.total) : '—'], ['Cost', span.usage ? money(Number(span.usage.cost?.total || 0)) : '—'],
    ['Confidence', span.confidence || 'native']
  ];
  $('inspectorFacts').innerHTML = facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  $('inspectorEvidence').textContent = JSON.stringify(span.evidence || {}, null, 2);
}

// ─── Zoom & Pan ──────────────────────────────────────────────────────────────

function applyPanZoom() {
  const container = $('networkMapContainer');
  if (!container) return;
  const svg = container.querySelector('svg');
  if (!svg) return;
  const { x, y } = state.netPan;
  svg.style.transform = `translate(${x}px, ${y}px) scale(${state.netZoom})`;
  svg.style.transformOrigin = '0 0';
  const label = $('netZoomLabel');
  if (label) label.textContent = `${Math.round(state.netZoom * 100)}%`;
}

// ─── Canvas pan ────────────────────────────────────────────────────────────────

let panState = null;
let panSuppressedClick = false;

// Keep the panned view from drifting past the canvas edges, at any zoom level.
function clampPan(zoom, panX, panY) {
  const container = $('networkMapContainer');
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const vw = cw * zoom;
  const vh = ch * zoom;
  const minX = Math.min(0, cw - vw);
  const minY = Math.min(0, ch - vh);
  return {
    x: Math.max(minX, Math.min(0, panX)),
    y: Math.max(minY, Math.min(0, panY)),
  };
}

function startCanvasPan(e) {
  // Reset click suppression on any new mousedown
  panSuppressedClick = false;
  // Don't start pan if clicking on a node (node drag takes over)
  if (e.target.closest('.net-node')) return;
  panState = {
    startX: e.clientX,
    startY: e.clientY,
    panX: state.netPan.x,
    panY: state.netPan.y,
    moved: false,
  };
  const container = $('networkMapContainer');
  if (container) container.style.cursor = 'grabbing';
  window.addEventListener('mousemove', onCanvasPanMove);
  window.addEventListener('mouseup', endCanvasPan);
}

function onCanvasPanMove(e) {
  if (!panState) return;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    panState.moved = true;
    panSuppressedClick = true;
  }
  const clamped = clampPan(state.netZoom, panState.panX + dx, panState.panY + dy);
  state.netPan.x = clamped.x;
  state.netPan.y = clamped.y;
  applyPanZoom();
}

function endCanvasPan() {
  if (!panState) return;
  window.removeEventListener('mousemove', onCanvasPanMove);
  window.removeEventListener('mouseup', endCanvasPan);
  const container = $('networkMapContainer');
  if (container) container.style.cursor = '';
  panState = null;
}

// Zoom toward a fixed point (cursor or container center), like a modern map.
function zoomNetworkMap(newZoom, anchorX, anchorY) {
  const oldZoom = state.netZoom;
  newZoom = Math.max(0.5, Math.min(3, +newZoom.toFixed(2)));
  if (newZoom === oldZoom) return;
  const contentX = (anchorX - state.netPan.x) / oldZoom;
  const contentY = (anchorY - state.netPan.y) / oldZoom;
  const panX = anchorX - contentX * newZoom;
  const panY = anchorY - contentY * newZoom;
  state.netZoom = newZoom;
  const clamped = clampPan(newZoom, panX, panY);
  state.netPan.x = clamped.x;
  state.netPan.y = clamped.y;
  applyPanZoom();
}

function onNetworkMapWheel(e) {
  e.preventDefault();
  const container = $('networkMapContainer');
  const rect = container.getBoundingClientRect();
  const anchorX = e.clientX - rect.left;
  const anchorY = e.clientY - rect.top;
  const step = state.netZoom * (e.deltaY > 0 ? -0.1 : 0.1);
  zoomNetworkMap(state.netZoom + step, anchorX, anchorY);
}

// ─── Event bindings ───────────────────────────────────────────────────────────

let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); state.selectedRequestId = null; loadRequests(); }, 220);
});
$('refreshButton').addEventListener('click', loadRequests);
$('netZoomIn').addEventListener('click', () => {
  const container = $('networkMapContainer');
  zoomNetworkMap(state.netZoom + 0.25, container.clientWidth / 2, container.clientHeight / 2);
});
$('netZoomOut').addEventListener('click', () => {
  const container = $('networkMapContainer');
  zoomNetworkMap(state.netZoom - 0.25, container.clientWidth / 2, container.clientHeight / 2);
});
$('netZoomReset').addEventListener('click', () => {
  state.netZoom = 1;
  state.netPan = { x: 0, y: 0 };
  applyPanZoom();
});
// Canvas pan: drag empty background to move the view
$('networkMapContainer').addEventListener('mousedown', startCanvasPan);
$('networkMapContainer').addEventListener('wheel', onNetworkMapWheel, { passive: false });
$('copyEvidence').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('inspectorEvidence').textContent);
  $('copyEvidence').textContent = 'Copied';
  setTimeout(() => $('copyEvidence').textContent = 'Copy', 1200);
});

// ─── Helper: render tool call rows for the inspector panel ──────────────
// Renders a list of tool-call spans as data-source-style rows. Used by
// showNetworkNodeDetail() for any sub-agent that has tool-call spans in
// the current request trace.
function renderToolCallRows(toolSpans) {
  if (!toolSpans || !toolSpans.length) return '';
  return toolSpans.map(span => {
    const scriptName = span.toolName || span.subtitle || span.title || '';
    const resultText = span.evidence?.result || span.evidence?.reply || '';
    const intentText = span.evidence?.intent || '';
    const status = span.status || 'success';
    const statusBadge = status === 'error' ? '<span class="ds-badge not-found">Failed</span>'
      : status === 'warning' ? '<span class="ds-badge pending">Warning</span>'
      : '<span class="ds-badge hit">Success</span>';
    const detailLine = intentText
      ? `${escapeHtml(intentText)} → ${escapeHtml(scriptName)}`
      : escapeHtml(scriptName);
    return `<div class="node-data-source">
        <span class="ds-icon">▶</span>
        <span class="ds-label">Tool call</span>
        <span class="ds-result">${detailLine}</span>
        ${statusBadge}
      </div>` +
      (resultText ? `<div class="node-tool-result">${escapeHtml(resultText.slice(0, 200))}</div>` : '');
  }).join('');
}

// ─── Fast Router Proposals tab ────────────────────────────────────────────────

const qaState = { phrases: [], diffs: [], selectedDiff: null, selectedPhraseId: null };

function escapeHtmlQA(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);
}

// Tab switching
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('investigationsView').hidden = tab !== 'investigations';
  $('qaReviewView').hidden = tab !== 'qa-review';
  $('backupView').hidden = tab !== 'backup';
  $('commandsView').hidden = tab !== 'commands';
  $('servicesView').hidden = tab !== 'services';
  if (tab === 'qa-review') loadQA();
  if (tab === 'backup') loadBackup();
  if (tab === 'services') loadServices();
}

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// Off-canvas side panels (tablet/half-screen widths)
function closeSidePanel(panel) {
  panel.classList.remove('open');
}
function openSidePanel(panel) {
  document.querySelectorAll('.side-panel.open').forEach(p => { if (p !== panel) closeSidePanel(p); });
  panel.classList.add('open');
}
[
  ['inspectorClose', '.inspector-panel'],
  ['qaTipsClose', '.qa-tips-panel'],
  ['backupTipsClose', '.backup-tips-panel'],
].forEach(([btnId, selector]) => {
  const btn = $(btnId);
  const panel = document.querySelector(selector);
  if (btn && panel) btn.addEventListener('click', () => closeSidePanel(panel));
});
[
  ['qaTipsToggle', '.qa-tips-panel'],
  ['backupTipsToggle', '.backup-tips-panel'],
].forEach(([btnId, selector]) => {
  const btn = $(btnId);
  const panel = document.querySelector(selector);
  if (btn && panel) btn.addEventListener('click', () => openSidePanel(panel));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.side-panel.open').forEach(closeSidePanel);
});
document.addEventListener('click', (e) => {
  if (window.innerWidth > 980) return;
  document.querySelectorAll('.side-panel.open').forEach((panel) => {
    if (panel.contains(e.target) || e.target.closest('.side-panel-toggle')) return;
    closeSidePanel(panel);
  });
}, true);

// Load both the phrase tracker and diffs
async function loadQA() {
  try {
    const diffsBody = await api('/api/qa/diffs');
    qaState.diffs = diffsBody.diffs || [];
    renderQADiffsList();
  } catch (e) {
    $('qaDiffsList').innerHTML = `<div class="no-results">${escapeHtmlQA(e.message)}</div>`;
  }
  await loadPhrases();
}

async function loadPhrases() {
  try {
    const body = await api('/api/qa/phrases');
    qaState.phrases = body.entries || [];
    renderPhraseList();
  } catch (e) {
    $('phraseList').innerHTML = `<div class="no-results">${escapeHtmlQA(e.message)}</div>`;
  }
}

function formatRecencyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function relativeDays(days) {
  if (days === null || days === Infinity) return 'never used';
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function flagBadge(flag) {
  if (!flag) return '';
  const isApplied = flag.status === 'addition-applied';
  const isPending = flag.status === 'addition-pending';
  const isNoMatch = flag.status === 'no-match' || flag.status === 'addition-failed';
  const cls = isApplied ? 'addition' : (isPending || isNoMatch) ? 'pending' : 'review';
  const glyph = isApplied ? '✓' : (isPending || isNoMatch) ? '…' : '✕';
  return `<span class="phrase-flag-badge ${cls}" title="${escapeHtmlQA(flag.status)}">${glyph}</span>`;
}

function renderPhraseList() {
  const entries = qaState.phrases || [];
  if (!entries.length) {
    $('phraseList').innerHTML = '<div class="no-results">No recent utterances found in the current window.</div>';
    return;
  }
  $('phraseList').innerHTML = entries.map((entry) => `
    <button class="qa-review-card ${entry.id === qaState.selectedPhraseId ? 'active' : ''}" data-phrase-id="${escapeHtmlQA(entry.id)}">
      <span class="request-meta"><span>${entry.count}×</span><time>${escapeHtmlQA(formatRecencyDate(entry.lastSeenAt))}</time></span>
      <div class="qa-review-title">${escapeHtmlQA(entry.text)}${flagBadge(entry.flag)}</div>
    </button>`).join('');
  document.querySelectorAll('[data-phrase-id]').forEach((b) => b.addEventListener('click', () => selectPhraseGroup(b.dataset.phraseId)));
}

function selectPhraseGroup(id) {
  qaState.selectedPhraseId = id;
  renderPhraseList();
  const entry = (qaState.phrases || []).find((e) => e.id === id);
  if (!entry) return;

  $('qaEmptyState').hidden = true;
  $('qaDiffContent').hidden = true;
  $('phraseDetailContent').hidden = false;
  $('phraseFlagResult').hidden = true;
  $('phraseDetailStatus').hidden = true;
  $('phraseTargetBanner').hidden = true;
  $('phraseDomainAddForm').hidden = true;
  $('phraseRouteLinkForm').hidden = true;
  $('phraseAgentPathSection').hidden = true;
  $('phraseAgentPathMismatch').hidden = true;

  $('phraseDetailEyebrow').textContent = `Recent · ${entry.count}× in window`;
  $('phraseDetailTitle').textContent = entry.text;
  $('phraseListSectionTitle').textContent = 'Details';
  $('phraseTargetBanner').hidden = true;
  $('phraseStatGrid').innerHTML = `
    <div class="phrase-stat-tile"><strong>${entry.count}</strong><span>Occurrences</span></div>
    <div class="phrase-stat-tile"><strong>${escapeHtmlQA(formatRecencyDate(entry.lastSeenAt))}</strong><span>Last seen</span></div>
    <div class="phrase-stat-tile"><strong>${escapeHtmlQA(new Date(entry.firstSeenAt).toLocaleDateString())}</strong><span>First seen</span></div>
    <div class="phrase-stat-tile"><strong>${entry.channels.join(', ')}</strong><span>Channels</span></div>`;
  $('phraseVariantList').innerHTML = '<div class="no-results">No further detail for this utterance.</div>';
  $('phraseDetailActions').innerHTML = `
    <button class="qa-action-btn approve" id="phraseFlagAddBtn"><span>✓</span> Try Add to Router</button>
    <button class="qa-action-btn reject" id="phraseFlagDismissBtn"><span>✕</span> Dismiss</button>`;
  $('phraseFlagAddBtn').addEventListener('click', () => flagPhraseAction(id, 'addition'));
  $('phraseFlagDismissBtn').addEventListener('click', () => flagPhraseAction(id, 'dismiss'));
  renderRouteLinkForm(entry);

  if (entry.flag) {
    $('phraseDetailStatus').hidden = false;
    $('phraseDetailStatus').textContent = entry.flag.status;
    $('phraseDetailStatus').className = 'status-pill ' + (
      entry.flag.status === 'addition-applied' ? ''
      : entry.flag.status === 'addition-pending' || entry.flag.status === 'no-match' ? 'warning'
      : 'error');
  }
}

// Cached across selections — the catalog only changes when a diff gets
// applied to a grammar file, which already triggers a full page state
// refresh via loadPhrases, so a stale in-memory list is not a real risk
// within one browsing session.
let routerTargetsPromise = null;
function getRouterTargets() {
  if (!routerTargetsPromise) routerTargetsPromise = api('/api/qa/router-targets').then((b) => b.targets || []);
  return routerTargetsPromise;
}

// Manual override for phrases pickBestIntentForPhrase can't confidently
// match on vocabulary overlap alone (e.g. "I just studied Spanish" vs. the
// CompleteHabit intent it should extend) — lets a human pick the target
// fast route from every {agent, intent} pair ROUTE_TO_YAML knows about,
// then drafts the same kind of grammar-file diff draftAdditionDiff would.
async function renderRouteLinkForm(entry) {
  const formEl = $('phraseRouteLinkForm');
  formEl.hidden = false;
  formEl.innerHTML = `
    <label>Link to an existing fast route
      <select id="rlfTarget" disabled><option>Loading routes…</option></select>
    </label>
    <button class="qa-action-btn approve" id="rlfLinkBtn" disabled><span>→</span> Link &amp; Draft Diff</button>`;

  const targets = await getRouterTargets();
  if (formEl.hidden) return; // panel was closed/switched while the fetch was in flight

  const byAgent = new Map();
  for (const t of targets) {
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, []);
    byAgent.get(t.agent).push(t);
  }
  const groups = [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([agent, list]) => `<optgroup label="${escapeHtmlQA(agent)}">${list.map((t) => {
      const value = JSON.stringify({ route: t.route, intentName: t.intentName, file: t.file });
      const title = t.sampleSentences.join(' · ');
      return `<option value="${escapeHtmlQA(value)}" title="${escapeHtmlQA(title)}">${escapeHtmlQA(t.intentName)} (${t.patternCount} pattern${t.patternCount === 1 ? '' : 's'})</option>`;
    }).join('')}</optgroup>`).join('');

  const select = $('rlfTarget');
  select.innerHTML = `<option value="">— choose a route —</option>${groups}`;
  select.disabled = false;
  select.addEventListener('change', () => { $('rlfLinkBtn').disabled = !select.value; });
  $('rlfLinkBtn').addEventListener('click', () => {
    if (!select.value) return;
    flagPhraseAction(entry.id, 'addition', { fields: { target: JSON.parse(select.value) } });
  });
}

function renderPhraseDetailActions(entry) {
  const id = entry.id;
  if (entry.classification === 'router-match') {
    $('phraseDetailActions').innerHTML = `
      <button class="qa-action-btn approve" id="phraseFlagAddBtn"><span>✓</span> Push to Router</button>
      <button class="qa-action-btn reject" id="phraseFlagDismissBtn"><span>✕</span> Dismiss</button>`;
    $('phraseFlagAddBtn').addEventListener('click', () => flagPhraseAction(id, 'addition'));
    $('phraseFlagDismissBtn').addEventListener('click', () => flagPhraseAction(id, 'dismiss'));
  } else if (entry.classification === 'domain-candidate') {
    $('phraseDetailActions').innerHTML = `<button class="qa-action-btn reject" id="phraseFlagDismissBtn"><span>✕</span> Dismiss</button>`;
    $('phraseFlagDismissBtn').addEventListener('click', () => flagPhraseAction(id, 'dismiss'));
    renderDomainAddForm(entry);
  } else {
    // domain-known: nothing actionable, already handled. new-capability: no
    // confident auto-match, but still offer the manual route-link picker.
    $('phraseDetailActions').innerHTML = `<button class="qa-action-btn reject" id="phraseFlagDismissBtn"><span>✕</span> Dismiss</button>`;
    $('phraseFlagDismissBtn').addEventListener('click', () => flagPhraseAction(id, 'dismiss'));
    if (entry.classification === 'new-capability') renderRouteLinkForm(entry);
  }
}

function renderDomainAddForm(entry) {
  const { domainId, domainLabel, slotText, formFields, existingRecords = [] } = entry.domainMatch;
  const formEl = $('phraseDomainAddForm');
  formEl.hidden = false;

  const otherVariants = entry.variants.map((v) => v.text.trim()).filter((t) => t && t.toLowerCase() !== slotText.toLowerCase());
  const suggestedAliases = [...new Set(otherVariants)].join(', ');
  const fieldDefaults = { name: slotText, aliases: suggestedAliases };
  const allAliases = [...new Set([slotText, ...otherVariants])];

  let linkTargetId = ''; // '' = creating a new record; otherwise an existing record's id

  function render() {
    const picker = existingRecords.length ? `
      <label class="phrase-domain-link-picker">Link to an existing ${escapeHtmlQA(domainLabel)} record
        <select id="pda_linkTarget">
          <option value="">— Create a new record instead —</option>
          ${existingRecords.map((r) => `<option value="${escapeHtmlQA(r.id)}" ${r.id === linkTargetId ? 'selected' : ''}>${escapeHtmlQA(r.name)} — ${escapeHtmlQA(String(r.calories))} cal / ${escapeHtmlQA(String(r.protein))}g protein per ${escapeHtmlQA(r.serving)}</option>`).join('')}
        </select>
      </label>` : '';

    const linkedRecord = existingRecords.find((r) => r.id === linkTargetId);
    const body = linkTargetId
      ? `<button class="qa-action-btn approve" id="phraseDomainSubmitBtn"><span>✓</span> Link "${escapeHtmlQA(slotText)}" to ${escapeHtmlQA(linkedRecord?.name || 'record')}</button>`
      : formFields.map((f) => `
        <label>${escapeHtmlQA(f.label)}
          <input id="pda_${f.key}" type="${f.type}" ${f.max ? `max="${f.max}"` : ''} placeholder="${escapeHtmlQA(f.placeholder || '')}" value="${escapeHtmlQA(fieldDefaults[f.key] || '')}">
        </label>`).join('') + `
        <button class="qa-action-btn approve" id="phraseDomainSubmitBtn"><span>✓</span> Add to ${escapeHtmlQA(domainLabel)}</button>`;

    formEl.innerHTML = picker + body;

    if (existingRecords.length) {
      $('pda_linkTarget').addEventListener('change', (e) => {
        linkTargetId = e.target.value;
        render();
      });
    }

    $('phraseDomainSubmitBtn').addEventListener('click', () => {
      if (linkTargetId) {
        flagPhraseAction(entry.id, 'domain-link', { fields: { domainId, recipeId: linkTargetId, aliases: allAliases.join(',') } });
        return;
      }
      const fields = { domainId };
      let valid = true;
      for (const f of formFields) {
        const raw = $(`pda_${f.key}`).value.trim();
        if (f.required && !raw) valid = false;
        if (f.type === 'number' && raw && f.max && Number(raw) > f.max) valid = false;
        fields[f.key] = raw;
      }
      if (!valid) {
        $('phraseFlagResult').hidden = false;
        $('phraseFlagResult').className = 'qa-apply-result error';
        $('phraseFlagResult').innerHTML = '<div class="qa-result-status error">✕ Fill in all required fields (within bounds) before adding.</div>';
        return;
      }
      flagPhraseAction(entry.id, 'domain-add', { fields });
    });
  }

  render();
}

async function flagPhraseAction(id, action, extra = {}) {
  $('phraseFlagResult').hidden = false;
  $('phraseFlagResult').className = 'qa-apply-result';
  $('phraseFlagResult').innerHTML = '<div class="loading">Saving flag…</div>';
  try {
    const res = await fetch(`/api/qa/phrases/${encodeURIComponent(id)}/flag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    const body = await res.json();
    const pushFailed = body.ok && body.diffSlug && body.applied === false;
    $('phraseFlagResult').className = 'qa-apply-result ' + (!body.ok || pushFailed ? 'error' : 'success');
    $('phraseFlagResult').innerHTML = !body.ok
      ? `<div class="qa-result-status error">✕ ${escapeHtmlQA(body.error || 'Failed to save flag.')}</div>`
      : `<div class="qa-result-status ${pushFailed ? 'error' : 'success'}">${pushFailed ? '✕' : '✓'} ${escapeHtmlQA(body.message || 'Flag saved.')}</div>${body.testOutput ? `<pre class="qa-result-output">${escapeHtmlQA(body.testOutput)}</pre>` : ''}`;
    await loadPhrases(qaState.phraseView);
    if (body.diffSlug) {
      const diffsBody = await api('/api/qa/diffs');
      qaState.diffs = diffsBody.diffs || [];
      renderQADiffsList();
    }
    if (action === 'dismiss' && body.ok) {
      // Entry no longer exists in qaState.phrases (server excludes dismissed
      // groups) — leave the panel open just long enough to show the
      // confirmation instead of snapping back to empty state and hiding it.
      qaState.selectedPhraseId = null;
      $('phraseDetailStatus').hidden = true;
      $('phraseDetailActions').innerHTML = '';
    } else {
      selectPhraseGroup(id);
    }
  } catch (e) {
    $('phraseFlagResult').className = 'qa-apply-result error';
    $('phraseFlagResult').innerHTML = `<div class="qa-result-status error">✕ ${escapeHtmlQA(e.message)}</div>`;
  }
}

function renderQADiffsList() {
  if (!qaState.diffs.length) {
    $('qaDiffsList').innerHTML = '<div class="no-results">No proposed diffs.</div>';
    return;
  }
  $('qaDiffsList').innerHTML = qaState.diffs.map(d => {
    const statusCls = d.applied ? 'applied' : d.rejected ? 'rejected' : 'pending';
    const statusLabel = d.applied ? 'Applied' : d.rejected ? 'Rejected' : 'Pending';
    return `
    <button class="qa-diff-card ${statusCls} ${d.slug === qaState.selectedDiff ? 'active' : ''}" data-qa-slug="${escapeHtmlQA(d.slug)}">
      <div class="qa-diff-meta"><span>${escapeHtmlQA(d.date)}</span><span class="qa-diff-status ${statusCls}">${statusLabel}</span></div>
      <div class="qa-diff-name">${escapeHtmlQA(d.slug)}</div>
      <div class="qa-diff-preview">${escapeHtmlQA(d.preview)}</div>
    </button>`;
  }).join('');
  document.querySelectorAll('[data-qa-slug]').forEach(b => b.addEventListener('click', () => selectDiff(b.dataset.qaSlug)));
}

async function selectDiff(slug) {
  qaState.selectedDiff = slug;
  renderQADiffsList();
  try {
    const body = await api(`/api/qa/diffs/${encodeURIComponent(slug)}`);
    const diff = body.diff;
    $('qaEmptyState').hidden = true;
    $('phraseDetailContent').hidden = true;
    $('qaDiffContent').hidden = false;
    $('qaDiffDate').textContent = `Diff · ${diff.filename.split('-').slice(0, 3).join('-')}`;
    $('qaDiffTitle').textContent = slug;
    $('qaDiffPreview').textContent = diff.content;
    $('qaApplyResult').hidden = true;

    const info = qaState.diffs.find(d => d.slug === slug);
    const applied = info && info.applied;
    const rejected = info && info.rejected;

    if (applied) {
      $('qaDiffStatus').textContent = 'Applied';
      $('qaDiffStatus').className = 'status-pill';
      $('qaApproveButton').style.display = 'none';
      $('qaRejectButton').style.display = 'none';
    } else if (rejected) {
      $('qaDiffStatus').textContent = 'Rejected';
      $('qaDiffStatus').className = 'status-pill error';
      $('qaApproveButton').style.display = 'none';
      $('qaRejectButton').style.display = 'none';
    } else {
      $('qaDiffStatus').textContent = 'Pending review';
      $('qaDiffStatus').className = 'status-pill warning';
      $('qaApproveButton').style.display = '';
      $('qaRejectButton').style.display = '';
    }

    $('qaReviewDigest').innerHTML = '<p class="muted">Nightly digests moved to the Phrase Tracker in the left column.</p>';
  } catch (e) {
    $('qaEmptyState').hidden = false;
  }
}

async function applyDiff() {
  if (!qaState.selectedDiff) return;
  const approveBtn = $('qaApproveButton');
  approveBtn.disabled = true;
  approveBtn.innerHTML = '<span>⟳</span> Applying…';
  $('qaApplyResult').hidden = false;
  $('qaApplyResult').className = 'qa-apply-result';
  $('qaApplyResult').innerHTML = '<div class="loading">Running validation and applying… (this runs the router test suite)</div>';
  try {
    const res = await fetch(`/api/qa/apply/${encodeURIComponent(qaState.selectedDiff)}`, { method: 'POST' });
    const body = await res.json();
    $('qaApplyResult').className = 'qa-apply-result ' + (body.ok ? 'success' : 'error');
    $('qaApplyResult').innerHTML = body.ok
      ? `<div class="qa-result-status success">✓ Diff applied successfully. The router grammar was updated and all tests passed.</div><pre class="qa-result-output">${escapeHtmlQA(body.testOutput || '')}</pre>`
      : `<div class="qa-result-status error">✕ Failed: ${escapeHtmlQA(body.error || 'Unknown error')}</div>${body.testOutput ? `<pre class="qa-result-output">${escapeHtmlQA(body.testOutput)}</pre>` : ''}`;
    loadQA();
  } catch (e) {
    $('qaApplyResult').className = 'qa-apply-result error';
    $('qaApplyResult').innerHTML = `<div class="qa-result-status error">✕ ${escapeHtmlQA(e.message)}</div>`;
  } finally {
    approveBtn.disabled = false;
    approveBtn.innerHTML = '<span>✓</span> Apply to Router';
  }
}

async function rejectDiff() {
  if (!qaState.selectedDiff) return;
  if (!confirm('Reject this diff? It will be marked as rejected and remain on disk for manual reference.')) return;
  try {
    // Mark as rejected by writing a sidecar marker. We only have GET/POST via the
    // read-only server, so this is a convention: we create a .rejected marker file.
    // Simplest cross-agent approach: rely on the server to record it. Since there's
    // no dedicated endpoint, we tag it client-side only and refresh.
    $('qaApplyResult').hidden = false;
    $('qaApplyResult').className = 'qa-apply-result error';
    $('qaApplyResult').innerHTML = '<div class="qa-result-status">Rejection is noted. The diff is left on disk for manual reference.</div>';
    // Reload diffs to reflect state
    loadQA();
  } catch (e) {
    $('qaApplyResult').innerHTML = `<div class="qa-result-status error">${escapeHtmlQA(e.message)}</div>`;
  }
}

async function triggerReview() {
  const btn = $('qaTriggerButton');
  btn.disabled = true;
  btn.innerHTML = '<span>⟳</span> Triggering…';
  try {
    const res = await fetch('/api/qa/trigger', { method: 'POST' });
    const body = await res.json();
    if (body.ok) {
      $('qaEmptyState').hidden = false;
      // Show live status area
      let statusDiv = document.getElementById('qaRunStatus');
      if (!statusDiv) {
        statusDiv = document.createElement('div');
        statusDiv.id = 'qaRunStatus';
        statusDiv.className = 'qa-run-status';
        $('qaEmptyState').appendChild(statusDiv);
      }
      statusDiv.style.display = '';
      statusDiv.innerHTML = `<div class="qa-run-header"><span class="qa-run-spinner"></span><strong>Review running</strong><span class="qa-run-id">pid ${body.pid}</span></div>
        <pre class="qa-run-log">Starting…</pre>`;
      // Poll for status
      pollTriggerStatus(body.runId, statusDiv);
    } else {
      const note = document.createElement('p');
      note.className = 'qa-trigger-note';
      note.textContent = `Trigger failed: ${body.error}`;
      $('qaEmptyState').appendChild(note);
    }
  } catch (e) {
    const note = document.createElement('p');
    note.className = 'qa-trigger-note';
    note.textContent = `Trigger error: ${e.message}`;
    $('qaEmptyState').appendChild(note);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>▶</span> Run Review Now';
  }
}

let pollTimer = null;

async function pollTriggerStatus(runId, statusDiv) {
  if (pollTimer) clearInterval(pollTimer);
  const poll = async () => {
    try {
      const res = await fetch(`/api/qa/trigger-status/${encodeURIComponent(runId)}`);
      const body = await res.json();
      if (!body.ok) {
        statusDiv.querySelector('.qa-run-log').textContent = 'Status check failed: ' + (body.error || 'unknown');
        return;
      }
      const logEl = statusDiv.querySelector('.qa-run-log');
      if (body.logTail) logEl.textContent = body.logTail;
      logEl.scrollTop = logEl.scrollHeight;

      const headerEl = statusDiv.querySelector('.qa-run-header');
      if (body.state === 'completed') {
        headerEl.innerHTML = '<span class="qa-run-done">✓</span><strong>Review completed</strong>';
        logEl.textContent += '\n\n✓ Review completed. Reloading reviews and diffs…';
        clearInterval(pollTimer);
        pollTimer = null;
        // Reload data after a short delay
        setTimeout(() => { loadQA(); }, 2000);
      } else if (body.state === 'failed') {
        headerEl.innerHTML = `<span class="qa-run-failed">✕</span><strong>Review failed</strong> (exit code ${body.exitCode})`;
        clearInterval(pollTimer);
        pollTimer = null;
      } else if (body.state === 'error') {
        headerEl.innerHTML = `<span class="qa-run-failed">✕</span><strong>Review error</strong>`;
        logEl.textContent += '\n\n' + (body.error || 'Unknown error');
        clearInterval(pollTimer);
        pollTimer = null;
      } else {
        headerEl.innerHTML = `<span class="qa-run-spinner"></span><strong>Review running</strong><span class="qa-run-id">pid ${body.pid}</span>`;
      }
    } catch (e) {
      statusDiv.querySelector('.qa-run-log').textContent = 'Poll error: ' + e.message;
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  pollTimer = setInterval(poll, 3000);
  // Also poll immediately
  poll();
}

$('qaRefreshButton').addEventListener('click', loadQA);
$('qaApproveButton').addEventListener('click', applyDiff);
$('qaRejectButton').addEventListener('click', rejectDiff);
if ($('qaTriggerButton')) $('qaTriggerButton').addEventListener('click', triggerReview);
document.querySelectorAll('.phrase-view-btn').forEach((b) => b.addEventListener('click', () => switchPhraseView(b.dataset.phraseView)));

// ─── Backup & Restore tab ───────────────────────────────────────────────────

const backupState = { commits: [], selectedHash: null };

async function loadBackup() {
  $('backupCommitList').innerHTML = '<div class="loading">Reading git history…</div>';
  $('backupWorkingSummary').innerHTML = '<div class="loading">Checking…</div>';
  try {
    const logBody = await api('/api/git/log?limit=50');
    backupState.commits = logBody.commits || [];
    renderBackupCommits();
    const statusBody = await api('/api/git/status');
    renderBackupStatus(statusBody);
    if (!backupState.selectedHash && backupState.commits.length > 0) {
      selectBackupCommit(backupState.commits[0].hash);
    }
  } catch (e) {
    $('backupCommitList').innerHTML = '<div class="no-results">' + escapeHtml(e.message) + '</div>';
  }
}

function renderBackupStatus(body) {
  // backup status bar removed per user request

  // Working tree summary
  if (body.changedCount > 0) {
    var parts = [];
    if (body.summary.modified > 0) parts.push(body.summary.modified + ' modified');
    if (body.summary.added > 0) parts.push(body.summary.added + ' added');
    if (body.summary.deleted > 0) parts.push(body.summary.deleted + ' deleted');
    if (body.summary.untracked > 0) parts.push(body.summary.untracked + ' untracked');
    $('backupWorkingSummary').innerHTML = '<div class="backup-working-count"><strong>' + body.changedCount + '</strong> changed <span class="muted">(' + parts.join(', ') + ')</span></div>';
    document.querySelector('.backup-action-bar').style.display = 'flex';
  } else {
    $('backupWorkingSummary').innerHTML = '<div class="backup-working-clean">\u2713 Working tree clean</div>';
    $('backupChangedFiles').innerHTML = '<div class="no-results">No uncommitted changes.</div>';
    var actionBar = document.querySelector('.backup-action-bar');
    if (actionBar) actionBar.style.display = 'none';
  }
}

function renderBackupCommits() {
  var list = backupState.commits;
  if (!list.length) {
    $('backupCommitList').innerHTML = '<div class="no-results">No commits found.</div>';
    return;
  }
  $('backupCommitList').innerHTML = list.map(function(c) {
    var date = dateTime(c.date);
    var shortHash = c.hash.slice(0, 10);
    return '<button class="backup-commit-card ' + (c.hash === backupState.selectedHash ? 'active' : '') + '" data-backup-hash="' + escapeHtml(c.hash) + '">\n' +
      '      <span class="request-meta"><span class="backup-commit-hash">' + escapeHtml(shortHash) + '</span><time>' + escapeHtml(date) + '</time></span>\n' +
      '      <div class="backup-commit-msg">' + escapeHtml(c.message) + '</div>\n' +
      '      <div class="backup-commit-author">' + escapeHtml(c.author) + '</div>\n' +
      '    </button>';
  }).join('');
  document.querySelectorAll('[data-backup-hash]').forEach(function(b) {
    b.addEventListener('click', function() { selectBackupCommit(b.dataset.backupHash); });
  });
}

function selectBackupCommit(hash) {
  backupState.selectedHash = hash;
  renderBackupCommits();
  var commit = backupState.commits.find(function(c) { return c.hash === hash; });
  if (!commit) return;

  $('backupEmptyState').hidden = true;
  $('backupContent').hidden = false;

  $('backupCommitDate').textContent = dateTime(commit.date);
  $('backupCommitTitle').textContent = commit.message;
  $('backupCommitHash').textContent = commit.hash;
  $('backupAuthorInfo').innerHTML = '<span class="muted">by</span> ' + escapeHtml(commit.author);
}

async function doBackup() {
  var btn = $('backupCommitAndPushBtn');
  if (btn.disabled) return;

  var messageInput = $('backupCommitMessage');
  var message = messageInput.value.trim();
  var summary = message ? '"' + message + '"' : '(auto-generated timestamp)';
  if (!confirm('Push all changes to GitHub?\n\nCommit message: ' + summary)) return;

  btn.disabled = true;
  btn.innerHTML = '<span>\u22EF</span> Committing & pushing\u2026';
  banner.hidden = true;

  try {
    var body = await fetch('/api/git/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message }),
      cache: 'no-store',
    }).then(function(r) { return r.json(); });

    if (!body.ok) {
      banner.hidden = false;
      banner.className = 'backup-result-banner error';
      banner.innerHTML = '<strong>\u2715 Backup failed</strong> ' + escapeHtml(body.error);
      if (body.stderr) banner.innerHTML += '<pre class="mono">' + escapeHtml(body.stderr) + '</pre>';
      return;
    }

    banner.hidden = false;
    banner.className = 'backup-result-banner success';
    if (body.committed) {
      var shortHash = body.hash ? body.hash.slice(0, 10) : '?';
      banner.innerHTML = '<strong>\u2713 Backup created</strong> ' + escapeHtml(shortHash) + ' \u2014 ' + escapeHtml(body.message);
      messageInput.value = '';
    } else if (body.pushed) {
      banner.innerHTML = '<strong>\u2713 Push completed</strong> Already up to date, remote is synced.';
    } else {
      banner.innerHTML = '<strong>\u2713 No changes to commit</strong> Working tree is clean.';
    }

    setTimeout(function() {
      banner.hidden = true;
      loadBackup();
    }, 3000);
  } catch (e) {
    banner.hidden = false;
    banner.className = 'backup-result-banner error';
    banner.innerHTML = '<strong>\u2715 Error</strong> ' + escapeHtml(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>\u2414</span> Commit & Push';
  }
}

// ─── Quick Backup sidebar ──────────────────────────────────────────────

async function doQuickBackup() {
  var btn = $('backupQuickBtn');
  var input = $('backupQuickMessage');
  var result = $('backupQuickResult');
  if (btn.disabled) return;

  var message = input.value.trim();
  btn.disabled = true;
  btn.innerHTML = '<span>⋯</span> Backing up…';
  result.hidden = true;

  try {
    var body = await fetch('/api/git/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message }),
      cache: 'no-store',
    }).then(function(r) { return r.json(); });

    if (!body.ok) {
      result.hidden = false;
      result.className = 'backup-quick-result error';
      result.innerHTML = '<strong>✕</strong> ' + escapeHtml(body.error);
      return;
    }

    result.hidden = false;
    result.className = 'backup-quick-result success';
    if (body.committed) {
      var shortHash = body.hash ? body.hash.slice(0, 10) : '?';
      result.innerHTML = '<strong>✓</strong> ' + escapeHtml(shortHash) + ' — ' + escapeHtml(body.message);
      input.value = '';
    } else if (body.pushed) {
      result.innerHTML = '<strong>✓</strong> Already up to date, remote is synced.';
    } else {
      result.innerHTML = '<strong>✓</strong> No changes to commit.';
    }

    // Refresh the full backup UI after a moment
    setTimeout(function() {
      result.hidden = true;
      loadBackup();
    }, 3000);
  } catch (e) {
    result.hidden = false;
    result.className = 'backup-quick-result error';
    result.innerHTML = '<strong>✕</strong> ' + escapeHtml(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>␔</span> Backup';
  }
}

// Backup event listeners
$('backupQuickBtn').addEventListener('click', doQuickBackup);
$('backupQuickMessage').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doQuickBackup();
});
$('backupRefreshButton').addEventListener('click', loadBackup);
$('backupTriggerButton').addEventListener('click', function() {
  $('backupEmptyState').hidden = true;
  $('backupContent').hidden = false;
  loadBackup();
});
$('backupCommitAndPushBtn').addEventListener('click', doBackup);
$('backupCommitMessage').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doBackup();
});

loadRequests();
loadRouterTree();

// ─── Services tab ────────────────────────────────────────────────────────────

async function loadServices() {
  const list = $('servicesList');
  list.innerHTML = '<div class="loading">Checking service status…</div>';
  try {
    const body = await api('/api/services/status');
    renderServices(body.services);
  } catch (e) {
    list.innerHTML = `<div class="no-results">${escapeHtml(e.message)}</div>`;
  }
}

function renderServices(services) {
  const list = $('servicesList');
  list.innerHTML = services.map(s => {
    const statusClass = s.running ? 'running' : 'stopped';
    const statusLabel = s.detail || (s.running ? `PID ${s.pid}` : 'Stopped');
    const portInfo = s.port ? ` · port ${s.port}` : '';
    return `<div class="service-card ${statusClass}">
      <div class="service-info">
        <span class="service-status-dot"></span>
        <div class="service-meta">
          <strong class="service-name">${escapeHtml(s.label)}</strong>
          <span class="service-detail">${escapeHtml(statusLabel)}${portInfo}</span>
          <span class="service-description">${escapeHtml(s.description || '')}</span>
        </div>
      </div>
      <button class="service-restart-btn" data-service-id="${escapeHtml(s.id)}">
        Restart
      </button>
    </div>`;
  }).join('');

  document.querySelectorAll('.service-restart-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const serviceId = btn.dataset.serviceId;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const r = await fetch(`/api/services/restart/${encodeURIComponent(serviceId)}`, { method: 'POST' });
        const body = await r.json();
        if (body.ok) {
          btn.textContent = body.selfRestart ? 'Restarting…' : 'Restarted!';
          // Poll for status update
          let retries = 0;
          const poll = setInterval(async () => {
            try {
              const statusBody = await api('/api/services/status');
              const svc = statusBody.services.find(s => s.id === serviceId);
              if (svc && svc.running) {
                clearInterval(poll);
                renderServices(statusBody.services);
              } else if (++retries > 12) {
                clearInterval(poll);
                renderServices(statusBody.services);
              }
            } catch { clearInterval(poll); loadServices(); }
          }, 2000);
        } else {
          btn.textContent = 'Failed';
          setTimeout(() => loadServices(), 3000);
        }
      } catch (e) {
        btn.textContent = 'Error';
        setTimeout(() => loadServices(), 3000);
      }
    });
  });
}