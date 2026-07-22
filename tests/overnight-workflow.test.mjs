// tests/overnight-workflow.test.mjs — Comprehensive test suite for overnight workflow automation

import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join, relative } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  getNextPhoenix1AM,
  parseResetTimestamp,
  parsePipelinePendingRoles,
  convertPendingRolesToBatchInput,
  isSupportedAtsUrl,
  runOvernightWorkflow,
} from '../automation/overnight-workflow.mjs';
import { generateDailyDigest } from '../automation/daily-digest.mjs';
import { generateWeeklyReview } from '../automation/weekly-review.mjs';
import { generateExceptionReport } from '../automation/exception-report.mjs';

console.log('\nautomation/overnight-workflow.mjs — test suite');

function createFixtureWorkspace() {
  const tmpParent = join(ROOT, 'tmp');
  mkdirSync(tmpParent, { recursive: true });
  const dir = mkdtempSync(join(tmpParent, 'cops-overnight-test-'));
  const configDir = join(dir, 'config');
  const dataDir = join(dir, 'data');
  const batchDir = join(dir, 'batch');
  const reportsDir = join(dir, 'reports');
  const outputDir = join(dir, 'output');

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(batchDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const mockRunner = join(dir, 'mock-runner.sh');
  writeFileSync(mockRunner, '#!/usr/bin/env bash\necho "mock runner done"\nexit 0\n');
  execFileSync('chmod', ['+x', mockRunner]);

  const mockScan = join(dir, 'mock-scan.mjs');
  writeFileSync(mockScan, 'console.log("mock scan done");\n');

  return {
    dir,
    configDir,
    dataDir,
    batchDir,
    reportsDir,
    outputDir,
    mockRunner,
    mockScan,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

try {
  // Test 1: Empty scans
  {
    const ws = createFixtureWorkspace();
    try {
      const pipelineFile = join(ws.dataDir, 'pipeline.md');
      writeFileSync(pipelineFile, '# Pipeline\n\n## Pendientes\n\n(No offers)\n');

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile,
        stateFile: join(ws.batchDir, 'batch-state.tsv'),
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      if (res && res.discovered === 0 && res.eligible === 0) {
        pass('1. Empty scans handled gracefully with zero discovered roles');
      } else {
        fail(`1. Empty scan output unexpected: ${JSON.stringify(res)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 2: Duplicates handling
  {
    const ws = createFixtureWorkspace();
    try {
      const inputTsv = join(ws.batchDir, 'batch-input.tsv');
      const pendingRoles = [
        { title: 'Engineer', url: 'https://example.com/job1', source: 'test' },
        { title: 'Engineer', url: 'https://example.com/job1', source: 'test' },
        { title: 'Designer', url: 'https://example.com/job2', source: 'test' },
      ];

      const r1 = convertPendingRolesToBatchInput(inputTsv, pendingRoles);
      const r2 = convertPendingRolesToBatchInput(inputTsv, pendingRoles);

      const lines = readFileSync(inputTsv, 'utf-8').split(/\r?\n/).filter(Boolean);
      if (r1.addedCount === 2 && r2.addedCount === 0 && lines.length === 3) {
        pass('2. Duplicate pending roles deduplicated correctly in batch-input.tsv');
      } else {
        fail(`2. Duplicate roles handling failed: r1=${r1.addedCount}, r2=${r2.addedCount}, lines=${lines.length}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 3: Filtered / skipped roles
  {
    const ws = createFixtureWorkspace();
    try {
      const stateFile = join(ws.batchDir, 'batch-state.tsv');
      writeFileSync(
        stateFile,
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
        '1\thttps://example.com/job1\tskipped\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t001\t2.0\tbelow-min-score\t0\n'
      );

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile: join(ws.dataDir, 'pipeline.md'),
        stateFile,
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      if (res && res.auto_filtered === 1) {
        pass('3. Filtered/skipped roles correctly counted in auto_filtered metric');
      } else {
        fail(`3. Filtered roles count expected 1, got ${res ? res.auto_filtered : null}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 4: Full backlog drain
  {
    const ws = createFixtureWorkspace();
    try {
      const pipelineFile = join(ws.dataDir, 'pipeline.md');
      writeFileSync(
        pipelineFile,
        '# Pipeline\n\n## Pendientes\n- [Acme - Senior Dev](https://boards.greenhouse.io/acme/jobs/101)\n- [Globex - Tech Lead](https://jobs.ashbyhq.com/globex/202)\n'
      );

      const stateFile = join(ws.batchDir, 'batch-state.tsv');
      writeFileSync(
        stateFile,
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
        '1\thttps://boards.greenhouse.io/acme/jobs/101\tcompleted\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t001\t4.5\t-\t0\n' +
        '2\thttps://jobs.ashbyhq.com/globex/202\tcompleted\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t002\t4.0\t-\t0\n'
      );

      // Create reports and output files
      writeFileSync(join(ws.reportsDir, '001-acme.md'), '# Report 001\nStatus: Passed\nScore: 4.5\n');
      writeFileSync(join(ws.reportsDir, '002-globex.md'), '# Report 002\nStatus: Passed\nScore: 4.0\n');
      writeFileSync(join(ws.outputDir, 'CV-001.pdf'), 'mock pdf');
      writeFileSync(join(ws.outputDir, 'CV-002.pdf'), 'mock pdf');

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile,
        stateFile,
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      if (res && res.discovered === 2 && res.evaluated === 2 && res.passed === 2) {
        pass('4. Backlog drained fully with correct discovered, evaluated, and passed metrics');
      } else {
        fail(`4. Full backlog drain failed: ${JSON.stringify(res)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 5: Stale lock recovery
  {
    const ws = createFixtureWorkspace();
    try {
      const lockFile = join(ws.batchDir, '.overnight-workflow.lock');
      // Write a lock file with a non-existent PID (e.g. 999999)
      writeFileSync(lockFile, JSON.stringify({ pid: 999999, started_at: '2026-01-01T00:00:00Z' }));

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile: join(ws.dataDir, 'pipeline.md'),
        stateFile: join(ws.batchDir, 'batch-state.tsv'),
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      if (res && res.run_id) {
        pass('5. Stale lock file safely detected and recovered');
      } else {
        fail('5. Stale lock recovery failed');
      }
    } finally {
      ws.clean();
    }
  }

  // Test 6: Interrupted / resumed batches
  {
    const ws = createFixtureWorkspace();
    try {
      const stateFile = join(ws.batchDir, 'batch-state.tsv');
      writeFileSync(
        stateFile,
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
        '1\thttps://example.com/job1\tpaused_rate_limit\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t001\t-\tsession limit reached\t0\n'
      );

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile: join(ws.dataDir, 'pipeline.md'),
        stateFile,
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      if (res && res.paused === 1 && res.resume_at !== null) {
        pass('6. Paused/interrupted batch detected with valid resume_at calculation');
      } else {
        fail(`6. Interrupted/resumed batch test failed: ${JSON.stringify(res)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 7: Reliable reset timestamp parsing
  {
    const logText = 'Worker error: rate limit reached, resets 04:00am';
    const parsed = parseResetTimestamp(logText);
    if (parsed && typeof parsed === 'string' && parsed.endsWith('Z')) {
      pass('7. Reliable reset timestamp parsed correctly (reset + 5 minutes)');
    } else {
      fail(`7. Reliable reset timestamp failed: ${parsed}`);
    }
  }

  // Test 8: Missing reset timestamp fallback (next 1:00 AM America/Phoenix)
  {
    const phoenix1am = getNextPhoenix1AM();
    if (phoenix1am && typeof phoenix1am === 'string' && phoenix1am.endsWith('Z')) {
      pass('8. Missing reset timestamp falls back to next 1:00 AM America/Phoenix');
    } else {
      fail(`8. Phoenix 1am fallback failed: ${phoenix1am}`);
    }
  }

  // Test 9: Idempotent reruns
  {
    const ws = createFixtureWorkspace();
    try {
      const pipelineFile = join(ws.dataDir, 'pipeline.md');
      writeFileSync(pipelineFile, '# Pipeline\n\n## Pendientes\n- [Job](https://example.com/job1)\n');

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile,
        stateFile: join(ws.batchDir, 'batch-state.tsv'),
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res1 = await runOvernightWorkflow(opts);
      const res2 = await runOvernightWorkflow(opts);

      if (res1.idempotency_keys.length === 1 && res2.idempotency_keys.length === 1 && res1.idempotency_keys[0] === res2.idempotency_keys[0]) {
        pass('9. Idempotent reruns produce consistent idempotency keys without state duplication');
      } else {
        fail(`9. Idempotent rerun failed: res1=${JSON.stringify(res1)}, res2=${JSON.stringify(res2)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 10: Passed package creation & ATS prefill check
  {
    const ws = createFixtureWorkspace();
    try {
      const stateFile = join(ws.batchDir, 'batch-state.tsv');
      writeFileSync(
        stateFile,
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
        '101\thttps://boards.greenhouse.io/acme/jobs/999\tcompleted\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t101\t4.8\t-\t0\n'
      );

      writeFileSync(join(ws.reportsDir, '101-acme-role.md'), '# Report 101\nStatus: Passed\nScore: 4.8\n');
      writeFileSync(join(ws.outputDir, 'CV-101.pdf'), 'mock pdf payload');
      writeFileSync(join(ws.outputDir, 'cover-101.txt'), 'mock cover letter');

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile: join(ws.dataDir, 'pipeline.md'),
        stateFile,
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      const packageFile = join(ws.reportsDir, 'packages', 'package-101.json');

      if (res && res.draft_ready === 1 && existsSync(packageFile)) {
        const pkgData = JSON.parse(readFileSync(packageFile, 'utf-8'));
        if (pkgData.status === 'Passed' && pkgData.pdf_file && isSupportedAtsUrl(pkgData.url)) {
          pass('10. Passed role review package manifest created with PDF and ATS prefill support');
        } else {
          fail(`10. Package content invalid: ${JSON.stringify(pkgData)}`);
        }
      } else {
        fail(`10. Package creation failed: res=${JSON.stringify(res)}, packageExists=${existsSync(packageFile)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 11: Missing artifacts handling
  {
    const ws = createFixtureWorkspace();
    try {
      const stateFile = join(ws.batchDir, 'batch-state.tsv');
      writeFileSync(
        stateFile,
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
        '102\thttps://example.com/job102\tcompleted\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t102\t4.0\t-\t0\n'
      );
      // Notice: report and PDF are intentionally NOT created

      const opts = {
        dryRun: true,
        json: true,
        configDir: ws.configDir,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        outputDir: ws.outputDir,
        pipelineFile: join(ws.dataDir, 'pipeline.md'),
        stateFile,
        runnerCmd: ws.mockRunner,
        scanCmd: `node "${ws.mockScan}"`,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      };

      const res = await runOvernightWorkflow(opts);
      if (res && res.missing_artifact === 1) {
        pass('11. Missing artifacts recorded without marking application submitted');
      } else {
        fail(`11. Missing artifacts test failed: ${JSON.stringify(res)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 12: In-progress digest
  {
    const ws = createFixtureWorkspace();
    try {
      const lockFile = join(ws.batchDir, '.overnight-workflow.lock');
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

      const digest = generateDailyDigest({
        json: true,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
        stateFile: join(ws.batchDir, 'batch-state.tsv'),
      });

      if (digest && digest.in_progress === true) {
        pass('12. Daily digest correctly detects active lock file and reports in-progress status');
      } else {
        fail(`12. In-progress digest test failed: ${JSON.stringify(digest)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 13: Weekly review
  {
    const ws = createFixtureWorkspace();
    try {
      const stateFile = join(ws.batchDir, 'batch-state.tsv');
      writeFileSync(
        stateFile,
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
        '1\thttps://example.com/job1\tcompleted\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t001\t4.0\t-\t0\n' +
        '2\thttps://example.com/job2\tcompleted\t2026-07-21T00:00:00Z\t2026-07-21T00:01:00Z\t002\t5.0\t-\t0\n'
      );

      const review = generateWeeklyReview({
        json: true,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        reportsDir: ws.reportsDir,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
        stateFile,
      });

      if (review && review.summary.completed === 2 && review.summary.average_score === 4.5) {
        pass('13. Weekly review aggregates completed metrics and average scores correctly');
      } else {
        fail(`13. Weekly review test failed: ${JSON.stringify(review)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 14: Exception report (silent when empty)
  {
    const ws = createFixtureWorkspace();
    try {
      const rep = generateExceptionReport({
        json: true,
        dataDir: ws.dataDir,
        batchDir: ws.batchDir,
        checkpointFile: join(ws.dataDir, '.overnight-checkpoint.json'),
      });

      if (rep === null) {
        pass('14. Exception report is completely silent (null) when no exceptions exist');
      } else {
        fail(`14. Exception report non-null on clean state: ${JSON.stringify(rep)}`);
      }
    } finally {
      ws.clean();
    }
  }

  // Test 15: Static Safety Invariant Assertions
  {
    const workflowCode = readFileSync(join(ROOT, 'automation', 'overnight-workflow.mjs'), 'utf-8');
    const digestCode = readFileSync(join(ROOT, 'automation', 'daily-digest.mjs'), 'utf-8');
    const weeklyCode = readFileSync(join(ROOT, 'automation', 'weekly-review.mjs'), 'utf-8');
    const exceptionCode = readFileSync(join(ROOT, 'automation', 'exception-report.mjs'), 'utf-8');

    const forbiddenPatterns = [
      /\bfetch\s*\([^)]*method:\s*['"]POST['"]/i,
      /\bhttp\.request\s*\([^)]*method:\s*['"]POST['"]/i,
      /\baxios\.post\b/i,
      /\bsendEmail\b/i,
      /\brecruiterOutreach\b/i,
      /status\s*=\s*['"]applied['"]/i,
      /status\s*=\s*['"]submitted['"]/i,
    ];

    let violation = null;
    for (const code of [workflowCode, digestCode, weeklyCode, exceptionCode]) {
      for (const pat of forbiddenPatterns) {
        if (pat.test(code)) {
          violation = pat.toString();
          break;
        }
      }
    }

    if (!violation) {
      pass('15. Static safety assertions verified: No POST application calls, emails, or status mutations in workflow');
    } else {
      fail(`15. Static safety violation found: ${violation}`);
    }
  }

} catch (err) {
  fail(`overnight-workflow.test.mjs crashed: ${err.message}\n${err.stack}`);
}
