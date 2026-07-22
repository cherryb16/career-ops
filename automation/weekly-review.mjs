#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function completeManifest(file, generationIds) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const a = value.artifacts || {};
    return generationIds.has(value.generation_id) && value.status === 'Passed' && value.draft_ready === true && value.liveness === 'active'
      && ['report', 'tailored_pdf', 'cover_letter', 'application_answers', 'ats_prefill'].every((key) => Boolean(a[key]))
      && Array.isArray(value.missing) && value.missing.length === 0
      && Array.isArray(value.errors) && value.errors.length === 0;
  } catch { return false; }
}

export function generateWeeklyReview(input = {}) {
  const now = input.now || new Date();
  const dataDir = input.dataDir || process.env.CAREER_OPS_DATA || path.join(ROOT, 'data');
  const reportsDir = input.reportsDir || process.env.CAREER_OPS_REPORTS || path.join(ROOT, 'reports');
  const checkpointFile = input.checkpointFile || process.env.CAREER_OPS_CHECKPOINT || path.join(dataDir, '.overnight-checkpoint.json');
  let runs = [];
  if (existsSync(checkpointFile)) {
    try { const value = JSON.parse(readFileSync(checkpointFile, 'utf8')); runs = value.runs || [value]; } catch { /* empty */ }
  }
  const cutoff = now.getTime() - 7 * 86_400_000;
  const weekly = runs.filter((run) => {
    const at = new Date(run.completed_at || run.started_at || 0).getTime();
    return Number.isFinite(at) && at >= cutoff && at <= now.getTime();
  });
  const unique = [...new Map(weekly.map((run) => [run.generation_id || run.run_id, run])).values()];
  const generationIds = new Set(unique.map((run) => run.generation_id).filter(Boolean));
  const sum = (key) => unique.reduce((total, run) => total + Number(run[key] || 0), 0);
  const packagesDir = path.join(reportsDir, 'packages');
  const ready = existsSync(packagesDir)
    ? readdirSync(packagesDir).filter((name) => name.endsWith('.json')).filter((name) => completeManifest(path.join(packagesDir, name), generationIds)).length : 0;
  const review = {
    timestamp: now.toISOString(), period_start: new Date(cutoff).toISOString(), period_end: now.toISOString(),
    generations: unique.length,
    summary: {
      discovered: sum('discovered'), auto_filtered: sum('auto_filtered'), eligible: sum('eligible'),
      evaluated: sum('evaluated'), passed: sum('passed'), failed: sum('failed'), paused: sum('paused'),
      draft_packages_ready: ready, missing_artifact: sum('missing_artifact'), urgent_deadlines: sum('urgent_deadline'),
    },
  };
  if (input.json) console.log(JSON.stringify(review));
  else {
    console.log(`Career-Ops seven-day review: ${review.summary.evaluated} evaluated; ${review.summary.passed} passed.`);
    console.log(`${ready} complete review package(s); ${review.summary.missing_artifact} missing-artifact role(s).`);
  }
  return review;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateWeeklyReview({ json: process.argv.includes('--json') });
}
