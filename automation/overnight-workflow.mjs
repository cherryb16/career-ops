#!/usr/bin/env node

/**
 * automation/overnight-workflow.mjs
 *
 * Deterministic overnight workflow orchestrator for career-ops.
 * Scans public portals, applies hard filters, evaluates pending roles via AGY batch-runner,
 * prepares review package manifests for Passed roles, and emits structured run summaries.
 *
 * Safety Invariant: NEVER submits applications, POSTs forms, sends emails/messages,
 * or invokes recruiter outreach. Authenticated portal sources remain explicit human blockers.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import path from 'path';
import { execSync, execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

// ── CLI Arg Parsing ──────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: false,
    json: false,
    configDir: process.env.CAREER_OPS_CONFIG || path.join(ROOT_DIR, 'config'),
    dataDir: process.env.CAREER_OPS_DATA || path.join(ROOT_DIR, 'data'),
    batchDir: process.env.CAREER_OPS_BATCH || path.join(ROOT_DIR, 'batch'),
    reportsDir: process.env.CAREER_OPS_REPORTS || path.join(ROOT_DIR, 'reports'),
    outputDir: process.env.CAREER_OPS_OUTPUT || path.join(ROOT_DIR, 'output'),
    portalsFile: process.env.CAREER_OPS_PORTALS || path.join(ROOT_DIR, 'portals.yml'),
    stateFile: process.env.CAREER_OPS_STATE || null,
    pipelineFile: process.env.CAREER_OPS_PIPELINE || null,
    runnerCmd: process.env.CAREER_OPS_RUNNER_CMD || null,
    prepareCmd: process.env.CAREER_OPS_PREPARE_CMD || null,
    livenessCmd: process.env.CAREER_OPS_LIVENESS_CMD || null,
    scanCmd: process.env.CAREER_OPS_SCAN_CMD || null,
    checkpointFile: process.env.CAREER_OPS_CHECKPOINT || null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--config-dir' && i + 1 < args.length) opts.configDir = args[++i];
    else if (arg === '--data-dir' && i + 1 < args.length) opts.dataDir = args[++i];
    else if (arg === '--batch-dir' && i + 1 < args.length) opts.batchDir = args[++i];
    else if (arg === '--reports-dir' && i + 1 < args.length) opts.reportsDir = args[++i];
    else if (arg === '--output-dir' && i + 1 < args.length) opts.outputDir = args[++i];
    else if (arg === '--portals-file' && i + 1 < args.length) opts.portalsFile = args[++i];
    else if (arg === '--state-file' && i + 1 < args.length) opts.stateFile = args[++i];
    else if (arg === '--pipeline-file' && i + 1 < args.length) opts.pipelineFile = args[++i];
    else if (arg === '--runner-cmd' && i + 1 < args.length) opts.runnerCmd = args[++i];
    else if (arg === '--prepare-cmd' && i + 1 < args.length) opts.prepareCmd = args[++i];
    else if (arg === '--liveness-cmd' && i + 1 < args.length) opts.livenessCmd = args[++i];
    else if (arg === '--scan-cmd' && i + 1 < args.length) opts.scanCmd = args[++i];
    else if (arg === '--checkpoint-file' && i + 1 < args.length) opts.checkpointFile = args[++i];
  }

  if (!opts.stateFile) opts.stateFile = path.join(opts.batchDir, 'batch-state.tsv');
  if (!opts.pipelineFile) opts.pipelineFile = path.join(opts.dataDir, 'pipeline.md');
  if (!opts.checkpointFile) opts.checkpointFile = path.join(opts.dataDir, '.overnight-checkpoint.json');

  return opts;
}

// ── Lock Management ──────────────────────────────────────────────────

function acquireLock(batchDir) {
  const lockFile = path.join(batchDir, '.overnight-workflow.lock');
  mkdirSync(batchDir, { recursive: true });

  if (existsSync(lockFile)) {
    try {
      const lockData = JSON.parse(readFileSync(lockFile, 'utf-8'));
      const pid = lockData.pid;
      let isAlive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }
      if (isAlive) {
        throw new Error(`Another overnight-workflow process is running (PID ${pid})`);
      } else {
        // Stale lock
        unlinkSync(lockFile);
      }
    } catch (err) {
      if (err.message.includes('Another overnight-workflow')) throw err;
      // Stale or unparseable lock file
      try { unlinkSync(lockFile); } catch {}
    }
  }

  const payload = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  writeFileSync(lockFile, JSON.stringify(payload, null, 2), 'utf-8');

  return () => {
    try {
      if (existsSync(lockFile)) {
        const lockData = JSON.parse(readFileSync(lockFile, 'utf-8'));
        if (lockData.pid === process.pid) {
          unlinkSync(lockFile);
        }
      }
    } catch {}
  };
}

// ── Timezone / Reset Calculations ────────────────────────────────────

/**
 * Calculates next 1:00 AM America/Phoenix.
 * Phoenix is UTC-7 year-round (no DST), so 1:00 AM Phoenix = 08:00:00 UTC.
 */
