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
  { id:'phone',    label:'iMessage',      x:12, y:6,  group:'input',    icon:'💬', detail:'iMessage via imsg CLI → Gateway' },
  { id:'voice',    label:'Voice / Jarvis', x:33, y:6,  group:'input',    icon:'🎤', detail:'Home Assistant Voice PE → Voice Adapter' },
  { id:'kiosk',    label:'Kiosk',         x:58, y:6,  group:'input',    icon:'🖥️', detail:'Echo Show dashboard → Dashboard API' },
  { id:'cron',     label:'Cron / System', x:82, y:6,  group:'input',    icon:'⏰', detail:'Scheduled jobs, heartbeats → Gateway' },

  // Row 2 — Processing
  { id:'gateway',  label:'Gateway',       x:15, y:22, group:'process',  icon:'⚡', detail:'Core router — port 18789, WebSocket JSON-RPC' },
  { id:'adapter',  label:'Voice Adapter',  x:33, y:22, group:'process',  icon:'🔊', detail:'ha-voice-adapter — port 18796' },
  { id:'dashapi',  label:'Dashboard API',  x:82, y:22, group:'process',  icon:'📊', detail:'Port 18795 — data mutation endpoint' },

  // Row 2.5 — Shared Intent Routing (between Processing and Agents,
  // positioned to show it serves both iMessage→Gateway and Voice→Adapter)
  { id:'router',   label:'Routine Router', x:24, y:33, group:'process',  icon:'🔀', detail:'Shared intent router — deterministic routing for iMessage & Voice' },

  // Row 3 — Chief of Staff
  { id:'main',     label:'Chief of Staff', x:45, y:47, group:'agent',   icon:'🧠', detail:'main agent — owns conversations, delegates tasks' },

  // Row 4 — Sub-agents (spread across)
  { id:'sched',    label:'scheduler',      x:8,  y:64, group:'subagent',icon:'📅', detail:'Calendar ops — DeepSeek via OpenRouter' },
  { id:'health',   label:'health-tracker', x:20, y:64, group:'subagent',icon:'❤️', detail:'Food logging, nutrition — DeepSeek via OpenRouter' },
  { id:'goals',    label:'goals',          x:32, y:64, group:'subagent',icon:'🎯', detail:'Daily habits — local Ollama' },
  { id:'boards',   label:'boards',         x:44, y:64, group:'subagent',icon:'📋', detail:'Task boards — local Ollama' },
  { id:'lists',    label:'lists',          x:56, y:64, group:'subagent',icon:'📝', detail:'Custom lists — local Ollama' },
  { id:'meal',     label:'meal-planner',   x:68, y:64, group:'subagent',icon:'🍽️', detail:'Meals & grocery — DeepSeek via OpenRouter' },
  { id:'finance',  label:'finance-agent',  x:80, y:64, group:'subagent',icon:'💰', detail:'Finance queries — local Ollama' },
  { id:'research', label:'research',       x:13, y:78, group:'subagent',icon:'🔍', detail:'Web search Q&A — DeepSeek via OpenRouter' },
  { id:'systemsqa',label:'systems-qa',     x:30, y:78, group:'subagent',icon:'🔧', detail:'Diagnostics — local Ollama, fire-and-forget' },
  { id:'sports',   label:'sports-betting', x:47, y:78, group:'subagent',icon:'🏈', detail:'Discord betting — local Ollama' },

  // Row 5 — Models / Storage
  { id:'ollama',   label:'Ollama',         x:18, y:90, group:'storage', icon:'🖥️', detail:'Local LLM — port 11434, llama3.1:8b' },
  { id:'openrouter',label:'OpenRouter',    x:38, y:90, group:'storage', icon:'☁️', detail:'Cloud frontier models — Haiku, DeepSeek' },
  { id:'json',     label:'JSON Files',     x:75, y:90, group:'storage', icon:'📁', detail:'Task boards, habits, grocery, lists' },
  { id:'financedb',label:'finance.db',     x:90, y:90, group:'storage', icon:'💾', detail:'SQLite — transactions, expenses, budgets' },
];

