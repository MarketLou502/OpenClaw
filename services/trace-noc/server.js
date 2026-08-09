'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { TraceStore } = require('./lib/trace-store');
const phraseTracker = require('./lib/phrase-tracker');
const { buildRouterTree } = require('./lib/router-tree');

const HOST = '127.0.0.1';
const PORT = Number(process.env.TRACE_NOC_PORT || 18790);
const ROOT = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(__dirname, '..', '..'));
const PUBLIC = path.join(__dirname, 'public');
const store = new TraceStore(ROOT);

// ─── Fast Router Proposals paths ─────────────────────────────────────────────
const QA_WORKSPACE = path.join(ROOT, 'workspace-systems-qa');
const QA_MEMORY_DIR = path.join(QA_WORKSPACE, 'memory');
const QA_PROPOSED_DIR = path.join(QA_WORKSPACE, 'proposed-diffs');
const QA_APPLIED_DIR = path.join(QA_WORKSPACE, 'applied-diffs');
const QA_STATE_DIR = path.join(QA_WORKSPACE, 'state');
const QA_APPLY_SCRIPT = path.join(__dirname, 'scripts', 'qa-apply-diff.sh');
const ROUTER_DIR = path.join(ROOT, 'services', 'shared-routine-router');

// ─── Active QA review runs ───────────────────────────────────────────────────
const qaActiveRuns = new Map(); // runId → {runId, pid, logFile, startedAt, state, exitCode, endedAt, error}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

// ─── Langfuse proxy config ────────────────────────────────────────────────────
const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || '';
const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || '';
const LANGFUSE_BASE_URL = (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, '');
const LANGFUSE_AUTH = LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY
  ? 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64')
  : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(response, status, body) {
  response.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function staticFile(requestPath, response) {
  const requested = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  response.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(response);
  return true;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100_000) { reject(new Error('Request body too large.')); request.destroy(); }
    });
    request.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (error) { reject(new Error(`Invalid JSON body: ${error.message}`)); }
    });
    request.on('error', reject);
  });
}

function parseQueryParams(url) {
  const p = url.searchParams;
  const o = {};
  for (const [k, v] of p.entries()) o[k] = v;
  return o;
}

// ─── Proxy to Langfuse public API ─────────────────────────────────────────────
function langfuseApi(requestPath, searchParams) {
  if (!LANGFUSE_AUTH) return Promise.resolve(null);

  const qs = searchParams.toString();
  const url = `${LANGFUSE_BASE_URL}/api/public${requestPath}${qs ? '?' + qs : ''}`;

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Authorization': LANGFUSE_AUTH,
        'Accept': 'application/json',
      },
      timeout: 10_000,
    };
    const proto = u.protocol === 'https:' ? https : http;
    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { error: data.slice(0, 500) } });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { error: 'Timeout' } }); });
    req.end();
  });
}

