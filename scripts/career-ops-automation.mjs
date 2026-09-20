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

    const item = rawLine.match(/^\s*\[\s\]\s+(.+?)\s*$/);
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
      const item = rawLine.match(/^\s*\[\s\]\s+(.+?)\s*$/);
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

function runDirFor(runId) {
  return join(AUTOMATION_DIR, 'runs', runId);
}

function appendAtomic(filePath, content) {
  appendFileSync(filePath, content);
}

export async function executeWebSearchViaBatchRunner(root, workflowLog) {
  appendAtomic(workflowLog, 'Starting WebSearch execution via batch-runner\n');
  
  // Read portals.yml to get WebSearch companies
  const portalsPath = join(root, 'portals.yml');
  if (!existsSync(portalsPath)) {
    appendAtomic(workflowLog, 'portals.yml not found\n');
    return 'Error: portals.yml not found';
  }
  
  const portalsContent = readFileSync(portalsPath, 'utf8');
  const yaml = await import('js-yaml');
  const portals = yaml.load(portalsContent);
  
  // Extract companies with websearch scan_method
  const webSearchCompanies = [];
  if (portals && portals.tracked_companies) {
    for (const [name, config] of Object.entries(portals.tracked_companies)) {
      if (config?.scan_method === 'websearch') {
                webSearchCompanies.push({
                  name,
                  query: config.scan_query || '',
                  careers_url: config.careers_url || ''
                });
              }
    }
  }
  
  appendAtomic(workflowLog, `Found ${webSearchCompanies.length} companies with websearch method\n`);
  
  if (webSearchCompanies.length === 0) {
    appendAtomic(workflowLog, 'No websearch companies found\n');
    return 'No websearch companies to process';
  }
  
  // Create batch input file for web search
  const webSearchBatchInput = join(root, 'batch', 'websearch-input.tsv');
  const rows = ['id\turl\tsource\tnotes'];
  
  webSearchCompanies.forEach((company, index) => {
    const id = 9000 + index;
    const notes = `${company.name} | ${company.query} | ${company.careers_url}`;
    rows.push(`${id}\thttps://websearch.placeholder\twebsearch\t${notes}`);
  });
  
  writeFileSync(webSearchBatchInput, `${rows.join('\n')}\n`);
  
  // Set environment for batch-runner to use web search input and prompt
    const batchEnv = { 
      ...process.env,
      BATCH_INPUT_FILE: webSearchBatchInput,
      PROMPT_FILE: join(root, 'batch', 'web-search-prompt.md')
    };
  
    // Run batch-runner with Hermes CLI and Codex model
    appendAtomic(workflowLog, 'Executing batch-runner with Hermes CLI (Codex model)...\n');
  
    try {
      const result = execFileSync('./batch/batch-runner.sh', [
        '--cli', 'hermes',
        '--model', 'codex',
        '--parallel', '2',
        '--limit', '10'
      ], {
        cwd: root,
        env: batchEnv,
        encoding: 'utf8',
        timeout: 1800000  // 30 minutes for web search
      });
    appendAtomic(workflowLog, result);
    return result;
  } catch (err) {
    const output = err.stdout || err.message || 'Unknown error';
    appendAtomic(workflowLog, `websearch batch error: ${output}\n`);
    return `Error: ${output}`;
  }
}

