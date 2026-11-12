#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTOMATION_DIR = resolve(process.env.CAREER_OPS_AUTOMATION_DIR || join(ROOT, 'data', 'automation'));
const PIPELINE_FILE = resolve(process.env.CAREER_OPS_PIPELINE_FILE || join(ROOT, 'data', 'pipeline.md'));

const PENDING_SECTION_RE = /^(pending|pendientes)$/i;
const LABELED_SEGMENT_RE = /^(posted|trust|note|rank)\s*:/i;

export function extractPendingPipelineEntries(text) {
  const entries = [];
  const seen = new Set();
  let inPending = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inPending = PENDING_SECTION_RE.test(heading[1]);
      continue;
    }
    if (!inPending) continue;

    const item = rawLine.match(/^\s*-\s*\[\s\]\s+(.+?)\s*$/);
    if (!item) continue;

    const cells = item[1].split('|').map((cell) => cell.trim());
    const url = cells[0];
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const positional = cells.slice(1).filter((cell) => !LABELED_SEGMENT_RE.test(cell));
    entries.push({
      url,
      company: positional[0] || '',
      title: positional[1] || '',
      location: positional[2] || '',
      raw: rawLine.trim(),
    });
  }

  return entries;
}

export function buildBatchInput(entries) {
  const clean = (value) => String(value || '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = ['id\turl\tsource\tnotes'];
  entries.forEach((entry, index) => {
    const notes = [entry.company, entry.title, entry.location].map(clean).filter(Boolean).join(' | ');
    rows.push(`${index + 1}\t${clean(entry.url)}\tscheduled-pipeline\t${notes}`);
  });
  return `${rows.join('\n')}\n`;
}

// Rebuild batch/batch-input.tsv from the CURRENT pending pipeline entries.
//
// The runner selects work by offer ID against batch/batch-state.tsv, so an input
// rebuilt with sequential IDs (1..N) maps every row onto a terminal state row that
// belongs to a *different* URL — the run prints "No offers to process" while
// hundreds of genuinely unevaluated offers sit unreachable. Assign IDs above the
// highest ID already in the state file, and drop any URL that already has a state
// row (re-adding one under a fresh ID would mint a second state row and evaluate
// the same posting twice).
//
// Called AFTER the liveness sweep so postings pruned as expired never reach the
// evaluation budget.
export function rebuildBatchInputFromPending(pipelineText, stateText, outputPath) {
  const entries = extractPendingPipelineEntries(pipelineText);
  const knownUrls = new Set();
  let maxId = 0;
  for (const rawLine of String(stateText).split(/\r?\n/)) {
    const cells = rawLine.split('\t');
    const id = Number.parseInt(cells[0], 10);
    if (Number.isFinite(id) && id > maxId) maxId = id;
    if (cells[1]) knownUrls.add(cells[1].trim());
  }
  const fresh = entries.filter((entry) => !knownUrls.has(entry.url));
  const rows = ['id\turl\tsource\tnotes'];
  fresh.forEach((entry, index) => {
    const notes = [entry.company, entry.title, entry.location]
      .map((value) => String(value || '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' | ');
    rows.push(`${maxId + index + 1}\t${String(entry.url).replace(/[\t\r\n]+/g, ' ').trim()}\tscheduled-pipeline\t${notes}`);
  });
  writeAtomic(outputPath, `${rows.join('\n')}\n`);
  return { pending: entries.length, fresh: fresh.length, alreadyStated: entries.length - fresh.length, firstId: maxId + 1 };
}

export function moveExpiredPipelineEntries(text, expiredUrls) {
  const output = [];
  const movedLines = [];
  let inPending = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inPending = PENDING_SECTION_RE.test(heading[1]);
      output.push(rawLine);
      continue;
    }

    if (inPending) {
      const item = rawLine.match(/^\s*-\s*\[\s\]\s+(.+?)\s*$/);
      if (item) {
        const url = item[1].split('|')[0].trim();
        if (expiredUrls.has(url)) {
          movedLines.push(`- [x] ~~${item[1].trim()}~~ — posting expired (scheduled liveness sweep)`);
          continue;
        }
      }
    }
    output.push(rawLine);
  }

  if (movedLines.length > 0) {
    const processedIndex = output.findIndex((line) => /^##\s+(processed|procesadas)\s*$/i.test(line));
    if (processedIndex >= 0) output.splice(processedIndex + 1, 0, ...movedLines);
    else output.push('', '## Processed', ...movedLines);
  }

  const hadTrailingNewline = /\r?\n$/.test(String(text));
  return { text: output.join('\n') + (hadTrailingNewline ? '\n' : ''), moved: movedLines.length };
}

export function parseBatchState(text) {
  const summary = {
    total: 0,
    completed: 0,
    processing: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    rateLimited: 0,
    paused: 0,
    malformed: 0,
    scored: 0,
    averageScore: null,
    rows: [],
  };
  let scoreTotal = 0;
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());

  for (let index = 1; index < lines.length; index += 1) {
    summary.total += 1;
    const cells = lines[index].split('\t');
    if (cells.length < 9) {
      summary.malformed += 1;
      continue;
    }
    const [id, url, status, , , report, rawScore, error] = cells;
    const numericScore = Number(rawScore);
    const score = rawScore !== '' && rawScore !== '-' && Number.isFinite(numericScore) ? numericScore : null;
    if (score !== null) {
      scoreTotal += score;
      summary.scored += 1;
    }
    summary.rows.push({ id, url, status, report, score, error });
    if (status === 'completed') summary.completed += 1;
    else if (status === 'processing') summary.processing += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else if (status === 'rate_limited') summary.rateLimited += 1;
    else if (status === 'paused_rate_limit') summary.paused += 1;
    else summary.pending += 1;
  }

  if (summary.scored > 0) {
    summary.averageScore = Number((scoreTotal / summary.scored).toFixed(1));
  }
  return summary;
}

export function resetNonTerminalBatchRows(text) {
  const lines = String(text).split(/\r?\n/);
  const reset = lines.map((line, index) => {
    if (index === 0 || !line.trim()) return line;
    const cells = line.split('\t');
    if (cells.length < 9) return line;
    if (cells[2] === 'completed' || cells[2] === 'skipped') return line;
    return [cells[0], cells[1], 'pending', '-', '-', '-', '-', '-', '0'].join('\t');
  });
  return reset.join('\n');
}

export function renderNotification(state, batch) {
  const terminal = state.phase === 'completed' || state.phase === 'failed';
  const phaseTitle = state.phase === 'completed'
    ? 'Complete'
    : state.phase === 'failed'
      ? 'Failed'
      : state.phase === 'batch'
        ? 'Evaluating'
        : state.phase === 'liveness'
          ? 'Checking liveness'
          : state.phase === 'scan'
            ? 'Scanning'
            : 'Running';
  const lines = [
    `💼 *Career Ops — ${phaseTitle}*`,
    `*Run:* \`${state.runId}\``,
  ];
  if (state.message) lines.push(`*Status:* ${String(state.message).replace(/[\r\n]+/g, ' ')}`);
  if (Number.isInteger(state.pendingBefore) && Number.isInteger(state.pendingAfterScan)) {
    lines.push(`*Pipeline:* ${state.pendingBefore} pending before scan · ${state.pendingAfterScan} after scan`);
  }
  if (state.liveness) {
    lines.push(`*Liveness:* ${state.liveness.active || 0} active · ${state.liveness.expired || 0} expired · ${state.liveness.uncertain || 0} uncertain`);
  }
  if (batch && batch.total > 0) {
    lines.push(`*Evaluations:* ${batch.completed} completed · ${batch.skipped} skipped · ${batch.failed} failed · ${batch.processing + batch.pending + batch.rateLimited + batch.paused} remaining`);
    lines.push(`*Average score:* ${batch.averageScore === null ? 'N/A' : batch.averageScore}/5`);
  }
  if (terminal && state.artifacts) {
    for (const artifact of [state.artifacts.summary, state.artifacts.batchState, state.artifacts.workflowLog]) {
      if (artifact) lines.push(`MEDIA:${artifact}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function appendAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, content);
}

function writeJson(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function runDirFor(runId) {
  return join(AUTOMATION_DIR, 'runs', runId);
}

function startWorkflow() {
  const runId = argValue('--run-id', new Date().toISOString().replace(/[:.]/g, '-'));
  const runDir = runDirFor(runId);
  const statePath = join(runDir, 'state.json');
  const workerLog = join(runDir, 'worker.out.log');
  mkdirSync(runDir, { recursive: true });
  const queued = {
    runId,
    phase: 'queued',
    message: 'Worker queued',
    startedAt: new Date().toISOString(),
    artifacts: { workerLog },
  };
  writeJson(statePath, queued);
  writeJson(join(AUTOMATION_DIR, 'current.json'), { runId, statePath });

  const fixture = process.argv.includes('--fixture');
  const forwarded = process.argv.slice(3).filter((arg) => arg !== '--fixture');
  const outputFd = openSync(workerLog, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), fixture ? 'fixture-run' : 'run', ...forwarded], {
    cwd: ROOT,
    detached: true,
    env: process.env,
    stdio: ['ignore', outputFd, outputFd],
  });
  closeSync(outputFd);
  child.unref();
  queued.pid = child.pid;
  queued.message = `Worker started (PID ${child.pid})`;
  writeJson(statePath, queued);

  process.stdout.write([
    '💼 *Career Ops — Started*',
    `*Run:* \`${runId}\``,
    `*Worker:* PID ${child.pid}`,
    '*Delivery:* Telegram progress and final artifacts are handled by the notifier job.',
    '',
  ].join('\n'));
}

function runWorkflow() {
  const runId = argValue('--run-id', new Date().toISOString().replace(/[:.]/g, '-'));
  const dryRun = process.argv.includes('--dry-run');
  const runDir = runDirFor(runId);
  mkdirSync(runDir, { recursive: true });
  const batchInput = join(runDir, 'batch-input.tsv');
  const batchState = join(runDir, 'batch-state.tsv');
  const summary = join(runDir, 'summary.md');
  const workflowLog = join(runDir, 'workflow.log');
  const statePath = join(runDir, 'state.json');
  const pending = extractPendingPipelineEntries(readFileSync(PIPELINE_FILE, 'utf8'));

  writeFileSync(batchInput, buildBatchInput(pending));
  writeFileSync(batchState, 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n');
  writeFileSync(summary, `# Career Ops ${dryRun ? 'Dry Run' : 'Run'}\n\n- Run: ${runId}\n- Pending: ${pending.length}\n`);
  writeFileSync(workflowLog, `${dryRun ? 'dry run' : 'run'} initialized with ${pending.length} pending entries\n`);

  const state = {
    runId,
    phase: 'completed',
    message: dryRun ? 'Dry run completed; no scan or evaluation executed' : 'Run initialized',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    pendingBefore: pending.length,
    pendingAfterScan: pending.length,
    liveness: { active: pending.length, expired: 0, uncertain: 0 },
    artifacts: { summary, batchInput, batchState, workflowLog },
  };
  writeJson(statePath, state);
  writeJson(join(AUTOMATION_DIR, 'current.json'), { runId, statePath });
}

function cronWorkflow() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = runDirFor(runId);
  mkdirSync(runDir, { recursive: true });
  const workflowLog = join(runDir, 'workflow.log');
  appendAtomic(workflowLog, `cron workflow started ${new Date().toISOString()}\n`);

  const countPending = () => extractPendingPipelineEntries(readFileSync(PIPELINE_FILE, 'utf8')).length;
  const pendingBefore = countPending();
  const tally = { active: 0, expired: 0, uncertain: 0 };
  let pendingAfterScan = pendingBefore;

  // 1. Scan (uses node scan.mjs)
  appendAtomic(workflowLog, '=== SCAN ===\n');
  try {
    const scanResult = execFileSync('node', ['scan.mjs', '--quiet'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 900_000,
    });
    appendAtomic(workflowLog, scanResult);
  } catch (err) {
    const output = err.stdout || err.message;
    appendAtomic(workflowLog, `scan error: ${output}\n`);
  }
  pendingAfterScan = countPending();
  appendAtomic(workflowLog, `Pending after scan: ${pendingAfterScan} (before: ${pendingBefore})\n`);

  // 2. WebSearch execution for companies requiring web search
  appendAtomic(workflowLog, '=== WEBSEARCH EXECUTION ===\n');
  try {
    const webSearchResult = execFileSync('node', ['scripts/web-search.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 1800000, // 30 minutes
    });
    appendAtomic(workflowLog, webSearchResult);
  } catch (err) {
    const output = err.stdout || err.message;
    appendAtomic(workflowLog, `websearch error: ${output}\n`);
  }

  // 3. Explore cache refresh (feeds the read-only web dashboard)
  appendAtomic(workflowLog, '=== EXPLORE CACHE REFRESH ===\n');
  try {
    // run-explore-scan.mjs is trigger-driven: the web's POST /api/explore writes
    // data/explore-trigger.json. On the nightly run there is usually no pending
    // web request, so seed a default trigger to keep the dashboard cache fresh.
    const triggerFile = join(ROOT, 'data', 'explore-trigger.json');
    if (!existsSync(triggerFile)) {
      writeJson(triggerFile, {
        requestedAt: new Date().toISOString(),
        filters: { sinceDays: 7, ats: ['greenhouse', 'lever', 'ashby', 'workday'], limitPerAts: 150 },
        requestedBy: 'cron',
      });
      appendAtomic(workflowLog, 'Seeded default explore trigger\n');
    } else {
      appendAtomic(workflowLog, 'Using pending web-requested explore trigger\n');
    }
    const exploreResult = execFileSync('node', ['scripts/run-explore-scan.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 2700000, // 45 min — a full ATS sweep took ~28 min on 600 companies
    });
    appendAtomic(workflowLog, exploreResult);
  } catch (err) {
    appendAtomic(workflowLog, `explore cache error: ${err.stdout || err.message}\n`);
  }

  // 4. Liveness sweep on pending pipeline entries
  appendAtomic(workflowLog, '=== LIVENESS SWEEP ===\n');
  try {
    const pipeline = readFileSync(PIPELINE_FILE, 'utf8');
    const pending = extractPendingPipelineEntries(pipeline);
    if (pending.length > 0) {
      const urlsFile = join(runDir, 'liveness-urls.txt');
      writeFileSync(urlsFile, pending.map((e) => e.url).join('\n') + '\n');
      const livenessResult = execFileSync('node', ['check-liveness.mjs', '--throttle', '--file', urlsFile], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
        timeout: 3600000, // 60 min — the throttled sweep needs far longer than 300s for 400+ URLs
      });
      appendAtomic(workflowLog, livenessResult);
      for (const line of livenessResult.split('\n')) {
        if (line.startsWith('✅')) tally.active += 1;
        else if (line.startsWith('❌')) tally.expired += 1;
        else if (line.startsWith('⚠️')) tally.uncertain += 1;
      }
      // Parse expired URLs and move them. check-liveness.mjs prints
      // `❌ expired     (api) https://…` or `❌ expired          https://…`, so the
      // URL is whatever follows the status word — extract it by pattern, never by
      // fixed column offset (the `(api)` marker shifts it).
      const expiredUrls = new Set();
      for (const line of livenessResult.split('\n')) {
        if (line.startsWith('❌')) {
          const match = line.match(/https?:\/\/\S+/);
          if (match) expiredUrls.add(match[0]);
        }
      }
      if (expiredUrls.size > 0) {
        const moved = moveExpiredPipelineEntries(pipeline, expiredUrls);
        writeFileSync(PIPELINE_FILE, moved.text);
        appendAtomic(workflowLog, `Moved ${moved.moved} expired entries to Processed\n`);
      }
    } else {
      appendAtomic(workflowLog, 'No pending entries to check\n');
    }
  } catch (err) {
    appendAtomic(workflowLog, `liveness error: ${err.message}\n`);
  }

  // 5. Reset non-terminal batch rows so retried jobs can run
  appendAtomic(workflowLog, '=== RESET NON-TERMINAL ROWS ===\n');
  try {
    const stateFile = join(ROOT, 'batch', 'batch-state.tsv');
    if (existsSync(stateFile)) {
      const state = readFileSync(stateFile, 'utf8');
      const reset = resetNonTerminalBatchRows(state);
      writeFileSync(stateFile, reset);
      appendAtomic(workflowLog, 'Batch state reset applied\n');
    } else {
      appendAtomic(workflowLog, 'No batch state to reset\n');
    }
  } catch (err) {
    appendAtomic(workflowLog, `reset error: ${err.message}\n`);
  }

  // 6. Batch evaluation
  appendAtomic(workflowLog, '=== BATCH EVALUATION ===\n');
  try {
    // Rebuild the run input from the post-liveness pending list with IDs above the
    // state file's max — see rebuildBatchInputFromPending. Without this the runner
    // maps every input ID onto an unrelated terminal row and does nothing.
    const stateFile = join(ROOT, 'batch', 'batch-state.tsv');
    const inputFile = join(ROOT, 'batch', 'batch-input.tsv');
    const rebuilt = rebuildBatchInputFromPending(
      readFileSync(PIPELINE_FILE, 'utf8'),
      existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '',
      inputFile,
    );
    appendAtomic(
      workflowLog,
      `Batch input rebuilt: ${rebuilt.pending} pending · ${rebuilt.fresh} new (IDs from ${rebuilt.firstId}) · ${rebuilt.alreadyStated} already in state\n`,
    );
    const batchResult = execFileSync('./batch/batch-runner.sh', ['--cli', 'agy', '--parallel', '2', '--limit', '30'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 3600_000,
    });
    appendAtomic(workflowLog, batchResult);
  } catch (err) {
    appendAtomic(workflowLog, `batch error: ${err.stdout || err.message}\n`);
  }

  // 7. Merge tracker
  appendAtomic(workflowLog, '=== MERGE TRACKER ===\n');
  try {
    const mergeResult = execFileSync('node', ['merge-tracker.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    appendAtomic(workflowLog, mergeResult);
  } catch (err) {
    appendAtomic(workflowLog, `merge error: ${err.stdout || err.message}\n`);
  }

  // 8. Reconcile pipeline
  appendAtomic(workflowLog, '=== RECONCILE PIPELINE ===\n');
  try {
    const reconcileResult = execFileSync('node', ['reconcile-pipeline.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    appendAtomic(workflowLog, reconcileResult);
  } catch (err) {
    appendAtomic(workflowLog, `reconcile error: ${err.stdout || err.message}\n`);
  }

  // 9. Verify pipeline
  appendAtomic(workflowLog, '=== VERIFY PIPELINE ===\n');
  try {
    const verifyResult = execFileSync('node', ['verify-pipeline.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    appendAtomic(workflowLog, verifyResult);
  } catch (err) {
    appendAtomic(workflowLog, `verify error: ${err.stdout || err.message}\n`);
  }

  // 10. Notify
  appendAtomic(workflowLog, '=== NOTIFY ===\n');
  try {
    const stateFile = join(runDir, 'state.json');
    // Report the REAL batch state, not an empty stub — the notification is the
    // user's only view of the run, and a header-only file reads as "0 evaluations".
    const batchState = join(ROOT, 'batch', 'batch-state.tsv');
    const summary = join(runDir, 'summary.md');
    writeFileSync(
      summary,
      `# Career Ops Overnight Summary\n\n- Run: ${runId}\n- Pending before scan: ${pendingBefore}\n- Pending after scan: ${pendingAfterScan}\n- Liveness: ${tally.active} active · ${tally.expired} expired · ${tally.uncertain} uncertain\n`,
    );
    const state = {
      runId,
      phase: 'completed',
      message: 'Overnight workflow completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      pendingBefore,
      pendingAfterScan,
      liveness: { ...tally },
      artifacts: { summary, batchState, workflowLog },
    };
    writeJson(stateFile, state);
    writeJson(join(AUTOMATION_DIR, 'current.json'), { runId, statePath: stateFile });
    const notifyResult = execFileSync(process.execPath, [fileURLToPath(import.meta.url), 'notify'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    appendAtomic(workflowLog, notifyResult);
  } catch (err) {
    appendAtomic(workflowLog, `notify error: ${err.message}\n`);
  }

  appendAtomic(workflowLog, `cron workflow completed ${new Date().toISOString()}\n`);
}

function fixtureRun() {
  const runId = argValue('--run-id', 'fixture-run');
  const runDir = runDirFor(runId);
  mkdirSync(runDir, { recursive: true });
  const batchState = join(runDir, 'batch-state.tsv');
  const summary = join(runDir, 'summary.md');
  const workflowLog = join(runDir, 'workflow.log');
  writeFileSync(batchState, [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://jobs.example/a\tcompleted\t-\t-\t701\t4.2\t-\t0',
    '2\thttps://jobs.example/b\tskipped\t-\t-\t702\t2.0\tbelow-min-score\t0',
    '',
  ].join('\n'));
  writeFileSync(summary, `# Career Ops Fixture Summary\n\nRun: ${runId}\n`);
  writeFileSync(workflowLog, 'fixture workflow completed\n');
  const state = {
    runId,
    phase: 'completed',
    message: 'Fixture workflow completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    pendingBefore: 2,
    pendingAfterScan: 2,
    liveness: { active: 2, expired: 0, uncertain: 0 },
    artifacts: { summary, batchState, workflowLog },
  };
  const statePath = join(runDir, 'state.json');
  writeJson(statePath, state);
  writeJson(join(AUTOMATION_DIR, 'current.json'), { runId, statePath });
}

function notify() {
  const currentPath = join(AUTOMATION_DIR, 'current.json');
  if (!existsSync(currentPath)) return;
  const current = readJson(currentPath);
  if (!current.statePath || !existsSync(current.statePath)) return;
  const state = readJson(current.statePath);
  const batchStatePath = state.artifacts?.batchState;
  const batch = batchStatePath && existsSync(batchStatePath)
    ? parseBatchState(readFileSync(batchStatePath, 'utf8'))
    : null;
  const fingerprint = JSON.stringify({
    phase: state.phase,
    message: state.message,
    completed: batch?.completed || 0,
    failed: batch?.failed || 0,
    skipped: batch?.skipped || 0,
    remaining: batch ? batch.processing + batch.pending + batch.rateLimited + batch.paused : 0,
  });
  const checkpointPath = join(dirname(current.statePath), 'notification.json');
  if (existsSync(checkpointPath) && readJson(checkpointPath).fingerprint === fingerprint) return;
  writeJson(checkpointPath, { fingerprint, notifiedAt: new Date().toISOString() });
  process.stdout.write(renderNotification(state, batch));
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  const command = process.argv[2];
  if (command === 'start') startWorkflow();
  else if (command === 'run') runWorkflow();
  else if (command === 'cron') cronWorkflow();
  else if (command === 'fixture-run') fixtureRun();
  else if (command === 'notify') notify();
  else {
    console.error('Usage: node scripts/career-ops-automation.mjs <start|run|notify|status|delivery-test|fixture-run>');
    process.exitCode = 1;
  }
}
