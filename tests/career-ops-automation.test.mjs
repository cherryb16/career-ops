import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'career-ops-automation.mjs');

import {
  buildBatchInput,
  extractPendingPipelineEntries,
  moveExpiredPipelineEntries,
  parseBatchState,
  renderNotification,
  resetNonTerminalBatchRows,
} from '../scripts/career-ops-automation.mjs';

test('extractPendingPipelineEntries reads only unchecked rows from the pending section', () => {
  const pipeline = `# Pipeline\n\n## Pendientes\n- [ ] https://jobs.example/a | Acme | Strategy Analyst | Provo, UT | posted: 2026-08-31\n- [x] https://jobs.example/already | Acme | Old Role\n- [!] https://jobs.example/login | Login required\n\n## Procesadas\n- [ ] https://jobs.example/not-pending | Wrong Section | Ignore Me\n`;

  assert.deepEqual(extractPendingPipelineEntries(pipeline), [
    {
      url: 'https://jobs.example/a',
      company: 'Acme',
      title: 'Strategy Analyst',
      location: 'Provo, UT',
      raw: '- [ ] https://jobs.example/a | Acme | Strategy Analyst | Provo, UT | posted: 2026-08-31',
    },
  ]);
});

test('buildBatchInput creates a clean run-scoped TSV with stable numeric IDs', () => {
  const output = buildBatchInput([
    {
      url: 'https://jobs.example/a',
      company: 'Acme\tCorp',
      title: 'Strategy\nAnalyst',
      location: 'Provo, UT',
      raw: '',
    },
  ]);

  assert.equal(
    output,
    'id\turl\tsource\tnotes\n1\thttps://jobs.example/a\tscheduled-pipeline\tAcme Corp | Strategy Analyst | Provo, UT\n',
  );
});

test('parseBatchState reports progress and keeps malformed rows visible', () => {
  const state = [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://jobs.example/a\tcompleted\t-\t-\t701\t4.2\t-\t0',
    '2\thttps://jobs.example/b\tfailed\t-\t-\t702\t-\tJD unavailable\t2',
    '3\thttps://jobs.example/c\tprocessing\t-\t-\t703\t-\t-\t0',
    'broken row',
    '',
  ].join('\n');

  assert.deepEqual(parseBatchState(state), {
    total: 4,
    completed: 1,
    processing: 1,
    failed: 1,
    pending: 0,
    skipped: 0,
    rateLimited: 0,
    paused: 0,
    malformed: 1,
    scored: 1,
    averageScore: 4.2,
    rows: [
      { id: '1', url: 'https://jobs.example/a', status: 'completed', report: '701', score: 4.2, error: '-' },
      { id: '2', url: 'https://jobs.example/b', status: 'failed', report: '702', score: null, error: 'JD unavailable' },
      { id: '3', url: 'https://jobs.example/c', status: 'processing', report: '703', score: null, error: '-' },
    ],
  });
});

test('resetNonTerminalBatchRows preserves terminal work and resets only fallback candidates', () => {
  const state = [
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://jobs.example/a\tcompleted\tstart\tend\t701\t4.2\t-\t0',
    '2\thttps://jobs.example/b\tskipped\tstart\tend\t702\t2.0\tbelow-min-score\t0',
    '3\thttps://jobs.example/c\tfailed\tstart\tend\t703\t-\tquota\t2',
    '4\thttps://jobs.example/d\tpaused_rate_limit\tstart\tend\t704\t-\tquota\t1',
    '',
  ].join('\n');

  const reset = resetNonTerminalBatchRows(state);
  assert.match(reset, /1\thttps:\/\/jobs\.example\/a\tcompleted\tstart\tend\t701\t4\.2\t-\t0/);
  assert.match(reset, /2\thttps:\/\/jobs\.example\/b\tskipped\tstart\tend\t702\t2\.0\tbelow-min-score\t0/);
  assert.match(reset, /3\thttps:\/\/jobs\.example\/c\tpending\t-\t-\t-\t-\t-\t0/);
  assert.match(reset, /4\thttps:\/\/jobs\.example\/d\tpending\t-\t-\t-\t-\t-\t0/);
});