export function getNextPhoenix1AM(now = new Date()) {
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();

  // Target today at 08:00 UTC
  let target = new Date(Date.UTC(utcYear, utcMonth, utcDate, 8, 0, 0, 0));
  if (now.getTime() >= target.getTime()) {
    // Already past 08:00 UTC today, set to tomorrow at 08:00 UTC
    target = new Date(Date.UTC(utcYear, utcMonth, utcDate + 1, 8, 0, 0, 0));
  }
  return target.toISOString();
}

/**
 * Parses log and error content for reset timestamps.
 * If reliable timestamp found, returns ISO string of reset + 5 minutes.
 * Otherwise returns null.
 */
export function parseResetTimestamp(logContent) {
  if (!logContent || typeof logContent !== 'string') return null;

  // 1. Check ISO 8601 timestamps in log e.g. "reset at 2026-07-22T04:00:00Z"
  const isoMatch = logContent.match(/resets?[_\s]+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i);
  if (isoMatch) {
    const dt = new Date(isoMatch[1]);
    if (!isNaN(dt.getTime())) {
      return new Date(dt.getTime() + 5 * 60 * 1000).toISOString();
    }
  }

  // 2. Check "resets HH:MMam/pm" format e.g. "resets 04:00am" or "resets 4:00 PM"
  const timeMatch = logContent.match(/resets?\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3].toLowerCase().replace(/\./g, '');
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    const now = new Date();
    // Interpret in America/Phoenix (UTC-7)
    const targetUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours + 7, minutes, 0, 0));
    if (now.getTime() >= targetUtc.getTime()) {
      targetUtc.setUTCDate(targetUtc.getUTCDate() + 1);
    }
    return new Date(targetUtc.getTime() + 5 * 60 * 1000).toISOString();
  }

  // 3. Check "try again in X seconds/minutes/hours" or "retry after X seconds"
  const retryAfterMatch = logContent.match(/(?:retry|try again|wait)\s+(?:after|in)\s+(\d+)\s*(s|sec|seconds|m|min|minutes|h|hours)/i);
  if (retryAfterMatch) {
    const val = parseInt(retryAfterMatch[1], 10);
    const unit = retryAfterMatch[2].toLowerCase();
    let ms = val * 1000;
    if (unit.startsWith('m')) ms = val * 60 * 1000;
    if (unit.startsWith('h')) ms = val * 3600 * 1000;
    const now = new Date();
    return new Date(now.getTime() + ms + 5 * 60 * 1000).toISOString();
  }

  return null;
}

// ── Role Extraction & TSV Management ────────────────────────────────

export function parsePipelinePendingRoles(pipelineContent) {
  if (!pipelineContent || typeof pipelineContent !== 'string') return [];
  const roles = [];
  const lines = pipelineContent.split(/\r?\n/);
  let inPending = false;

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('##')) {
      const heading = line.toLowerCase();
      if (heading.includes('pendiente') || heading.includes('pending')) {
        inPending = true;
      } else if (heading.includes('procesada') || heading.includes('processed') || heading.includes('descartada')) {
        inPending = false;
      }
      continue;
    }

    if (!inPending) continue;

    // Match markdown links: - [Title or Company](URL) or - [ ] [Title](URL)
    const linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (linkMatch) {
      const title = linkMatch[1].trim();
      const url = linkMatch[2].trim();
      roles.push({ title, url, source: 'pipeline' });
    }
  }

  return roles;
}

export function convertPendingRolesToBatchInput(inputTsvPath, pendingRoles) {
  mkdirSync(path.dirname(inputTsvPath), { recursive: true });
  let existingLines = [];
  if (existsSync(inputTsvPath)) {
    existingLines = readFileSync(inputTsvPath, 'utf-8').split(/\r?\n/).filter(Boolean);
  }

  if (existingLines.length === 0) {
    existingLines.push('id\turl\tsource\tnotes');
  }

  const existingUrls = new Set();
  let maxId = 0;

  for (let i = 1; i < existingLines.length; i++) {
    const parts = existingLines[i].split('\t');
    if (parts.length >= 2) {
      const idNum = parseInt(parts[0], 10);
      if (!isNaN(idNum) && idNum > maxId) maxId = idNum;
      existingUrls.add(parts[1].trim());
    }
  }

  let addedCount = 0;
  for (const role of pendingRoles) {
    if (existingUrls.has(role.url)) continue;
    maxId++;
    const row = `${maxId}\t${role.url}\t${role.source || 'pipeline'}\t${(role.title || '').replace(/\t/g, ' ')}`;
    existingLines.push(row);
    existingUrls.add(role.url);
    addedCount++;
  }

  writeFileSync(inputTsvPath, existingLines.join('\n') + '\n', 'utf-8');
  return { addedCount, totalOffers: existingLines.length - 1 };
}

