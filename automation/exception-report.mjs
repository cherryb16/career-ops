#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clean = (value) => String(value).replace(/https?:\/\/\S+/gi, '[url]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/\s+/g, ' ').slice(0, 180);

export function generateExceptionReport(input = {}) {
  const dataDir = input.dataDir || process.env.CAREER_OPS_DATA || path.join(ROOT, 'data');
  const file = input.checkpointFile || process.env.CAREER_OPS_CHECKPOINT || path.join(dataDir, '.overnight-checkpoint.json');
  let checkpoint = null;
  if (existsSync(file)) {
    try { const value = JSON.parse(readFileSync(file, 'utf8')); checkpoint = value.current || value; } catch { /* silent */ }
  }
  const exceptions = [];
  for (const message of (checkpoint?.errors || []).slice(0, 20)) {
    const type = /scan failure/i.test(message) ? 'scan_failure' : /(?:runner failure|provider failure)/i.test(message) ? 'provider_failure' : 'workflow_error';
    exceptions.push({ type, message: clean(message) });
  }
  if (Number(checkpoint?.urgent_deadline || 0) > 0) exceptions.push({ type: 'urgent_deadline', count: Number(checkpoint.urgent_deadline) });
  if (!exceptions.length) return null;
  const report = { timestamp: new Date().toISOString(), generation_id: checkpoint?.generation_id || null, exceptions: exceptions.slice(0, 20) };
  if (input.json) console.log(JSON.stringify(report));
  else for (const item of report.exceptions) console.log(`${item.type}: ${item.message || item.count}`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  generateExceptionReport({ json: process.argv.includes('--json') });
}
