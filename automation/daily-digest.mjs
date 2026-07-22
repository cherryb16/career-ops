#!/usr/bin/env node

/**
 * automation/daily-digest.mjs
 *
 * 7:00 AM daily digest report entrypoint.
 * Consumes persisted structured state and emits pipeline status summary.
 * If the overnight batch is still running (lock file active), includes in-progress checkpoint.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    json: args.includes('--json'),
    dataDir: process.env.CAREER_OPS_DATA || path.join(ROOT_DIR, 'data'),
    batchDir: process.env.CAREER_OPS_BATCH || path.join(ROOT_DIR, 'batch'),
    reportsDir: process.env.CAREER_OPS_REPORTS || path.join(ROOT_DIR, 'reports'),
    checkpointFile: process.env.CAREER_OPS_CHECKPOINT || null,
    stateFile: process.env.CAREER_OPS_STATE || null,
  };

  if (!opts.checkpointFile) opts.checkpointFile = path.join(opts.dataDir, '.overnight-checkpoint.json');
  if (!opts.stateFile) opts.stateFile = path.join(opts.batchDir, 'batch-state.tsv');

  return opts;
}

export function generateDailyDigest(opts = parseArgs()) {
  const lockFile = path.join(opts.batchDir, '.overnight-workflow.lock');
  const isInProgress = existsSync(lockFile);

  let checkpoint = null;
  if (existsSync(opts.checkpointFile)) {
    try {
      checkpoint = JSON.parse(readFileSync(opts.checkpointFile, 'utf-8'));
    } catch {}
  }

  let totalCompleted = 0;
  let totalPaused = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  if (existsSync(opts.stateFile)) {
    const lines = readFileSync(opts.stateFile, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      const status = parts[2];
      if (status === 'completed') totalCompleted++;
      else if (status === 'paused_rate_limit' || status === 'rate_limited') totalPaused++;
      else if (status === 'failed') totalFailed++;
      else if (status === 'skipped') totalSkipped++;
    }
  }

  const digest = {
    timestamp: new Date().toISOString(),
    in_progress: isInProgress,
    run_id: checkpoint ? checkpoint.run_id : null,
    last_run_completed_at: checkpoint ? checkpoint.completed_at : null,
    metrics: {
      discovered: checkpoint ? checkpoint.discovered : 0,
      eligible: checkpoint ? checkpoint.eligible : 0,
      evaluated: totalCompleted + totalFailed,
      passed: checkpoint ? checkpoint.passed : 0,
      failed: totalFailed,
      paused: totalPaused,
      draft_ready: checkpoint ? checkpoint.draft_ready : 0,
      missing_artifact: checkpoint ? checkpoint.missing_artifact : 0,
      urgent_deadline: checkpoint ? checkpoint.urgent_deadline : 0,
    },
    resume_at: checkpoint ? checkpoint.resume_at : null,
  };

  if (opts.json) {
    console.log(JSON.stringify(digest, null, 2));
  } else {
    console.log(`=== Career-Ops Daily Digest (7:00 AM) ===`);
    console.log(`Status: ${isInProgress ? 'IN-PROGRESS (Overnight scan active)' : 'COMPLETED'}`);
    if (digest.run_id) console.log(`Run ID: ${digest.run_id}`);
    console.log(`Evaluated: ${digest.metrics.evaluated} | Passed: ${digest.metrics.passed} | Paused: ${digest.metrics.paused}`);
    console.log(`Draft Ready: ${digest.metrics.draft_ready} | Urgent Deadlines: ${digest.metrics.urgent_deadline}`);
    if (digest.resume_at) console.log(`Resume At: ${digest.resume_at}`);
  }

  return digest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateDailyDigest();
}
