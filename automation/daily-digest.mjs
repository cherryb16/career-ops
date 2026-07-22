#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveLock } from './overnight-workflow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function options(input = {}) {
  const dataDir = input.dataDir || process.env.CAREER_OPS_DATA || path.join(ROOT, 'data');
  const batchDir = input.batchDir || process.env.CAREER_OPS_BATCH || path.join(ROOT, 'batch');
  return {
    json: Boolean(input.json), batchDir,
    checkpointFile: input.checkpointFile || process.env.CAREER_OPS_CHECKPOINT || path.join(dataDir, '.overnight-checkpoint.json'),
    lockFile: input.lockFile || path.join(batchDir, '.overnight-workflow.lock'),
  };
}

function currentCheckpoint(file) {
  if (!existsSync(file)) return null;
  try { const value = JSON.parse(readFileSync(file, 'utf8')); return value.current || value; } catch { return null; }
}

export function generateDailyDigest(input = {}) {
  const opts = options(input);
  const checkpoint = currentCheckpoint(opts.checkpointFile);
  const lock = readActiveLock(opts.lockFile);
  const metrics = checkpoint ? Object.fromEntries([
    'discovered', 'auto_filtered', 'eligible', 'evaluated', 'passed', 'failed', 'paused',
    'draft_ready', 'missing_artifact', 'urgent_deadline', 'authenticated_blockers',
  ].map((key) => [key, Number(checkpoint[key] || 0)])) : {};
  const digest = {
    timestamp: new Date().toISOString(), in_progress: Boolean(lock),
    generation_id: checkpoint?.generation_id || null,
    checkpoint_started_at: checkpoint?.started_at || lock?.started_at || null,
    last_run_completed_at: checkpoint?.completed_at || null,
    metrics, resume_at: checkpoint?.resume_at || null,
  };
  if (opts.json) console.log(JSON.stringify(digest));
  else {
    console.log(`Career-Ops daily digest: ${digest.in_progress ? 'in progress' : 'complete'}.`);
    console.log(`${metrics.evaluated || 0} evaluated; ${metrics.passed || 0} passed; ${metrics.draft_ready || 0} draft-ready; ${metrics.paused || 0} paused.`);
    if (digest.resume_at) console.log(`Resume at ${digest.resume_at}.`);
  }
  return digest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateDailyDigest({ json: process.argv.includes('--json') });
}
