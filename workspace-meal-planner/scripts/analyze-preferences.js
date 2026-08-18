#!/usr/bin/env node
'use strict';

// Workstream 3: Preference Learning & Eating Pattern Analysis.
// Reads workspace-meal-planner/data/meal-planner.sqlite's food_log +
// recipes tables and turns them into a preference profile. See
// workspace-meal-planner/plans/03-preference-analysis.md for the full spec.
//
// Usage:
//   node scripts/analyze-preferences.js [--days 30] [--format json|markdown]
//   node scripts/analyze-preferences.js --format markdown
//   node scripts/analyze-preferences.js --refresh   # also saves to memory/

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, computePreferenceProfile } = require('./meal-planner-workflow.js');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const PROFILE_FILE = path.join(MEMORY_DIR, 'preference-profile.json');
const SUMMARY_FILE = path.join(MEMORY_DIR, 'preference-summary.md');

function parseArgs(argv) {
  const args = { days: 30, format: 'json', refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--days') {
      args.days = Number(argv[i + 1]);
      i += 1;
    } else if (token === '--format') {
      args.format = argv[i + 1];
      i += 1;
    } else if (token === '--refresh') {
      args.refresh = true;
    }
  }
  return args;
}

function pct(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function toMarkdown(profile) {
  const p = profile.preferences;
  const lines = [];
  lines.push(`# Preference profile — ${profile.analyzedAt}`);
  lines.push('');
  lines.push(`Period: last ${profile.periodDays} days · ${profile.totalEntries} entries logged`);
  lines.push(`Takeout ratio: ${pct(profile.takeoutRatio)} (${profile.takeoutTrend})`);
  lines.push(`Library ratio: ${pct(profile.libraryRatio)}`);
  lines.push('');

  lines.push('## Top recipes');
  if (p.topRecipes.length === 0) {
    lines.push('_No food log entries yet._');
  } else {
    for (const r of p.topRecipes) {
      lines.push(`- ${r.name} — ${r.count}x, avg ${r.avgCalories} cal, last eaten ${r.lastEaten}`);
    }
  }
  lines.push('');

  lines.push('## Top takeout');
  if (p.topTakeout.length === 0) {
    lines.push('_No takeout logged._');
  } else {
    for (const t of p.topTakeout) {
      lines.push(`- ${t.name} — ${t.count}x (${t.trend})`);
    }
  }
  lines.push('');

  lines.push('## Meal slot distribution');
  for (const [slot, stats] of Object.entries(p.mealSlotDistribution)) {
    lines.push(`- ${slot}: ${stats.count} entries, ${pct(stats.libraryPercent)} library, ${pct(stats.takeoutPercent)} takeout`);
  }
  lines.push('');

  lines.push('## Nudge candidates');
  if (p.nudgeCandidates.length === 0) {
    lines.push('_None right now._');
  } else {
    for (const n of p.nudgeCandidates) {
      lines.push(`- ${n.recipeName} — ${n.reason}`);
    }
  }
  lines.push('');

  lines.push('## Nutritional pattern');
  lines.push(`- Avg daily calories: ${p.nutritionalPattern.avgDailyCalories}`);
  lines.push(`- Avg daily protein: ${p.nutritionalPattern.avgDailyProtein}g`);
  for (const [slot, stats] of Object.entries(p.nutritionalPattern.avgCaloriesBySlot)) {
    lines.push(`- ${slot}: avg ${stats.avg} cal (library ${stats.fromLibrary}, takeout ${stats.fromTakeout})`);
  }
  lines.push('');

  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase();
  let profile;
  try {
    profile = computePreferenceProfile(db, { days: args.days });
  } finally {
    db.close();
  }

  if (args.refresh) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_FILE, `${JSON.stringify(profile, null, 2)}\n`);
    fs.appendFileSync(SUMMARY_FILE, `\n---\n\n${toMarkdown(profile)}`);
  }

  if (args.format === 'markdown') {
    process.stdout.write(`${toMarkdown(profile)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
