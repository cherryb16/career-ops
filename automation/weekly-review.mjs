#!/usr/bin/env node

/**
 * automation/weekly-review.mjs
 *
 * Sunday 1:00 PM full pipeline review entrypoint.
 * Aggregates weekly run checkpoints, pipeline metrics, and review packages.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
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

export function generateWeeklyReview(opts = parseArgs()) {
  let checkpoint = null;
  if (existsSync(opts.checkpointFile)) {
    try {
      checkpoint = JSON.parse(readFileSync(opts.checkpointFile, 'utf-8'));
    } catch {}
  }

  let completedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let pausedCount = 0;
  let totalScore = 0;
  let scoreCount = 0;

  if (existsSync(opts.stateFile)) {
    const lines = readFileSync(opts.stateFile, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      const status = parts[2];
      const scoreStr = parts[6];
      if (status === 'completed') {
        completedCount++;
        const s = parseFloat(scoreStr);
        if (!isNaN(s)) {
          totalScore += s;
          scoreCount++;
        }
      } else if (status === 'skipped') skippedCount++;
      else if (status === 'failed') failedCount++;
      else if (status === 'paused_rate_limit' || status === 'rate_limited') pausedCount++;
    }
  }

  const packagesDir = path.join(opts.reportsDir, 'packages');
  let readyPackages = 0;
  if (existsSync(packagesDir)) {
    readyPackages = readdirSync(packagesDir).filter(f => f.endsWith('.json')).length;
  }

  const avgScore = scoreCount > 0 ? (totalScore / scoreCount).toFixed(2) : null;

  const review = {
    timestamp: new Date().toISOString(),
    period: 'Sunday 1:00 PM Full Pipeline Review',
    summary: {
      total_evaluated: completedCount + failedCount,
      completed: completedCount,
      skipped: skippedCount,
      failed: failedCount,
      paused: pausedCount,
      average_score: avgScore ? parseFloat(avgScore) : null,
      draft_packages_ready: readyPackages,
      urgent_deadlines: checkpoint ? checkpoint.urgent_deadline : 0,
    },
    latest_checkpoint: checkpoint,
  };

  if (opts.json) {
    console.log(JSON.stringify(review, null, 2));
  } else {
    console.log(`=== Career-Ops Sunday Weekly Pipeline Review (1:00 PM) ===`);
    console.log(`Evaluated: ${review.summary.total_evaluated} | Completed: ${review.summary.completed} | Skipped: ${review.summary.skipped}`);
    console.log(`Avg Score: ${review.summary.average_score ? review.summary.average_score + '/5' : 'N/A'}`);
    console.log(`Packages Ready for Human Review: ${review.summary.draft_packages_ready}`);
    console.log(`Urgent Deadlines: ${review.summary.urgent_deadlines}`);
  }

  return review;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateWeeklyReview();
}