test('moveExpiredPipelineEntries moves only expired pending rows into the existing processed section', () => {
  const pipeline = `# Pipeline\n\n## Pending\n- [ ] https://jobs.example/a | Acme | Strategy Analyst\n- [ ] https://jobs.example/b | Beta | Operations Analyst\n\n## Processed\n- [x] #700 | https://jobs.example/old | Old Co | Old Role | 3.0/5 | PDF ❌\n`;

  const result = moveExpiredPipelineEntries(pipeline, new Set(['https://jobs.example/a']));
  assert.equal(result.moved, 1);
  assert.match(result.text, /## Pending\n- \[ \] https:\/\/jobs\.example\/b/);
  assert.doesNotMatch(result.text, /## Pending[\s\S]*- \[ \] https:\/\/jobs\.example\/a/);
  assert.match(
    result.text,
    /## Processed\n- \[x\] ~~https:\/\/jobs\.example\/a \| Acme \| Strategy Analyst~~ — posting expired \(scheduled liveness sweep\)/,
  );
});

test('renderNotification emits Telegram-friendly Markdown and explicit MEDIA attachments', () => {
  const output = renderNotification(
    {
      runId: '20260831T060000-0600',
      phase: 'completed',
      message: 'All stages finished',
      pendingBefore: 12,
      pendingAfterScan: 15,
      liveness: { active: 12, expired: 2, uncertain: 1 },
      artifacts: {
        summary: '/tmp/career ops/summary.md',
        batchState: '/tmp/career ops/batch-state.tsv',
        workflowLog: '/tmp/career ops/workflow.log',
      },
    },
    {
      total: 13,
      completed: 11,
      processing: 0,
      failed: 1,
      pending: 0,
      skipped: 1,
      rateLimited: 0,
      paused: 0,
      malformed: 0,
      scored: 10,
      averageScore: 3.8,
      rows: [],
    },
  );

  assert.match(output, /^💼 \*Career Ops — Complete\*/);
  assert.match(output, /\*Evaluations:\* 11 completed · 1 skipped · 1 failed/);
  assert.match(output, /\*Average score:\* 3\.8\/5/);
  assert.match(output, /MEDIA:\/tmp\/career ops\/summary\.md/);
  assert.match(output, /MEDIA:\/tmp\/career ops\/batch-state\.tsv/);
  assert.match(output, /MEDIA:\/tmp\/career ops\/workflow\.log/);
});

test('fixture-run plus notify proves durable state, Markdown, attachments, and silent dedupe', () => {
  const automationDir = mkdtempSync(join(tmpdir(), 'career-ops-automation-'));
  const env = { ...process.env, CAREER_OPS_AUTOMATION_DIR: automationDir };
  try {
    execFileSync(process.execPath, [SCRIPT, 'fixture-run', '--run-id', 'fixture-001'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    const statePath = join(automationDir, 'runs', 'fixture-001', 'state.json');
    assert.equal(existsSync(statePath), true);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).phase, 'completed');

    const first = execFileSync(process.execPath, [SCRIPT, 'notify'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.match(first, /^💼 \*Career Ops — Complete\*/);
    assert.match(first, /MEDIA:.*summary\.md/);
    assert.match(first, /MEDIA:.*batch-state\.tsv/);

    const second = execFileSync(process.execPath, [SCRIPT, 'notify'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(second, '');
  } finally {
    rmSync(automationDir, { recursive: true, force: true });
  }
});

test('run dry-run builds isolated artifacts without scanning or evaluating', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-dry-run-'));
  const automationDir = join(root, 'automation');
  const pipeline = join(root, 'pipeline.md');
  writeFileSync(pipeline, '# Pipeline\n\n## Pending\n- [ ] https://jobs.example/a | Acme | Strategy Analyst\n- [ ] https://jobs.example/b | Beta | Operations Analyst\n\n## Processed\n');
  const env = {
    ...process.env,
    CAREER_OPS_AUTOMATION_DIR: automationDir,
    CAREER_OPS_PIPELINE_FILE: pipeline,
  };
  try {
    execFileSync(process.execPath, [
      SCRIPT,
      'run',
      '--run-id',
      'dry-001',
      '--dry-run',
      '--skip-scan',
      '--skip-liveness',
    ], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });

    const runDir = join(automationDir, 'runs', 'dry-001');
    const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    assert.equal(state.phase, 'completed');
    assert.equal(state.pendingBefore, 2);
    assert.equal(state.pendingAfterScan, 2);
    assert.match(state.message, /Dry run/);
    assert.equal(readFileSync(join(runDir, 'batch-input.tsv'), 'utf8').split('\n').filter(Boolean).length, 3);
    assert.equal(readFileSync(pipeline, 'utf8').includes('https://jobs.example/a'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('start detaches a worker and returns an immediate Markdown launch message', async () => {
  const automationDir = mkdtempSync(join(tmpdir(), 'career-ops-start-'));
  const env = { ...process.env, CAREER_OPS_AUTOMATION_DIR: automationDir };
  try {
    const output = execFileSync(process.execPath, [
      SCRIPT,
      'start',
      '--fixture',
      '--run-id',
      'start-001',
    ], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
    assert.match(output, /^💼 \*Career Ops — Started\*/);
    assert.match(output, /start-001/);

    const statePath = join(automationDir, 'runs', 'start-001', 'state.json');
    let state;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (state.phase === 'completed') break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(state?.phase, 'completed');
  } finally {
    rmSync(automationDir, { recursive: true, force: true });
  }
});