// ── Supported ATS Detection & Prefill Helper ─────────────────────────

export function isSupportedAtsUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const allowed = [
      'boards.greenhouse.io',
      'greenhouse.io',
      'jobs.ashbyhq.com',
      'ashbyhq.com',
      'jobs.lever.co',
      'jobs.eu.lever.co',
      'lever.co',
    ];
    return allowed.includes(host);
  } catch {
    return false;
  }
}

// ── Review Package Generator ─────────────────────────────────────────

export function preparePassedReviewPackages(opts, stateRows) {
  const packagesDir = path.join(opts.reportsDir, 'packages');
  mkdirSync(packagesDir, { recursive: true });
  mkdirSync(opts.outputDir, { recursive: true });

  let draftReadyCount = 0;
  let missingArtifactCount = 0;
  let urgentDeadlineCount = 0;

  for (const row of stateRows) {
    if (row.status !== 'completed' && row.status !== 'passed') continue;

    const reportNum = row.report_num;
    let reportFile = null;

    if (existsSync(opts.reportsDir)) {
      const files = readdirSync(opts.reportsDir);
      const match = files.find(f => f.startsWith(`${reportNum}-`) && f.endsWith('.md'));
      if (match) reportFile = path.join(opts.reportsDir, match);
    }

    const missingArtifacts = [];
    if (!reportFile || !existsSync(reportFile)) {
      missingArtifacts.push('report');
    }

    // Check PDF, cover letter, answers
    let pdfFile = null;
    let coverFile = null;
    let answersFile = null;

    if (existsSync(opts.outputDir)) {
      const outFiles = readdirSync(opts.outputDir);
      const pdfMatch = outFiles.find(f => f.endsWith('.pdf') && (f.includes(row.id) || f.includes(reportNum)));
      if (pdfMatch) pdfFile = path.join(opts.outputDir, pdfMatch);

      const coverMatch = outFiles.find(f => (f.endsWith('.txt') || f.endsWith('.cover.txt')) && (f.includes(row.id) || f.includes(reportNum)));
      if (coverMatch) coverFile = path.join(opts.outputDir, coverMatch);

      const answersMatch = outFiles.find(f => f.endsWith('.md') && f.includes('answers') && (f.includes(row.id) || f.includes(reportNum)));
      if (answersMatch) answersFile = path.join(opts.outputDir, answersMatch);
    }

    // If PDF or cover not found specifically by ID, fall back to any recently created in output/ if available
    if (!pdfFile && existsSync(opts.outputDir)) {
      const anyPdf = readdirSync(opts.outputDir).find(f => f.endsWith('.pdf'));
      if (anyPdf) pdfFile = path.join(opts.outputDir, anyPdf);
    }

    if (!pdfFile) {
      missingArtifacts.push('pdf');
    }

    // Check ATS prefill support
    let atsPrefillOutput = null;
    if (isSupportedAtsUrl(row.url) && pdfFile) {
      const prepareCmd = opts.prepareCmd || `node ${path.join(ROOT_DIR, 'prepare-application.mjs')}`;
      try {
        const fullCmd = `${prepareCmd} --url "${row.url}" --pdf "${path.relative(ROOT_DIR, pdfFile)}"`;
        const res = execSync(fullCmd, { cwd: ROOT_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        atsPrefillOutput = res.trim();
      } catch (err) {
        atsPrefillOutput = `Error running ATS prefill: ${err.message}`;
      }
    }

    // Check deadline / urgent liveness
    let isUrgent = false;
    if (reportFile && existsSync(reportFile)) {
      const content = readFileSync(reportFile, 'utf-8');
      if (content.toLowerCase().includes('urgent') || content.toLowerCase().includes('deadline')) {
        isUrgent = true;
      }
    }
    if (isUrgent) urgentDeadlineCount++;

    if (missingArtifacts.length > 0) {
      missingArtifactCount++;
    } else {
      draftReadyCount++;
    }

    const packageManifest = {
      role_id: row.id,
      url: row.url,
      report_num: reportNum,
      score: row.score,
      status: 'Passed',
      report_file: reportFile ? path.relative(ROOT_DIR, reportFile) : null,
      pdf_file: pdfFile ? path.relative(ROOT_DIR, pdfFile) : null,
      cover_letter_file: coverFile ? path.relative(ROOT_DIR, coverFile) : null,
      answers_file: answersFile ? path.relative(ROOT_DIR, answersFile) : null,
      ats_prefill: atsPrefillOutput,
      missing_artifacts: missingArtifacts,
      urgent_deadline: isUrgent,
      prepared_at: new Date().toISOString(),
    };

    const manifestPath = path.join(packagesDir, `package-${row.id}.json`);
    writeFileSync(manifestPath, JSON.stringify(packageManifest, null, 2), 'utf-8');
  }

  return { draftReadyCount, missingArtifactCount, urgentDeadlineCount };
}

// ── State Parsing Helpers ────────────────────────────────────────────

export function parseBatchStateRows(stateFilePath) {
  if (!existsSync(stateFilePath)) return [];
  const content = readFileSync(stateFilePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length >= 3) {
      rows.push({
        id: parts[0],
        url: parts[1],
        status: parts[2],
        started_at: parts[3] || null,
        completed_at: parts[4] || null,
        report_num: parts[5] || null,
        score: parts[6] || null,
        error: parts[7] || null,
        retries: parts[8] || '0',
      });
    }
  }
  return rows;
}

// ── Main Orchestration ───────────────────────────────────────────────

export async function runOvernightWorkflow(opts = parseArgs()) {
  const startedAt = new Date().toISOString();
  const runId = `run-${startedAt.replace(/[-:]/g, '').replace(/\..+/, '')}`;
  const releaseLock = acquireLock(opts.batchDir);

  const errors = [];
  let discovered = 0;
  let autoFiltered = 0;
  let eligible = 0;
  let evaluated = 0;
  let passed = 0;
  let failed = 0;
  let paused = 0;
  let draftReady = 0;
  let missingArtifact = 0;
  let urgentDeadline = 0;
  let resumeAt = null;
  const idempotencyKeys = [];

  try {
    // 1. Run Portal Scan (Public sources only)
    if (opts.scanCmd) {
      try {
        execSync(opts.scanCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
      } catch (err) {
        errors.push(`Scan execution failed: ${err.message}`);
      }
    } else {
      const scanScript = path.join(ROOT_DIR, 'scan.mjs');
      if (existsSync(scanScript)) {
        try {
          const scanCmd = `node "${scanScript}"${opts.dryRun ? ' --dry-run' : ''}`;
          execSync(scanCmd, { cwd: ROOT_DIR, stdio: 'pipe' });
        } catch (err) {
          errors.push(`Portal scan error: ${err.message}`);
        }
      }
    }

    // 2. Run Pre-batch Deduplication
    const dedupScript = path.join(ROOT_DIR, 'dedup-tracker.mjs');
    if (existsSync(dedupScript)) {
      try {
        execSync(`node "${dedupScript}" --dry-run`, { cwd: ROOT_DIR, stdio: 'pipe' });
      } catch (err) {
        errors.push(`Dedup check error: ${err.message}`);
      }
    }

    // 3. Extract pending roles from pipeline.md & convert to batch-input.tsv
    let pendingRoles = [];
    if (existsSync(opts.pipelineFile)) {
      const pipelineContent = readFileSync(opts.pipelineFile, 'utf-8');
      pendingRoles = parsePipelinePendingRoles(pipelineContent);
    }
    discovered = pendingRoles.length;
    eligible = pendingRoles.length;

    const inputTsvPath = path.join(opts.batchDir, 'batch-input.tsv');
    const { totalOffers } = convertPendingRolesToBatchInput(inputTsvPath, pendingRoles);

    // Collect idempotency keys
    for (const role of pendingRoles) {
      idempotencyKeys.push(`role-${role.url}`);
    }

    // 4. Run Batch Runner
    const runnerCmd = opts.runnerCmd || `${path.join(opts.batchDir, 'batch-runner.sh')} --cli agy --parallel 2 --limit 0 --rate-limit-sleep 0 --resume-paused`;
    const finalRunnerCmd = opts.dryRun ? `${runnerCmd} --dry-run` : runnerCmd;

    try {
      execSync(finalRunnerCmd, { cwd: ROOT_DIR, stdio: 'inherit' });
    } catch (err) {
      // Runner might exit non-zero on rate limit or failures, which is captured in state
      if (!err.message.includes('paused') && !err.message.includes('rate limit')) {
        errors.push(`Batch runner warning/failure: ${err.message}`);
      }
    }

    // 5. Post-evaluation Reconcile and Verification
    const reconcileScript = path.join(ROOT_DIR, 'reconcile-pipeline.mjs');
    if (existsSync(reconcileScript)) {
      try {
        execSync(`node "${reconcileScript}" --state "${opts.stateFile}" --pipeline "${opts.pipelineFile}"`, { cwd: ROOT_DIR, stdio: 'pipe' });
      } catch (err) {
        errors.push(`Pipeline reconcile error: ${err.message}`);
      }
    }

    const verifyScript = path.join(ROOT_DIR, 'verify-pipeline.mjs');
    if (existsSync(verifyScript)) {
      try {
        execSync(`node "${verifyScript}"`, { cwd: ROOT_DIR, stdio: 'pipe' });
      } catch (err) {
        errors.push(`Pipeline verification warning: ${err.message}`);
      }
    }

    // 6. Inspect batch-state.tsv for metrics & paused status
    const stateRows = parseBatchStateRows(opts.stateFile);
    for (const row of stateRows) {
      if (row.status === 'completed') {
        evaluated++;
        const scoreNum = parseFloat(row.score);
        if (!isNaN(scoreNum) && scoreNum >= 3.5) {
          passed++;
        }
      } else if (row.status === 'skipped') {
        autoFiltered++;
      } else if (row.status === 'failed') {
        evaluated++;
        failed++;
      } else if (row.status === 'paused_rate_limit' || row.status === 'rate_limited') {
        paused++;
      }
    }

    // Check for pause reset timestamp if paused > 0
    if (paused > 0) {
      let pauseLogContent = '';
      const pauseFile = path.join(opts.batchDir, 'batch-runner.paused');
      if (existsSync(pauseFile)) {
        pauseLogContent += readFileSync(pauseFile, 'utf-8') + '\n';
      }

      const logsDir = path.join(opts.batchDir, 'logs');
      if (existsSync(logsDir)) {
        const logFiles = readdirSync(logsDir);
        for (const lf of logFiles.slice(-5)) {
          try {
            pauseLogContent += readFileSync(path.join(logsDir, lf), 'utf-8') + '\n';
          } catch {}
        }
      }

      const parsedReset = parseResetTimestamp(pauseLogContent);
      if (parsedReset) {
        resumeAt = parsedReset;
      } else {
        resumeAt = getNextPhoenix1AM();
      }
    }

    // 7. Prepare Passed Review Packages
    const packageMetrics = preparePassedReviewPackages(opts, stateRows);
    draftReady = packageMetrics.draftReadyCount;
    missingArtifact = packageMetrics.missingArtifactCount;
    urgentDeadline = packageMetrics.urgentDeadlineCount;

  } finally {
    releaseLock();
  }

  const completedAt = new Date().toISOString();
  const summary = {
    run_id: runId,
    started_at: startedAt,
    completed_at: completedAt,
    discovered,
    auto_filtered: autoFiltered,
    eligible,
    evaluated,
    passed,
    failed,
    paused,
    draft_ready: draftReady,
    missing_artifact: missingArtifact,
    urgent_deadline: urgentDeadline,
    idempotency_keys: idempotencyKeys,
    resume_at: resumeAt,
    errors,
  };

  // Persist checkpoint JSON
  mkdirSync(path.dirname(opts.checkpointFile), { recursive: true });
  writeFileSync(opts.checkpointFile, JSON.stringify(summary, null, 2), 'utf-8');

  // Output
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`=== Overnight Workflow Summary (${summary.run_id}) ===`);
    console.log(`Status: ${summary.errors.length > 0 ? 'Completed with warnings' : 'Completed'}`);
    console.log(`Discovered: ${summary.discovered} | Eligible: ${summary.eligible} | Evaluated: ${summary.evaluated}`);
    console.log(`Passed: ${summary.passed} | Failed: ${summary.failed} | Paused: ${summary.paused}`);
    console.log(`Draft Ready: ${summary.draft_ready} | Missing Artifacts: ${summary.missing_artifact} | Urgent Deadlines: ${summary.urgent_deadline}`);
    if (summary.resume_at) {
      console.log(`Resume At: ${summary.resume_at}`);
    }
    if (summary.errors.length > 0) {
      console.log(`Errors/Warnings (${summary.errors.length}):`);
      for (const err of summary.errors) {
        console.log(`  - ${err}`);
      }
    }
  }

  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runOvernightWorkflow().catch((err) => {
    console.error('Fatal overnight-workflow error:', err.message);
    process.exit(1);
  });
}
