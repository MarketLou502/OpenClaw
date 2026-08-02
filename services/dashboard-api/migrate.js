#!/usr/bin/env node
// One-time migration: workspace-daily-tracker/tasks/*.md -> *.json.
//
// Safe to re-run: skips any board whose .json file already exists (does not
// overwrite). Original .md files are moved to tasks/.md-backup/, not deleted.
'use strict';

const fs = require('fs');
const path = require('path');
const { slugify, newId, writeJsonAtomic, readJson } = require('../../lib/taskstore');

const WORKSPACE = '/Users/aaronmacmini/.openclaw/workspace-daily-tracker';
const TASKS_DIR = path.join(WORKSPACE, 'tasks');
const BACKUP_DIR = path.join(TASKS_DIR, '.md-backup');

const BOARD_FILES = ['work.md', 'personal.md', 'market-lou.md'];
const HABITS_FILE = 'daily-habits.md';

function parseTaskLines(content) {
  const items = [];
  for (const line of content.split('\n')) {
    const doneMatch = line.match(/^- \[x\]\s*(.+?)\s*\|\s*Added:\s*(\S+)(?:\s*\|\s*Done:\s*(\S+))?\s*$/i);
    const openMatch = line.match(/^- \[ \]\s*(.+?)\s*\|\s*Added:\s*(\S+)\s*$/);
    if (doneMatch) {
      items.push({ id: newId(), text: doneMatch[1].trim(), done: true, added: doneMatch[2], doneDate: doneMatch[3] || null });
    } else if (openMatch) {
      items.push({ id: newId(), text: openMatch[1].trim(), done: false, added: openMatch[2], doneDate: null });
    }
  }
  return items;
}

function migrateBoard(mdFilename) {
  const board = mdFilename.replace(/\.md$/, '');
  const mdPath = path.join(TASKS_DIR, mdFilename);
  const jsonPath = path.join(TASKS_DIR, `${board}.json`);

  if (fs.existsSync(jsonPath)) {
    console.log(`skip ${board}: ${board}.json already exists`);
    return;
  }
  if (!fs.existsSync(mdPath)) {
    console.log(`skip ${board}: no ${mdFilename} found, writing empty item list`);
    writeJsonAtomic(jsonPath, { items: [] });
    return;
  }

  const content = fs.readFileSync(mdPath, 'utf8');
  const items = parseTaskLines(content);
  writeJsonAtomic(jsonPath, { items });

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.renameSync(mdPath, path.join(BACKUP_DIR, mdFilename));

  console.log(`migrated ${board}: ${items.length} item(s) -> ${board}.json (${mdFilename} moved to .md-backup/)`);
}

function migrateHabits() {
  const jsonPath = path.join(TASKS_DIR, 'daily-habits.json');
  if (fs.existsSync(jsonPath)) {
    console.log('skip habits: daily-habits.json already exists');
    return;
  }
  const mdPath = path.join(TASKS_DIR, HABITS_FILE);
  let labels = ['Guitar', 'Golf', 'Spanish', 'Study AI 900', 'Clean', 'Workout/Run'];
  if (fs.existsSync(mdPath)) {
    const content = fs.readFileSync(mdPath, 'utf8');
    const parsed = content.split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- /, '').trim())
      .filter(Boolean);
    if (parsed.length) labels = parsed;
  }
  const habits = labels.map((label) => ({ id: slugify(label), label }));
  writeJsonAtomic(jsonPath, { habits });

  if (fs.existsSync(mdPath)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.renameSync(mdPath, path.join(BACKUP_DIR, HABITS_FILE));
  }
  console.log(`migrated habits: ${habits.length} habit(s) -> daily-habits.json (ids: ${habits.map((h) => h.id).join(', ')})`);
}

function ensureGroceryFile() {
  const jsonPath = path.join(TASKS_DIR, 'grocery.json');
  if (fs.existsSync(jsonPath)) {
    console.log('skip grocery: grocery.json already exists');
    return;
  }
  writeJsonAtomic(jsonPath, { items: [] });
  console.log('created empty grocery.json');
}

console.log(`Migrating task/habit files in ${TASKS_DIR} ...`);
for (const f of BOARD_FILES) migrateBoard(f);
migrateHabits();
ensureGroceryFile();
console.log('Done.');