// Edges: [fromId, toId, label]
const NETWORK_EDGES = [
  ['phone',   'gateway',  'imsg'],
  ['voice',   'adapter',  'WebSocket'],
  ['adapter', 'router',   'fast path'],
  ['adapter', 'gateway',  'fallback'],
  ['gateway', 'router',   'claim'],
  ['gateway', 'main',     'route'],
  ['kiosk',   'dashapi',  'HTTP bearer'],
  ['cron',    'gateway',  'heartbeat'],
  ['main',    'sched',    'sessions_send'],
  ['main',    'health',   'sessions_send'],
  ['main',    'goals',    'sessions_send'],
  ['main',    'boards',   'sessions_send'],
  ['main',    'lists',    'sessions_send'],
  ['main',    'meal',     'sessions_send'],
  ['main',    'finance',  'sessions_send'],
  ['main',    'research', 'sessions_send'],
  ['main',    'systemsqa','fire-and-forget'],
  ['main',    'sports',   'sessions_send'],
  ['main',    'ollama',   'fallback'],
  ['main',    'openrouter','primary model'],
  ['router',  'health',   'route intent'],
  ['router',  'sched',    'route intent'],

  ['health',  'dashapi',  'sync'],
  ['sched',   'dashapi',  'sync'],
  ['goals',   'dashapi',  'sync'],
  ['boards',  'dashapi',  'sync'],
  ['lists',   'dashapi',  'sync'],
  ['meal',    'dashapi',  'sync'],
  ['finance', 'financedb','SQLite'],
  ['dashapi',  'json',    'read/write'],
  ['dashapi',  'financedb','read'],
];

// Map channel/agent IDs to node IDs for highlighting
const CHANNEL_TO_NODE = {
  imessage:         ['phone', 'gateway'],
  'voice-fastpath': ['voice', 'adapter', 'router'],
  voice:            ['voice', 'adapter', 'gateway', 'main'],
  kiosk:            ['kiosk', 'dashapi'],
  heartbeat:        ['cron', 'gateway'],
};

const AGENT_TO_NODE = {
  scheduler:            ['sched'],
  'health-tracker':     ['health'],
  goals:                ['goals'],
  boards:               ['boards'],
  lists:                ['lists'],
  'meal-planner':       ['meal'],
  'finance-agent':      ['finance'],
  research:             ['research'],
  'systems-qa':         ['systemsqa'],
  'sports-betting':     ['sports'],
  'shared-routine-router': ['router'],
  'dashboard-api':       ['dashapi'],
  main:                 ['main'],
};

