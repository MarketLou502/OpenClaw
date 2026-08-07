'use strict';

// Phase 1 of TOOL_CATALOG_PLAN.md: one source of truth listing every
// script/subcommand that already exists across agents, so phrase→tool
// matching can look a phrase up against real capabilities instead of
// hand-writing a detector per domain (the DOMAIN_FASTPATHS pattern in
// phrase-tracker.js, which this catalog is meant to eventually generalize).
//
// This is a one-time, hand-written inventory (per the plan's Discovery
// approach — scripts don't share one argument-parsing style, so this isn't
// auto-introspected) as of 2026-08-07. If a script's command surface
// changes, update its entry here by hand; nothing regenerates this file.
//
// Owning-agent note: workspace-goals, workspace-lists, and workspace-boards
// each hold a byte-identical copy of workspace-main/scripts/dashboard-workflow.js
// (confirmed via diff 2026-08-07). Per CURRENT_ARCHITECTURE.md (updated
// 2026-08-03, still uncommitted at cataloging time), all three are live thin
// specialists sharing this one CLI and one backing service (dashboard-api) —
// none of the three copies is "more canonical" than another, so `agent` below
// lists the widget's real owner rather than an arbitrary canonical file.
//
// `routerWired` cross-references phrase-tracker.js's ROUTE_TO_YAML (the
// router intents trace-noc already knows about) as of the same date — it
// records whether *some* phrasing of this exact subcommand already reaches
// the deterministic router today, not whether every phrasing does.

const DASHBOARD_WORKFLOW = 'workspace-main/scripts/dashboard-workflow.js';
const CALENDAR_WORKFLOW = 'workspace-main/scripts/calendar-workflow.js';
const FINANCE_WORKFLOW = 'workspace-finance-agent/scripts/finance-workflow.js';
const HEALTH_WORKFLOW = 'workspace-health-tracker/scripts/health-workflow.js';
const MEAL_PLANNER_WORKFLOW = 'workspace-meal-planner/scripts/meal-planner-workflow.js';