export async function cronWorkflow() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = runDirFor(runId);
  mkdirSync(runDir, { recursive: true });
  const workflowLog = join(runDir, 'workflow.log');
  appendAtomic(workflowLog, `cron workflow started ${new Date().toISOString()}\n`);
  
  // 1. Scan (uses node scan.mjs)
  appendAtomic(workflowLog, '=== SCAN ===\n');
  try {
    const scanResult = execFileSync('node', ['scan.mjs', '--quiet'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 300000,
    });
    appendAtomic(workflowLog, scanResult);
  } catch (err) {
    const output = err.stdout || err.message;
    appendAtomic(workflowLog, `scan error: ${output}\n`);
  }
  
  // 2. WebSearch execution for companies requiring web search
  appendAtomic(workflowLog, '=== WEBSEARCH EXECUTION ===\n');
  try {
    const webSearchResult = execFileSync('node', ['scripts/web-search.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 1800000,  // 30 minutes
    });
    appendAtomic(workflowLog, webSearchResult);
  } catch (err) {
    const output = err.stdout || err.message;
    appendAtomic(workflowLog, `websearch error: ${output}\n`);
  }
  
  // 3. Liveness sweep on pending pipeline entries
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
        timeout: 300000,
      });
      appendAtomic(workflowLog, livenessResult);
      // Parse expired URLs and move them
      const expiredUrls = new Set();
      for (const line of livenessResult.split('\n')) {
        if (line.startsWith('❌')) {
          const url = line.split(/\s+/).slice(2).join(' ').trim();
          expiredUrls.add(url);
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
  
  // 4. Reset non-terminal batch rows so retried jobs can run
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
  
  // 5. Batch evaluation
  appendAtomic(workflowLog, '=== BATCH EVALUATION ===\n');
  try {
    const batchResult = execFileSync('./batch/batch-runner.sh', ['--cli', 'agy', '--parallel', '2', '--limit', '30'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 600000,
    });
    appendAtomic(workflowLog, batchResult);
  } catch (err) {
    appendAtomic(workflowLog, `batch error: ${err.stdout || err.message}\n`);
  }
  
  // 6. Merge tracker
  appendAtomic(workflowLog, '=== MERGE TRACKER ===\n');
  try {
    const mergeResult = execFileSync('node', ['merge-tracker.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 120000,
    });
    appendAtomic(workflowLog, mergeResult);
  } catch (err) {
    appendAtomic(workflowLog, `merge error: ${err.stdout || err.message}\n`);
  }
  
  // 7. Reconcile pipeline
  appendAtomic(workflowLog, '=== RECONCILE PIPELINE ===\n');
  try {
    const reconcileResult = execFileSync('node', ['reconcile-pipeline.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 60000,
    });
    appendAtomic(workflowLog, reconcileResult);
  } catch (err) {
    appendAtomic(workflowLog, `reconcile error: ${err.stdout || err.message}\n`);
  }
  
  // 8. Verify pipeline
  appendAtomic(workflowLog, '=== VERIFY PIPELINE ===\n');
  try {
    const verifyResult = execFileSync('node', ['verify-pipeline.mjs'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 60000,
    });
    appendAtomic(workflowLog, verifyResult);
  } catch (err) {
    appendAtomic(workflowLog, `verify error: ${err.stdout || err.message}\n`);
  }
  
  // 9. Notify
  appendAtomic(workflowLog, '=== NOTIFY ===\n');
  try {
    const stateFile = join(runDir, 'state.json');
    const batchState = join(runDir, 'batch-state.tsv');
    const summary = join(runDir, 'summary.md');
    writeFileSync(batchState, 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n');
    writeFileSync(summary, `# Career Ops Overnight Summary\n\nRun: ${runId}\n`);
    const state = {
      runId,
      phase: 'completed',
      artifacts: { workflowLog, batchState, summary },
    };
    writeJson(stateFile, state);
    appendAtomic(workflowLog, 'Notification prepared\n');
  } catch (err) {
    appendAtomic(workflowLog, `notify error: ${err.message}\n`);
  }
  
  appendAtomic(workflowLog, `cron workflow completed ${new Date().toISOString()}\n`);
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].includes('career-ops-automation.mjs')) {
  if (process.argv[2] === 'cron') {
    cronWorkflow().catch((err) => {
      console.error('Cron workflow failed:', err);
      process.exit(1);
    });
  } else {
    console.log('Usage: node career-ops-automation.mjs cron');
    process.exit(1);
  }
}