// Maps a deterministic router route to the sub-agent that handles it
function routeToAgent(route) {
  switch (route) {
    case 'workout-log':
    case 'daily-run-log':
      return 'health-tracker';
    case 'calendar-add':
      return 'scheduler';
    case 'finance-balance':
    case 'finance-budget-forecast':
      return 'finance-agent';
    case 'nevermind-cancel':
      return null;
    default:
      if (route && route.startsWith('dashboard-')) return 'dashboard-api';
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
NODE_TO_AGENT_IDS['gateway'] = ['main']; // gateway is part of the main agent flow
NODE_TO_AGENT_IDS['adapter'] = ['voice-adapter'];
NODE_TO_AGENT_IDS['dashapi'] = ['dashboard-api'];
NODE_TO_AGENT_IDS['ollama'] = ['ollama'];
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

async function loadRequests() {
  $('requestList').innerHTML = '<div class="loading">Reading OpenClaw evidence…</div>';
  const params = new URLSearchParams({ limit:'200' });
  if (state.query) params.set('query', state.query);
  if (state.status) params.set('status', state.status);
  try {
    const body = await api(`/api/requests?${params}`);
    state.requests = body.requests;
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

  // Always include Main and Gateway for agent-based requests
  // For the routine router path: highlight the sub-agent the route dispatched to
  if (trace.agents && trace.agents.includes('shared-routine-router')) {
    // highlight adapter→router edge too
    edgeIdsToHighlight.add('adapter-router');
    // highlight router→sub-agent edges for any additional agents
    for (const agentId of trace.agents) {
      if (agentId !== 'shared-routine-router') {
        const agentNodes = AGENT_TO_NODE[agentId];
        if (agentNodes) {
          for (const nodeId of agentNodes) {
            const edgeKey = `router-${nodeId}`;
            if (document.querySelector(`[data-edge-id="${edgeKey}"]`)) {
              edgeIdsToHighlight.add(edgeKey);
            }
          }
        }
      }
    }
  }

  // Also include Main + Gateway for non-router agent-based requests
  if (trace.agents && trace.agents.length > 0 && !trace.agents.includes('shared-routine-router') && !trace.agents.includes('dashboard-api')) {
    highlightIds.add('main');
    highlightIds.add('gateway');
  }

  // From models used
  for (const model of (trace.models || [])) {
    if (model.local) { highlightIds.add('ollama'); }
    else { highlightIds.add('openrouter'); }
  }

  // Downstream data flow: when a sub-agent that syncs to the Dashboard API
  // is highlighted, also highlight dashapi and kiosk so the full data path
  // (agent → Dashboard API → Kiosk display) is visible on the map.
  // Sub-agents that sync: health, sched, goals, boards, lists, meal
  const SYNC_TO_DASHAPI = new Set(['health', 'sched', 'goals', 'boards', 'lists', 'meal']);
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

  // Find edges that connect highlighted nodes
  if (highlightIds.size > 0) {
    for (const [from, to] of NETWORK_EDGES) {
      if (highlightIds.has(from) && highlightIds.has(to)) {
        edgeIdsToHighlight.add(`${from}-${to}`);
      }
    }
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

  // Sort by time
  relatedSpans.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  // ── Upstream Dependencies section (voice adapter specific) ──────────
  const upstreamSection = $('nodeUpstreamSection');
  const upstreamList = $('nodeUpstreamList');
  if (nodeId === 'adapter' || agentIds.includes('voice-adapter')) {
    upstreamSection.hidden = false;
    // whisper-mlx is the STT service upstream of the voice adapter.
    // It runs Whisper via Apple's MLX framework on the Mac GPU (Metal).
    // If it goes down, voice commands fail before reaching the adapter.
    const traceHasVoice = trace && (trace.channel === 'voice' || trace.channel === 'voice-fastpath');
    const sttStatus = traceHasVoice ? 'active in this request' : 'idle';
    upstreamList.innerHTML = `
      <div class="node-upstream-item">
        <span class="up-icon">🎤</span>
        <span class="up-label">whisper-mlx</span>
        <span class="up-detail">Speech-to-text · Apple MLX GPU · port 10300</span>
        <span class="up-status ${traceHasVoice ? 'active' : 'idle'}">${sttStatus}</span>
      </div>
    `;
  } else {
    upstreamSection.hidden = true;
  }

  // ── Activity section ─────────────────────────────────────────────────
  const activitySection = $('nodeActivitySection');
  const activityList = $('nodeActivityList');
  if (relatedSpans.length > 0) {
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

  // ── Data Sources section (health-tracker specific) ───────────────────
  const dsSection = $('nodeDataSourcesSection');
  const dsList = $('nodeDataSourceList');
  if (nodeId === 'health' || agentIds.includes('health-tracker')) {
    dsSection.hidden = false;
    // Examine tool call evidence to determine which data sources were hit
    const toolSpans = relatedSpans.filter(s => s.kind === 'tool' || s.kind === 'delegation');
    const sources = [
      { id:'staple', icon:'⭐', label:'Staple foods', tool:'find-staple', result:null, badges:[] },
      { id:'usda', icon:'🌾', label:'USDA nutrition index', tool:'search', result:null, badges:[] },
      { id:'recipe', icon:'📖', label:'Recipe library', tool:'find-recipe', result:null, badges:[] },
      { id:'estimate', icon:'🤖', label:'Haiku estimate', tool:'haiku', result:null, badges:[] },
    ];
    for (const source of sources) {
      const match = toolSpans.filter(s => {
        const name = (s.toolName || s.title || '').toLowerCase();
        return name.includes(source.tool.toLowerCase());
      });
      if (match.length > 0) {
        // Check the result evidence
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
      // Special: recipe lookup is not implemented yet
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
  } else {
    routingSection.hidden = true;
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
  if (relatedSpans.length > 0) {
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
document.querySelectorAll('.filter').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach(c => c.classList.toggle('active', c === b));
  state.status = b.dataset.status;
  state.selectedRequestId = null;
  loadRequests();
}));
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

// ─── Fast Router Proposals tab ────────────────────────────────────────────────

const qaState = { phraseView: 'frequency', phrases: { frequency: [], removal: [], recency: [] }, diffs: [], selectedDiff: null, selectedPhraseId: null };

function escapeHtmlQA(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);
}

// Tab switching
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('investigationsView').hidden = tab !== 'investigations';
  $('qaReviewView').hidden = tab !== 'qa-review';
  $('backupView').hidden = tab !== 'backup';
  if (tab === 'qa-review') loadQA();
  if (tab === 'backup') loadBackup();
}

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// Load both the phrase tracker and diffs
async function loadQA() {
  try {
    const diffsBody = await api('/api/qa/diffs');
    qaState.diffs = diffsBody.diffs || [];
    renderQADiffsList();
  } catch (e) {
    $('qaDiffsList').innerHTML = `<div class="no-results">${escapeHtmlQA(e.message)}</div>`;
  }
  await loadPhrases(qaState.phraseView);
}

async function loadPhrases(view) {
  try {
    const body = await api(`/api/qa/phrases?view=${encodeURIComponent(view)}`);
    qaState.phrases[view] = view === 'removal' ? (body.intents || []) : view === 'recency' ? (body.entries || []) : (body.groups || []);
    renderPhraseList();
  } catch (e) {
    $('phraseList').innerHTML = `<div class="no-results">${escapeHtmlQA(e.message)}</div>`;
  }
}

function switchPhraseView(view) {
  if (qaState.phraseView === view) return;
  qaState.phraseView = view;
  qaState.selectedPhraseId = null;
  document.querySelectorAll('.phrase-view-btn').forEach((b) => b.classList.toggle('active', b.dataset.phraseView === view));
  $('phraseDetailContent').hidden = true;
  $('qaDiffContent').hidden = true;
  $('qaEmptyState').hidden = false;
  loadPhrases(view);
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

function targetHintText(entry) {
  if (entry.predictedTarget) return `→ ${entry.predictedTarget.agent || entry.predictedTarget.route} (${entry.predictedTarget.intentName})`;
  if (entry.classification === 'domain-known') return `✓ known to ${entry.domainMatch.domainLabel}`;
  if (entry.classification === 'domain-candidate') return `+ new to ${entry.domainMatch.domainLabel}`;
  return '⚑ no fast-path';
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
  const view = qaState.phraseView;
  const entries = qaState.phrases[view] || [];
  if (!entries.length) {
    $('phraseList').innerHTML = view === 'removal'
      ? '<div class="no-results">No grammar intents have gone unused for 7+ days.</div>'
      : view === 'recency'
      ? '<div class="no-results">No recent utterances found in the current window.</div>'
      : '<div class="no-results">No recurring unmatched phrases in the current window.</div>';
    return;
  }
  if (view === 'removal') {
    $('phraseList').innerHTML = entries.map((entry) => `
      <button class="qa-review-card ${entry.id === qaState.selectedPhraseId ? 'active' : ''}" data-phrase-id="${escapeHtmlQA(entry.id)}">
        <span class="request-meta"><span>${escapeHtmlQA(entry.route)}</span><time>${escapeHtmlQA(relativeDays(entry.daysSinceUsed))}</time></span>
        <div class="qa-review-title">${escapeHtmlQA(entry.intentNames.join(', '))}${flagBadge(entry.flag)}</div>
      </button>`).join('');
  } else if (view === 'recency') {
    $('phraseList').innerHTML = entries.map((entry) => `
      <button class="qa-review-card ${entry.id === qaState.selectedPhraseId ? 'active' : ''}" data-phrase-id="${escapeHtmlQA(entry.id)}">
        <span class="request-meta"><span>${entry.count}×</span><time>${escapeHtmlQA(formatRecencyDate(entry.lastSeenAt))}</time></span>
        <div class="qa-review-title">${escapeHtmlQA(entry.text)}${flagBadge(entry.flag)}</div>
        <div class="phrase-target-hint">${entry.clusteredWith ? '→ grouped with ' + escapeHtmlQA(entry.clusteredWith) + ' (' + entry.clusterCount + '×)' : ''}</div>
      </button>`).join('');
  } else {
    $('phraseList').innerHTML = entries.map((entry) => `
      <button class="qa-review-card ${entry.id === qaState.selectedPhraseId ? 'active' : ''}" data-phrase-id="${escapeHtmlQA(entry.id)}">
        <span class="request-meta"><span>${entry.count}× seen</span><time>${entry.variantCount} variant${entry.variantCount === 1 ? '' : 's'}</time></span>
        <div class="qa-review-title">${escapeHtmlQA(entry.canonicalText)}${flagBadge(entry.flag)}</div>
        <div class="phrase-target-hint">${targetHintText(entry)}</div>
      </button>`).join('');
  }
  document.querySelectorAll('[data-phrase-id]').forEach((b) => b.addEventListener('click', () => selectPhraseGroup(b.dataset.phraseId)));
}

function selectPhraseGroup(id) {
  qaState.selectedPhraseId = id;
  renderPhraseList();
  const view = qaState.phraseView;
  const entry = (qaState.phrases[view] || []).find((e) => e.id === id);
  if (!entry) return;

  $('qaEmptyState').hidden = true;
  $('qaDiffContent').hidden = true;
  $('phraseDetailContent').hidden = false;
  $('phraseFlagResult').hidden = true;
  $('phraseDetailStatus').hidden = true;
  $('phraseTargetBanner').hidden = true;
  $('phraseDomainAddForm').hidden = true;
  $('phraseAgentPathSection').hidden = true;
  $('phraseAgentPathMismatch').hidden = true;

  if (view === 'removal') {
    $('phraseDetailEyebrow').textContent = `Removal candidate · ${entry.route}`;
    $('phraseDetailTitle').textContent = entry.intentNames.join(', ');
    $('phraseListSectionTitle').textContent = 'Grammar patterns';
    $('phraseStatGrid').innerHTML = `
      <div class="phrase-stat-tile"><strong>${escapeHtmlQA(relativeDays(entry.daysSinceUsed))}</strong><span>Last used</span></div>
      <div class="phrase-stat-tile"><strong>${entry.usageCount}</strong><span>Fast-path matches</span></div>
      <div class="phrase-stat-tile"><strong>${escapeHtmlQA(entry.file)}</strong><span>Grammar file</span></div>`;
    $('phraseVariantList').innerHTML = entry.patterns.length
      ? entry.patterns.map((p) => `<div class="phrase-variant-row"><span class="phrase-variant-text mono">${escapeHtmlQA(p)}</span></div>`).join('')
      : '<div class="no-results">No patterns found for this intent.</div>';
    $('phraseDetailActions').innerHTML = `<button class="qa-action-btn reject" id="phraseFlagRemoveBtn"><span>✕</span> Flag for Removal Review</button>`;
    $('phraseFlagRemoveBtn').addEventListener('click', () => flagPhraseAction(id, 'removal-review'));
  } else if (view === 'recency') {
    $('phraseDetailEyebrow').textContent = `Recent · ${entry.count}× in window`;
    $('phraseDetailTitle').textContent = entry.text;
    $('phraseListSectionTitle').textContent = 'Details';
    $('phraseTargetBanner').hidden = true;
    $('phraseStatGrid').innerHTML = `
      <div class="phrase-stat-tile"><strong>${entry.count}</strong><span>Occurrences</span></div>
      <div class="phrase-stat-tile"><strong>${escapeHtmlQA(formatRecencyDate(entry.lastSeenAt))}</strong><span>Last seen</span></div>
      <div class="phrase-stat-tile"><strong>${escapeHtmlQA(new Date(entry.firstSeenAt).toLocaleDateString())}</strong><span>First seen</span></div>
      <div class="phrase-stat-tile"><strong>${entry.channels.join(', ')}</strong><span>Channels</span></div>`;
    $('phraseVariantList').innerHTML = entry.clusteredWith
      ? `<div class="phrase-variant-row"><span class="phrase-variant-text">Part of frequency group: <strong>${escapeHtmlQA(entry.clusteredWith)}</strong> (${entry.clusterCount}× total, ${entry.clusterVariants} variants)</span></div>`
      : '<div class="no-results">This utterance is not grouped with any frequency cluster.</div>';
    $('phraseDetailActions').innerHTML = '';
  } else {
    $('phraseDetailEyebrow').textContent = `Frequency · ${entry.count}× seen`;
    $('phraseDetailTitle').textContent = entry.canonicalText;
    $('phraseListSectionTitle').textContent = 'Variants';

    $('phraseTargetBanner').hidden = false;
    renderTargetBanner(entry);
    renderAgentPath(entry);

    $('phraseStatGrid').innerHTML = `
      <div class="phrase-stat-tile"><strong>${entry.count}</strong><span>Total occurrences</span></div>
      <div class="phrase-stat-tile"><strong>${entry.variantCount}</strong><span>Distinct variants</span></div>
      <div class="phrase-stat-tile"><strong>${escapeHtmlQA(new Date(entry.lastSeenAt).toLocaleDateString())}</strong><span>Last seen</span></div>`;
    $('phraseVariantList').innerHTML = entry.variants.map((v) => `
      <div class="phrase-variant-row">
        <span class="phrase-variant-text">${escapeHtmlQA(v.text)}</span>
        <span class="phrase-variant-count">${v.count}×</span>
      </div>`).join('');

    renderPhraseDetailActions(entry);
  }

  if (entry.flag) {
    $('phraseDetailStatus').hidden = false;
    const domainSettled = entry.flag.status === 'domain-added' || entry.flag.status === 'domain-linked';
    const stale = domainSettled && entry.classification === 'domain-candidate';
    $('phraseDetailStatus').textContent = stale ? 'previously added (not currently found)' : entry.flag.status;
    $('phraseDetailStatus').className = 'status-pill ' + (
      entry.flag.status === 'addition-applied' || domainSettled ? (stale ? 'warning' : '')
      : entry.flag.status === 'addition-pending' || entry.flag.status === 'no-match' ? 'warning'
      : 'error');
  }
}

function renderTargetBanner(entry) {
  const el = $('phraseTargetBanner');
  const cls = entry.classification === 'router-match' ? 'match'
    : entry.classification === 'domain-known' ? 'match'
    : entry.classification === 'domain-candidate' ? 'domain-candidate'
    : 'no-match';
  el.className = 'phrase-target-banner ' + cls;

  if (entry.classification === 'router-match') {
    const t = entry.predictedTarget;
    el.innerHTML = `<strong>Would extend:</strong> ${escapeHtmlQA(t.intentName)} in <code>${escapeHtmlQA(t.file)}</code> → routes to <strong>${escapeHtmlQA(t.agent || t.route)}</strong> <span class="phrase-target-score">(${Math.round(t.score * 100)}% word match)</span>`;
  } else if (entry.classification === 'domain-known') {
    const r = entry.domainMatch.record;
    el.innerHTML = `<strong>Already known:</strong> "${escapeHtmlQA(entry.domainMatch.slotText)}" matches an existing ${escapeHtmlQA(entry.domainMatch.domainLabel)} record${r ? ` — <strong>${escapeHtmlQA(r.name)}</strong> (${escapeHtmlQA(String(r.calories))} cal, ${escapeHtmlQA(String(r.protein))}g protein per ${escapeHtmlQA(r.serving)})` : ''}. No action needed.`;
  } else if (entry.classification === 'domain-candidate') {
    el.innerHTML = `<strong>Not yet known to ${escapeHtmlQA(entry.domainMatch.domainLabel)}:</strong> "${escapeHtmlQA(entry.domainMatch.slotText)}" doesn't match an existing record. Add it with real values below — estimated numbers are never saved automatically.`;
  } else {
    const handled = entry.currentHandlers?.length ? ` Currently handled by: <strong>${entry.currentHandlers.map(escapeHtmlQA).join(' → ')}</strong> via Main.` : '';
    el.innerHTML = `<strong>New-capability candidate.</strong> No router intent or sub-agent fast path can act on this automatically — it's flagged for manual design review, not auto-actionable.${handled}`;
  }
}

// Shows which sub-agent(s) actually handled these utterances historically
// (entry.agentBreakdown, from trace-store's per-request agents[] field), so
// misrouting is visible at a glance regardless of classification — not just
// for new-capability phrases, which is all the target banner covers.
function renderAgentPath(entry) {
  const section = $('phraseAgentPathSection');
  const breakdown = entry.agentBreakdown || [];
  if (!breakdown.length) { section.hidden = true; return; }
  section.hidden = false;

  const maxCount = Math.max(...breakdown.map((h) => h.count));
  $('phraseAgentPathList').innerHTML = breakdown.map((h) => `
    <div class="phrase-agent-row">
      <span class="phrase-agent-name">${escapeHtmlQA(h.agent)}</span>
      <span class="phrase-agent-bar-track"><span class="phrase-agent-bar-fill" style="width:${Math.round((h.count / maxCount) * 100)}%"></span></span>
      <span class="phrase-agent-count">${h.count}×</span>
    </div>`).join('');

  // Only meaningful when something else states an explicit expected target
  // (a router-match or domain match) to compare actual traffic against.
  const expectedAgent = entry.predictedTarget?.agent || entry.domainMatch?.agent || null;
  const topActual = breakdown[0].agent;
  const mismatchEl = $('phraseAgentPathMismatch');
  if (expectedAgent && topActual !== expectedAgent) {
    mismatchEl.hidden = false;
    mismatchEl.innerHTML = `<strong>Mismatch:</strong> this would route to <strong>${escapeHtmlQA(expectedAgent)}</strong>, but actual traffic mostly went to <strong>${escapeHtmlQA(topActual)}</strong> (${breakdown[0].count}×).`;
  } else {
    mismatchEl.hidden = true;
  }
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
    // domain-known or new-capability: nothing actionable but declutter
    $('phraseDetailActions').innerHTML = `<button class="qa-action-btn reject" id="phraseFlagDismissBtn"><span>✕</span> Dismiss</button>`;
    $('phraseFlagDismissBtn').addEventListener('click', () => flagPhraseAction(id, 'dismiss'));
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
$('qaTriggerButton').addEventListener('click', triggerReview);
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
  $('backupBranchInfo').textContent = '\u2307 ' + escapeHtml(body.branch);
  $('backupRemoteInfo').textContent = body.remotes.length
    ? body.remotes.map(function(r) { return escapeHtml(r.name) + ': ' + escapeHtml(r.url); }).join(', ')
    : 'No remote configured';

  var aheadBehind = [];
  if (body.ahead > 0) aheadBehind.push(body.ahead + ' ahead');
  if (body.behind > 0) aheadBehind.push(body.behind + ' behind');
  $('backupAheadBehind').textContent = aheadBehind.length ? aheadBehind.join(', ') : 'synced';
  $('backupAheadBehind').className = (body.behind > 0) ? 'backup-ahead-behind warning' : 'backup-ahead-behind';

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