// Runs a proposed diff through the existing apply-and-validate script (patch
// apply -> router test suite -> commit or auto-rollback). Shared by the
// manual "Apply to Router" button and the phrase tracker's auto-push flow.
function applyProposedDiff(slug) {
  if (!fs.existsSync(QA_APPLY_SCRIPT)) {
    return { ok: false, error: 'Apply script not found.' };
  }
  const { spawnSync } = require('child_process');
  const result = spawnSync(QA_APPLY_SCRIPT, [slug], {
    cwd: path.join(__dirname, 'scripts'),
    timeout: 30_000,
    encoding: 'utf8',
  });
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    return {
      ok: false,
      error: result.stderr?.slice(0, 500) || 'Script execution failed with no parseable output',
      stdout: result.stdout?.slice(0, 500),
      exitCode: result.status,
    };
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);

    if (request.method !== 'GET' && request.method !== 'POST') return json(response, 405, { ok: false, error: 'Only GET and POST requests allowed.' });

    // ── Health ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return json(response, 200, {
        ok: true,
        service: 'openclaw-qa-agent-dashboard',
        root: ROOT,
        langfuse: LANGFUSE_AUTH ? `${LANGFUSE_BASE_URL}/api/public` : null,
      });
    }

    // ── Request list ──────────────────────────────────────────────────────
    if (url.pathname === '/api/requests') {
      const requests = await store.listRequests({
        query: url.searchParams.get('query'),
        status: url.searchParams.get('status'),
        agent: url.searchParams.get('agent'),
        limit: url.searchParams.get('limit'),
      });
      return json(response, 200, { ok: true, requests });
    }

    // ── Single request / trace ────────────────────────────────────────────
    if (url.pathname.startsWith('/api/requests/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/requests/'.length));
      const trace = await store.getRequest(id);
      return trace
        ? json(response, 200, { ok: true, trace })
        : json(response, 404, { ok: false, error: 'Trace not found.' });
    }

    // ── Langfuse proxy: GET /api/langfuse/traces ──────────────────────────
    if (url.pathname.startsWith('/api/langfuse/')) {
      if (!LANGFUSE_AUTH) {
        return json(response, 503, {
          ok: false,
          error: 'Langfuse not configured. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.',
        });
      }
      const lfPath = url.pathname.replace('/api/langfuse', '');
      const result = await langfuseApi(lfPath, url.searchParams);
      if (!result) {
        return json(response, 502, { ok: false, error: 'Langfuse proxy request failed.' });
      }
      response.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-langfuse-proxy': 'true',
      });
      return response.end(JSON.stringify(result.body));
    }

    // ── QA Review: list reviews ──────────────────────────────────────────
    if (url.pathname === '/api/qa/reviews') {
      const reviews = [];
      if (fs.existsSync(QA_MEMORY_DIR)) {
        for (const entry of fs.readdirSync(QA_MEMORY_DIR, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;
          const content = fs.readFileSync(path.join(QA_MEMORY_DIR, entry.name), 'utf8');
          const stats = fs.statSync(path.join(QA_MEMORY_DIR, entry.name));
          const lines = content.split('\n');
          const titleLine = lines.find(l => l.startsWith('## ')) || '';
          const summary = lines.slice(0, 30).join('\n');
          reviews.push({
            date: entry.name.replace('.md', ''),
            title: titleLine.replace('## ', ''),
            summary: summary.slice(0, 500),
            size: lines.length,
            mtimeMs: stats.mtimeMs,
          });
        }
      }
      reviews.sort((a, b) => b.date.localeCompare(a.date));
      return json(response, 200, { ok: true, reviews });
    }

    // ── Routine router: static decision-tree reference ────────────────────
    if (url.pathname === '/api/router-tree') {
      const tree = buildRouterTree(ROUTER_DIR);
      return json(response, 200, { ok: true, tree });
    }

    // ── Phrase Tracker: frequency / removal views ─────────────────────────
    if (url.pathname === '/api/qa/phrases') {
      const rawView = url.searchParams.get('view');
      const view = rawView === 'removal' ? 'removal' : rawView === 'recency' ? 'recency' : 'frequency';
      const body = await phraseTracker.getPhraseTrackerView(store, view, {
        stateDir: QA_STATE_DIR,
        routerDir: ROUTER_DIR,
      });
      return json(response, 200, { ok: true, ...body });
    }

    // ── Phrase Tracker: flag a phrase / intent ─────────────────────────────
    if (url.pathname.startsWith('/api/qa/phrases/') && url.pathname.endsWith('/flag') && request.method === 'POST') {
      const id = decodeURIComponent(url.pathname.slice('/api/qa/phrases/'.length, -'/flag'.length));
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      const result = await phraseTracker.flagPhrase(store, id, payload.action, {
        stateDir: QA_STATE_DIR,
        routerDir: ROUTER_DIR,
        proposedDir: QA_PROPOSED_DIR,
        fields: payload.fields,
      });
      if (!result.ok || !result.diffSlug) return json(response, result.ok ? 200 : 400, result);

      // A confident grammar match was drafted — push it through the same
      // apply-and-validate path as the manual Apply button, immediately,
      // rather than leaving it sitting in Proposed Diffs for a second click.
      const applyResult = applyProposedDiff(result.diffSlug);
      const finalStatus = applyResult.ok ? 'addition-applied' : 'addition-failed';
      phraseTracker.updateFlagStatus(QA_STATE_DIR, id, {
        status: finalStatus,
        diffSlug: result.diffSlug,
        appliedError: applyResult.ok ? null : (applyResult.error || 'Tests failed after applying; rolled back.'),
      });
      return json(response, 200, {
        ok: true,
        id,
        status: finalStatus,
        diffSlug: result.diffSlug,
        applied: applyResult.ok,
        message: applyResult.ok
          ? `Pushed to router — "${result.diffSlug}" applied and tests passed.`
          : `Match found and diff drafted, but the push failed: ${applyResult.error || 'tests failed, rolled back'}.`,
        testOutput: applyResult.testOutput || null,
      });
    }

    // ── QA Review: list proposed diffs ────────────────────────────────────
    if (url.pathname === '/api/qa/diffs') {
      const diffs = [];
      if (fs.existsSync(QA_PROPOSED_DIR)) {
        for (const entry of fs.readdirSync(QA_PROPOSED_DIR, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.patch')) continue;
          const content = fs.readFileSync(path.join(QA_PROPOSED_DIR, entry.name), 'utf8');
          const stats = fs.statSync(path.join(QA_PROPOSED_DIR, entry.name));
          const slug = entry.name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.patch$/, '');
          const applied = fs.existsSync(path.join(QA_APPLIED_DIR, entry.name + '.applied'))
            || fs.existsSync(path.join(QA_APPLIED_DIR, entry.name));
          const rejected = fs.existsSync(path.join(QA_PROPOSED_DIR, entry.name + '.rejected'));
          // Parse the first hunk to get a preview
          const firstHunk = content.match(/@@[^@@]*@@[\s\S]*?(?=@@|$)/);
          diffs.push({
            filename: entry.name,
            slug,
            date: entry.name.slice(0, 10),
            size: content.length,
            mtimeMs: stats.mtimeMs,
            applied,
            rejected,
            preview: firstHunk ? firstHunk[0].slice(0, 300) : content.slice(0, 300),
          });
        }
      }
      diffs.sort((a, b) => b.date.localeCompare(a.date) || b.mtimeMs - a.mtimeMs);
      return json(response, 200, { ok: true, diffs });
    }

    // ── QA Review: get single diff ────────────────────────────────────────
    if (url.pathname.startsWith('/api/qa/diffs/')) {
      const requestedSlug = decodeURIComponent(url.pathname.slice('/api/qa/diffs/'.length));
      if (!fs.existsSync(QA_PROPOSED_DIR)) {
        return json(response, 404, { ok: false, error: 'No proposed diffs directory.' });
      }
      const matching = fs.readdirSync(QA_PROPOSED_DIR)
        .filter(f => f.endsWith('.patch') && (f.includes(requestedSlug) || f === requestedSlug));
      if (matching.length === 0) {
        return json(response, 404, { ok: false, error: 'Diff not found.' });
      }
      const filename = matching[0];
      const content = fs.readFileSync(path.join(QA_PROPOSED_DIR, filename), 'utf8');
      return json(response, 200, { ok: true, diff: { filename, content } });
    }

    // ── QA Review: apply a diff ───────────────────────────────────────────
    if (url.pathname.startsWith('/api/qa/apply/') && request.method === 'POST') {
      const requestedSlug = decodeURIComponent(url.pathname.slice('/api/qa/apply/'.length));
      const result = applyProposedDiff(requestedSlug);
      return json(response, result.ok ? 200 : 400, result);
    }

    // ── QA Review: trigger manual run ─────────────────────────────────────
    if (url.pathname === '/api/qa/trigger' && request.method === 'POST') {
      const qaRunDir = path.join(QA_WORKSPACE, '.qa-runs');
      fs.mkdirSync(qaRunDir, { recursive: true });
      const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const logFile = path.join(qaRunDir, `${runId}.log`);
      // Use the registered cron job to trigger the QA review — same job the
      // 05:00 scheduler runs. The --expect-final flag makes it wait for the
      // agent to complete before exiting.
      const cronCmd = `cd "${QA_WORKSPACE}" && npx openclaw cron run cd3d350d-37a7-4fad-9622-8ecfd15f6830 --expect-final --timeout 300000 2>&1`;
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      logStream.write(`[${new Date().toISOString()}] Triggering QA review via cron run...\n`);
      logStream.write(`[${new Date().toISOString()}] Command: ${cronCmd}\n`);

      const { spawn } = require('child_process');
      const child = spawn('/bin/bash', ['-c', cronCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      // Track this run
      const runInfo = { runId, pid: child.pid, logFile, startedAt: new Date().toISOString(), state: 'running' };
      qaActiveRuns.set(runId, runInfo);

      child.stdout.on('data', (chunk) => { logStream.write(`[stdout] ${chunk}`); });
      child.stderr.on('data', (chunk) => { logStream.write(`[stderr] ${chunk}`); });
      child.on('error', (err) => {
        logStream.write(`[${new Date().toISOString()}] ERROR: ${err.message}\n`);
        logStream.end();
        runInfo.state = 'error';
        runInfo.error = err.message;
        runInfo.endedAt = new Date().toISOString();
      });
      child.on('close', (code) => {
        logStream.write(`[${new Date().toISOString()}] Exited with code ${code}\n`);
        logStream.end();
        runInfo.state = code === 0 ? 'completed' : 'failed';
        runInfo.exitCode = code;
        runInfo.endedAt = new Date().toISOString();
      });

      return json(response, 202, {
        ok: true,
        message: 'QA review triggered via cron job.',
        runId,
        pid: child.pid,
        note: 'Results will appear in workspace-systems-qa/memory/ and proposed-diffs/ when complete.',
      });
    }

    // ── QA Review: check trigger status ───────────────────────────────────
    if (url.pathname.startsWith('/api/qa/trigger-status/') && request.method === 'GET') {
      const runId = decodeURIComponent(url.pathname.slice('/api/qa/trigger-status/'.length));
      const run = qaActiveRuns.get(runId);
      if (!run) {
        return json(response, 404, { ok: false, error: 'Run not found.' });
      }
      let logTail = '';
      try {
        const fd = fs.openSync(run.logFile, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, 4096, Math.max(0, fs.statSync(run.logFile).size - 4096));
        fs.closeSync(fd);
        logTail = buf.slice(0, bytesRead).toString('utf8');
      } catch (_) {}
      return json(response, 200, {
        ok: true,
        runId: run.runId,
        pid: run.pid,
        state: run.state,
        startedAt: run.startedAt,
        endedAt: run.endedAt || null,
        exitCode: run.exitCode ?? null,
        error: run.error || null,
        logTail,
      });
    }

    // ── Git / Backup ─────────────────────────────────────────────────────
    const { spawnSync } = require('child_process');
    const GIT_DIR = ROOT;

    function gitExec(args) {
      const result = spawnSync('git', args, {
        cwd: GIT_DIR,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim(),
        status: result.status,
        error: result.error ? result.error.message : null,
      };
    }

    function gitLogPretty(format, limitCount) {
      const args = ['log', `--format=${format}`, '--all'];
      if (limitCount) args.push(`-${limitCount}`);
      return gitExec(args);
    }

    // GET /api/git/log — list recent commits
    if (url.pathname === '/api/git/log') {
      const limit = url.searchParams.get('limit') || '30';
      const r = gitLogPretty('%H|%ai|%an|%s', limit);
      if (r.error) return json(response, 502, { ok: false, error: r.error });
      if (r.status !== 0) return json(response, 502, { ok: false, error: r.stderr || 'git log failed', stderr: r.stderr });
      const commits = r.stdout.split('\n').filter(Boolean).map((line) => {
        const [hash, date, author, ...rest] = line.split('|');
        return { hash: hash || '', date: date || '', author: author || '', message: rest.join('|') || '' };
      });
      return json(response, 200, { ok: true, commits });
    }

    // GET /api/git/status — working tree status
    if (url.pathname === '/api/git/status') {
      const statusR = gitExec(['status', '--porcelain']);
      const branchR = gitExec(['rev-parse', '--abbrev-ref', 'HEAD']);
      const remoteR = gitExec(['remote', '-v']);
      const aheadR = gitExec(['rev-list', '--count', '@{upstream}..HEAD', '--']);
      const behindR = gitExec(['rev-list', '--count', 'HEAD..@{upstream}', '--']);

      const branch = branchR.status === 0 ? branchR.stdout : 'unknown';
      const remotes = remoteR.status === 0
        ? Object.values(
            remoteR.stdout.split('\n').filter(Boolean).reduce((acc, line) => {
              const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
              if (!m) return acc;
              // deduplicate by remote name, preferring push URL
              if (!acc[m[1]] || m[3] === 'push') acc[m[1]] = { name: m[1], url: m[2], type: m[3] };
              return acc;
            }, {})
          )
        : [];

      const changed = statusR.stdout ? statusR.stdout.split('\n').filter(Boolean) : [];
      const summary = { modified: 0, added: 0, deleted: 0, untracked: 0 };
      for (const line of changed) {
        const xy = line.slice(0, 2);
        if (xy.includes('M')) summary.modified++;
        if (xy.includes('A') || line.startsWith('??')) summary.added++;
        if (xy.includes('D')) summary.deleted++;
        if (line.startsWith('??')) summary.untracked++;
      }

      return json(response, 200, {
        ok: true,
        branch,
        remotes,
        summary,
        changedCount: changed.length,
        ahead: aheadR.status === 0 ? Number(aheadR.stdout || '0') : null,
        behind: behindR.status === 0 ? Number(behindR.stdout || '0') : null,
      });
    }

    // POST /api/git/backup — git add -A, commit, push
    if (url.pathname === '/api/git/backup' && request.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      const message = String(body.message || '').trim() || `Auto-backup ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

      // git add -A
      const addR = gitExec(['add', '-A']);
      if (addR.error) return json(response, 502, { ok: false, error: `git add failed: ${addR.error}` });

      // Check if there's anything to commit
      const statusCheck = gitExec(['status', '--porcelain']);
      if (!statusCheck.stdout.trim()) {
        // Nothing to commit, but try to push anyway
        const pushR = gitExec(['push']);
        if (pushR.error) return json(response, 502, { ok: false, error: `git push failed: ${pushR.error}` });
        return json(response, 200, {
          ok: true,
          committed: false,
          pushed: pushR.status === 0,
          message: 'Nothing new to commit. Push ' + (pushR.status === 0 ? 'succeeded.' : `had issues: ${pushR.stderr}`),
          stderr: pushR.stderr,
        });
      }

      // git commit
      const commitR = gitExec(['commit', '-m', message]);
      if (commitR.error) return json(response, 502, { ok: false, error: `git commit failed: ${commitR.error}` });
      if (commitR.status !== 0) return json(response, 502, { ok: false, error: commitR.stderr || 'git commit failed' });

      // git push
      const pushR = gitExec(['push']);
      if (pushR.error) return json(response, 502, {
        ok: false,
        committed: true,
        pushed: false,
        error: `git push failed: ${pushR.error}`,
        stderr: pushR.stderr,
      });

      // Get the new commit hash
      const headR = gitExec(['rev-parse', 'HEAD']);
      const hash = headR.status === 0 ? headR.stdout : null;

      return json(response, 200, {
        ok: true,
        committed: true,
        pushed: pushR.status === 0,
        hash,
        message,
        pushOutput: pushR.stdout || null,
        pushError: pushR.status !== 0 ? (pushR.stderr || null) : null,
      });
    }

    // ── Static files ──────────────────────────────────────────────────────
    if (staticFile(url.pathname, response)) return;

    json(response, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    json(response, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`QA Agent Dashboard listening at http://${HOST}:${PORT}\n`);
});

module.exports = { server, store };