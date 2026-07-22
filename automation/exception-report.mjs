#!/usr/bin/env node

/**
 * automation/exception-report.mjs
 *
 * Immediate exception output for scan failure, unrecoverable provider failure, and urgent deadline.
 * Note: Empty/non-material exception output is completely silent for no-agent cron use.
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
    checkpointFile: process.env.CAREER_OPS_CHECKPOINT || null,
  };

  if (!opts.checkpointFile) opts.checkpointFile = path.join(opts.dataDir, '.overnight-checkpoint.json');

  return opts;
}

export function generateExceptionReport(opts = parseArgs()) {
  const exceptions = [];

  if (existsSync(opts.checkpointFile)) {
    try {
      const checkpoint = JSON.parse(readFileSync(opts.checkpointFile, 'utf-8'));
      if (checkpoint.errors && checkpoint.errors.length > 0) {
        for (const err of checkpoint.errors) {
          exceptions.push({ type: 'workflow_error', message: err });
        }
      }
      if (checkpoint.urgent_deadline > 0) {
        exceptions.push({
          type: 'urgent_deadline',
          message: `${checkpoint.urgent_deadline} role(s) have urgent deadlines (<= 48h)`,
        });
      }
    } catch {}
  }

  // Check for discard log errors or unrecoverable failures
  const discardLog = path.join(opts.batchDir, 'logs', 'discard.log');
  if (existsSync(discardLog)) {
    try {
      const lines = readFileSync(discardLog, 'utf-8').split(/\r?\n/).filter(Boolean);
      const recent = lines.slice(-5);
      for (const line of recent) {
        if (line.toLowerCase().includes('unrecoverable') || line.toLowerCase().includes('fatal')) {
          exceptions.push({ type: 'provider_failure', message: line });
        }
      }
    } catch {}
  }

  // If no material exceptions exist, be completely silent
  if (exceptions.length === 0) {
    return null;
  }

  const report = {
    timestamp: new Date().toISOString(),
    has_exceptions: true,
    count: exceptions.length,
    exceptions,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Career-Ops Exception Report ===`);
    for (const ex of exceptions) {
      console.log(`[${ex.type.toUpperCase()}] ${ex.message}`);
    }
  }

  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateExceptionReport();
}
