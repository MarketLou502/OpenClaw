#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE = '/opt/homebrew/opt/node@22/bin/node';
const BUILDER = path.join(__dirname, 'build-nutrition-index.js');
const OUTPUT = path.join(__dirname, '..', 'data', 'nutrition.db');
const SOURCES = [
  {
    dataset: 'foundation',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip',
  },
  {
    dataset: 'fndds',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
  },
  {
    dataset: 'sr_legacy',
    url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip',
  },
];

async function download(source, directory) {
  const zipPath = path.join(directory, `${source.dataset}.zip`);
  const extractPath = path.join(directory, source.dataset);
  fs.mkdirSync(extractPath, { recursive: true });
  const response = await fetch(source.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${source.dataset} download returned HTTP ${response.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  const unzip = spawnSync('unzip', ['-o', zipPath, '-d', extractPath], { encoding: 'utf8' });
  if (unzip.status !== 0) throw new Error(`${source.dataset} unzip failed: ${unzip.stderr || unzip.stdout}`);
  const json = fs.readdirSync(extractPath)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => path.join(extractPath, name))[0];
  if (!json) throw new Error(`${source.dataset} archive did not contain a JSON file`);
  return { ...source, file: json };
}

async function main() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'usda-nutrition-refresh-'));
  try {
    const downloaded = await Promise.all(SOURCES.map((source) => download(source, tempDirectory)));
    const args = [
      '--max-old-space-size=2048',
      BUILDER,
      ...downloaded.flatMap((source) => ['--source', `${source.dataset}=${source.file}`]),
      '--output',
      OUTPUT,
    ];
    const build = spawnSync(NODE, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      maxBuffer: 10 * 1024 * 1024,
    });
    if (build.status !== 0) throw new Error(`index build failed: ${build.stderr || build.stdout}`);
    const result = JSON.parse(build.stdout.trim());
    process.stdout.write(`${JSON.stringify({
      ...result,
      sourceUrls: Object.fromEntries(downloaded.map((source) => [source.dataset, source.url])),
    })}\n`);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