const TOOL_CATALOG = [
  // ─── dashboard-workflow.js — task boards (owned by `boards`) ─────────────
  {
    id: 'boards.list',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'list',
    args: [{ key: 'board', required: true, values: ['work', 'market-lou', 'personal', 'grocery', 'all'] }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'dashboard-list',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: true },
    ],
  },
  {
    id: 'boards.add',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'add',
    args: [
      { key: 'board', required: false, default: 'personal' },
      { key: 'text', required: true },
    ],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'dashboard-add',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: false },
      { key: 'text', label: 'Task', type: 'text', required: true },
    ],
  },
  {
    id: 'boards.complete',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'complete',
    args: [
      { key: 'board', required: false },
      { key: 'query', required: true },
    ],
    checkThenAct: true, // fuzzy-matches an open item by query before acting
    routerWired: true,
    routerRoute: 'dashboard-complete',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: false },
      { key: 'query', label: 'Task', type: 'text', required: true },
    ],
  },
  {
    id: 'boards.remove',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'remove',
    args: [
      { key: 'board', required: false },
      { key: 'query', required: true },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'dashboard-remove',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: false },
      { key: 'query', label: 'Task', type: 'text', required: true },
    ],
  },
  {
    id: 'boards.schedule',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'schedule',
    args: [
      { key: 'board', required: true, values: ['work', 'market-lou', 'personal'] },
      { key: 'query', required: true },
      { key: 'date', required: true, format: 'YYYY-MM-DD' },
      { key: 'time', required: true, format: 'HH:00|HH:30' },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'dashboard-schedule',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: true },
      { key: 'query', label: 'Task', type: 'text', required: true },
      { key: 'date', label: 'Date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
      { key: 'time', label: 'Time', type: 'text', required: true, placeholder: 'HH:00 or HH:30' },
    ],
  },
  {
    id: 'boards.reschedule',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'reschedule',
    args: [
      { key: 'board', required: true, values: ['work', 'market-lou', 'personal'] },
      { key: 'query', required: true },
      { key: 'date', required: true, format: 'YYYY-MM-DD' },
      { key: 'time', required: true, format: 'HH:00|HH:30' },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'dashboard-reschedule',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: true },
      { key: 'query', label: 'Task', type: 'text', required: true },
      { key: 'date', label: 'New date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
      { key: 'time', label: 'New time', type: 'text', required: true, placeholder: 'HH:00 or HH:30' },
    ],
  },
  {
    id: 'boards.unschedule',
    agent: 'boards',
    script: DASHBOARD_WORKFLOW,
    command: 'unschedule',
    args: [
      { key: 'board', required: true, values: ['work', 'market-lou', 'personal'] },
      { key: 'query', required: true },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'dashboard-unschedule',
    formFields: [
      { key: 'board', label: 'Board', type: 'text', required: true },
      { key: 'query', label: 'Task', type: 'text', required: true },
    ],
  },

  // ─── dashboard-workflow.js — daily habits (owned by `goals`) ─────────────
  {
    id: 'goals.list-habits',
    agent: 'goals',
    script: DASHBOARD_WORKFLOW,
    command: 'list-habits',
    args: [],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'dashboard-list-habits',
    formFields: [],
  },
  {
    id: 'goals.complete-habit',
    agent: 'goals',
    script: DASHBOARD_WORKFLOW,
    command: 'complete-habit',
    args: [{ key: 'query', required: true }],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'dashboard-complete-habit',
    formFields: [
      { key: 'query', label: 'Habit', type: 'text', required: true },
    ],
  },
  {
    id: 'goals.complete-any',
    agent: 'goals',
    script: DASHBOARD_WORKFLOW,
    command: 'complete-any',
    args: [{ key: 'query', required: true }],
    checkThenAct: true, // searches habits + all task boards together, requires a unique match
    routerWired: true,
    routerRoute: 'dashboard-complete-any',
    formFields: [
      { key: 'query', label: 'Habit or task', type: 'text', required: true },
    ],
  },

  // ─── dashboard-workflow.js — custom lists (owned by `lists`) ─────────────
  {
    id: 'lists.list-lists',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'list-lists',
    args: [],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'dashboard-list-lists',
    formFields: [],
  },
  {
    id: 'lists.show-list',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'show-list',
    args: [{ key: 'list', required: true }],
    checkThenAct: true, // fuzzy-matches the list by name; board names win over same-named custom lists
    routerWired: true,
    routerRoute: 'dashboard-show-list',
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.create-list',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'create-list',
    args: [{ key: 'name', required: true }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'dashboard-create-list',
    formFields: [
      { key: 'name', label: 'List name', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.rename-list',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'rename-list',
    args: [
      { key: 'list', required: true },
      { key: 'name', required: true },
    ],
    checkThenAct: true,
    routerWired: false,
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
      { key: 'name', label: 'New name', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.delete-list',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'delete-list',
    args: [{ key: 'list', required: true }],
    checkThenAct: true,
    routerWired: false,
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.add-list-item',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'add-list-item',
    args: [
      { key: 'list', required: true },
      { key: 'text', required: true },
    ],
    checkThenAct: true, // resolves list target (board-or-custom-list) before adding
    routerWired: true,
    routerRoute: 'dashboard-add-list-item',
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
      { key: 'text', label: 'Item', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.edit-list-item',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'edit-list-item',
    args: [
      { key: 'list', required: true },
      { key: 'item', required: true },
      { key: 'text', required: true },
    ],
    checkThenAct: true,
    routerWired: false,
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
      { key: 'item', label: 'Item', type: 'text', required: true },
      { key: 'text', label: 'New text', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.complete-list-item',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'complete-list-item',
    args: [
      { key: 'list', required: true },
      { key: 'item', required: true },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'dashboard-complete-list-item',
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
      { key: 'item', label: 'Item', type: 'text', required: true },
    ],
  },
  {
    id: 'lists.remove-list-item',
    agent: 'lists',
    script: DASHBOARD_WORKFLOW,
    command: 'remove-list-item',
    args: [
      { key: 'list', required: true },
      { key: 'item', required: true },
    ],
    checkThenAct: true,
    routerWired: false,
    formFields: [
      { key: 'list', label: 'List', type: 'text', required: true },
      { key: 'item', label: 'Item', type: 'text', required: true },
    ],
  },

  // ─── calendar-workflow.js (owned by `scheduler`) ─────────────────────────
  {
    id: 'scheduler.list',
    agent: 'scheduler',
    script: CALENDAR_WORKFLOW,
    command: 'list',
    args: [{ key: 'date', required: true, format: 'YYYY-MM-DD' }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'calendar-list',
    formFields: [
      { key: 'date', label: 'Date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
    ],
  },
  {
    id: 'scheduler.add',
    agent: 'scheduler',
    script: CALENDAR_WORKFLOW,
    command: 'add',
    args: [
      { key: 'title', required: true },
      { key: 'date', required: true, format: 'YYYY-MM-DD' },
      { key: 'time', required: true, format: 'HH:MM' },
      { key: 'duration', required: false, default: 60 },
    ],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'calendar-add',
    formFields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'date', label: 'Date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
      { key: 'time', label: 'Time', type: 'text', required: true, placeholder: 'HH:MM' },
      { key: 'duration', label: 'Duration (min)', type: 'number', required: false },
    ],
  },
  {
    id: 'scheduler.delete',
    agent: 'scheduler',
    script: CALENDAR_WORKFLOW,
    command: 'delete',
    args: [
      { key: 'title', required: true },
      { key: 'date', required: true, format: 'YYYY-MM-DD' },
    ],
    checkThenAct: true, // fuzzy-matches the event by title within that date
    routerWired: true,
    routerRoute: 'calendar-delete',
    formFields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'date', label: 'Date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
    ],
  },
  {
    id: 'scheduler.reschedule',
    agent: 'scheduler',
    script: CALENDAR_WORKFLOW,
    command: 'reschedule',
    args: [
      { key: 'title', required: true },
      { key: 'date', required: true, format: 'YYYY-MM-DD' },
      { key: 'new-date', required: true, format: 'YYYY-MM-DD' },
      { key: 'new-time', required: true, format: 'HH:MM' },
      { key: 'duration', required: false },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'calendar-reschedule',
    formFields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'date', label: 'Current date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
      { key: 'new-date', label: 'New date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
      { key: 'new-time', label: 'New time', type: 'text', required: true, placeholder: 'HH:MM' },
    ],
  },

  // ─── finance-workflow.js (owned by `finance-agent`) — zero router coverage
  {
    id: 'finance.add-expense',
    agent: 'finance-agent',
    script: FINANCE_WORKFLOW,
    command: 'add-expense',
    args: [
      { key: 'name', required: true },
      { key: 'amount', required: true, type: 'number' },
      { key: 'due-day', required: true, type: 'integer', min: 1, max: 31 },
      { key: 'notes', required: false },
    ],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'finance-add-expense',
    formFields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'number', required: true },
      { key: 'due-day', label: 'Due day (1-31)', type: 'number', required: true, max: 31 },
      { key: 'notes', label: 'Notes', type: 'text', required: false },
    ],
  },
  {
    id: 'finance.balance',
    agent: 'finance-agent',
    script: FINANCE_WORKFLOW,
    command: 'balance',
    args: [],
    checkThenAct: false,
    routerWired: false,
    formFields: [],
  },
  {
    id: 'finance.budget-forecast',
    agent: 'finance-agent',
    script: FINANCE_WORKFLOW,
    command: 'budget-forecast',
    args: [],
    checkThenAct: false,
    routerWired: false,
    formFields: [],
  },

  // ─── health-workflow.js (owned by `health-tracker`) ──────────────────────
  // Recipe lookup/creation (find-recipe, add-recipe) already has its own
  // fast path outside the router grammar entirely — DOMAIN_FASTPATHS'
  // 'food-recipe' entry in phrase-tracker.js calls these two commands
  // directly. Cataloged here too so a phrase-catalog match against
  // find-recipe/add-recipe can be recognized as "already fast," not flagged
  // as a Phase-4 gap.
  {
    id: 'health.find-recipe',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'find-recipe',
    args: [{ key: 'query', required: true }],
    checkThenAct: true, // this *is* the "check" half of food-recipe's check-then-act pair
    routerWired: false,
    domainFastpath: 'food-recipe',
    formFields: [
      { key: 'query', label: 'Recipe name', type: 'text', required: true },
    ],
  },
  {
    id: 'health.add-recipe',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'add-recipe',
    args: [
      { key: 'name', required: true },
      { key: 'serving', required: true },
      { key: 'calories', required: true, type: 'number', max: 10000 },
      { key: 'protein', required: true, type: 'number', max: 1000 },
      { key: 'aliases', required: false, type: 'csv' },
    ],
    checkThenAct: false,
    routerWired: false,
    domainFastpath: 'food-recipe',
    formFields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'serving', label: 'Serving', type: 'text', required: true, placeholder: 'e.g. 1 cup' },
      { key: 'calories', label: 'Calories', type: 'number', required: true, max: 10000 },
      { key: 'protein', label: 'Protein (g)', type: 'number', required: true, max: 1000 },
      { key: 'aliases', label: 'Aliases (comma-separated)', type: 'text', required: false },
    ],
  },
  {
    id: 'health.list-recipes',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'list-recipes',
    args: [],
    checkThenAct: false,
    routerWired: false,
    formFields: [],
  },
  {
    id: 'health.log-food',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'log-food',
    args: [
      { key: 'name', required: true },
      { key: 'resolution-type', required: true, values: ['staple', 'recipe', 'usda', 'vendor_cache', 'estimate', 'manual'] },
      { key: 'serving', required: true },
      { key: 'calories', required: true, type: 'number', max: 10000 },
      { key: 'protein', required: true, type: 'number', max: 1000 },
      { key: 'quantity', required: false, type: 'number', default: 1 },
      { key: 'idempotency-key', required: true },
    ],
    checkThenAct: false,
    routerWired: false, // reached only via Main (voice adapter's exact-recipe fastpath is separate and narrower)
    formFields: [],
  },
  {
    id: 'health.correct-food',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'correct-food',
    args: [
      { key: 'id', required: false },
      { key: 'date', required: false },
      { key: 'idempotency-key', required: true },
    ],
    checkThenAct: true, // selects the target entry (by id, or most recent for the day/conversation) before superseding it
    routerWired: true,
    routerRoute: 'health-correct-food',
    formFields: [],
  },
  {
    id: 'health.remove-food',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'remove-food',
    args: [
      { key: 'id', required: false },
      { key: 'date', required: false },
      { key: 'idempotency-key', required: true },
    ],
    checkThenAct: true,
    routerWired: true,
    routerRoute: 'health-remove-food',
    formFields: [],
  },
  {
    id: 'health.undo',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'undo',
    args: [
      { key: 'date', required: false },
      { key: 'idempotency-key', required: true },
    ],
    checkThenAct: true, // finds the most recent reversible mutation for the day/conversation
    routerWired: true,
    routerRoute: 'health-undo',
    formFields: [],
  },
  {
    id: 'health.log-workout',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'log-workout',
    args: [{ key: 'idempotency-key', required: true }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'workout-log',
    formFields: [],
  },
  {
    id: 'health.log-daily-run',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'log-daily-run',
    args: [
      { key: 'duration-minutes', required: false, type: 'number', default: 30 },
      { key: 'idempotency-key', required: true },
    ],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'daily-run-log',
    formFields: [
      { key: 'duration-minutes', label: 'Duration (min)', type: 'number', required: false },
    ],
  },
  {
    id: 'health.list-today',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'list-today',
    args: [{ key: 'date', required: false }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'health-list-today',
    formFields: [],
  },
  {
    id: 'health.activity-today',
    agent: 'health-tracker',
    script: HEALTH_WORKFLOW,
    command: 'activity-today',
    args: [{ key: 'date', required: false }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'health-activity-today',
    formFields: [],
  },

  {
    id: 'meal-planner.list-recipes',
    agent: 'meal-planner',
    script: MEAL_PLANNER_WORKFLOW,
    command: 'list-recipes',
    args: [
      { key: 'type', required: false, values: ['quick', 'prepared'] },
      { key: 'tag', required: false },
      { key: 'active-only', required: false, type: 'flag' },
    ],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'meal-planner-list-recipes',
    formFields: [],
  },
  {
    id: 'meal-planner.find-recipe',
    agent: 'meal-planner',
    script: MEAL_PLANNER_WORKFLOW,
    command: 'find-recipe',
    args: [{ key: 'query', required: true }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'meal-planner-find-recipe',
    formFields: [
      { key: 'query', label: 'Recipe name', type: 'text', required: true },
    ],
  },
  {
    id: 'meal-planner.get-plan',
    agent: 'meal-planner',
    script: MEAL_PLANNER_WORKFLOW,
    command: 'get-plan',
    args: [{ key: 'date', required: false }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'meal-planner-get-plan',
    formFields: [],
  },
  {
    id: 'meal-planner.assemble-plan',
    agent: 'meal-planner',
    script: MEAL_PLANNER_WORKFLOW,
    command: 'assemble-plan',
    args: [
      { key: 'date', required: false },
      { key: 'lock-existing', required: false, type: 'flag' },
    ],
    checkThenAct: false, // auto-fills slots from the recipe library against live health-tracker targets; not a lookup-then-act pattern
    routerWired: true,
    routerRoute: 'meal-planner-assemble-plan',
    formFields: [],
  },
  {
    id: 'meal-planner.add-plan-item',
    agent: 'meal-planner',
    script: MEAL_PLANNER_WORKFLOW,
    command: 'add-plan-item',
    args: [
      { key: 'date', required: false },
      { key: 'slot', required: true, values: ['breakfast', 'lunch', 'dinner', 'snack'] },
      { key: 'recipe-id', required: false },
      { key: 'recipe-name', required: false },
      { key: 'calories', required: false, type: 'number', max: 10000 },
      { key: 'protein', required: false, type: 'number', max: 1000 },
    ],
    checkThenAct: true, // resolves the recipe by id or name before adding it to the plan
    routerWired: true,
    routerRoute: 'meal-planner-add-plan-item',
    formFields: [
      { key: 'slot', label: 'Slot', type: 'text', required: true, placeholder: 'breakfast/lunch/dinner/snack' },
      { key: 'recipe-name', label: 'Recipe', type: 'text', required: true },
    ],
  },
  {
    id: 'meal-planner.confirm-plan',
    agent: 'meal-planner',
    script: MEAL_PLANNER_WORKFLOW,
    command: 'confirm-plan',
    args: [{ key: 'date', required: false }],
    checkThenAct: false,
    routerWired: true,
    routerRoute: 'meal-planner-confirm-plan',
    formFields: [],
  },
];

module.exports = { TOOL_CATALOG };
