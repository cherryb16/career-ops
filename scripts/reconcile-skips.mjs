#!/usr/bin/env node
// Move report-less batch skips from Pending to Processed in data/pipeline.md.
//
// reconcile-pipeline.mjs (upstream) moves a finished posting only when it has a
// report, or when the runner skipped it on a `dealbreaker:` rule. This fork's
// batch runner adds two more zero-report skips, the seniority gate and the
// triage pass, recorded in batch-state.tsv as `seniority-gate: ...` and
// `triage: ...`. reconcile leaves those in Pending forever, so Pending fills with
// postings that will never be evaluated, and the nightly liveness sweep times
// out re-checking all of them. This moves them the way reconcile moves a
// dealbreaker skip, keeping the reason in a trailing `note:` column:
//
//   - [x] SKIP | <url> | <company> | <role> | N/A | PDF ❌ | note: <reason>
//
// Idempotent; holds the same pipeline lock as scan.mjs and reconcile-pipeline.
// Usage: node scripts/reconcile-skips.mjs [--dry-run] [--json]
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJobKey } from '../url-key.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIPELINE = join(ROOT, 'data', 'pipeline.md');
const STATE = join(ROOT, 'batch', 'batch-state.tsv');
const DRY = process.argv.includes('--dry-run');
const JSON_OUT = process.argv.includes('--json');
const REASON = /^(seniority-gate|triage):/;
const key = (u) => canonicalJobKey(u) || u;
const firstUrl = (s) => (s.match(/https?:\/\/[^\s|)\]>]+/) || [])[0] || '';
const clean = (s) => String(s || '').replace(/[|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();

// Latest state row per posting wins (a re-run can turn a skip into a completion).
const skips = new Map();
for (const l of existsSync(STATE) ? readFileSync(STATE, 'utf8').split('\n') : []) {
  const f = l.split('\t');
  if (f.length < 9 || !/^\d+$/.test(f[0]) || !/^https?:/.test(f[1])) continue;
  const k = key(f[1]);
  if (f[2] === 'skipped' && REASON.test(f[7] || '')) skips.set(k, f[7]);
  else skips.delete(k);
}

const result = { moved: 0, pendingBefore: 0, pendingAfter: 0, dryRun: DRY };
await withPipelineLock(PIPELINE, async () => {
  const lines = readFileSync(PIPELINE, 'utf8').split('\n');
  const isPend = (l) => /^##\s+(Pending|Pendientes)\b/i.test(l);
  const isProc = (l) => /^##\s+(Processed|Procesadas)\b/i.test(l);
  const pendStart = lines.findIndex(isPend);
  if (pendStart < 0) return;
  let pendEnd = lines.findIndex((l, i) => i > pendStart && /^##\s/.test(l));
  if (pendEnd < 0) pendEnd = lines.length;

  const processedKeys = new Set();
  let inProc = false;
  for (const l of lines) {
    if (/^##\s/.test(l)) inProc = isProc(l);
    else if (inProc) { const u = firstUrl(l); if (u) processedKeys.add(key(u)); }
  }

  const remove = new Set();
  const add = [];
  for (let i = pendStart + 1; i < pendEnd; i++) {
    if (!/^- \[ \] /.test(lines[i])) continue;
    result.pendingBefore += 1;
    const body = lines[i].replace(/^- \[ \] /, '');
    const url = firstUrl(body);
    const reason = url && skips.get(key(url));
    if (!reason) continue;
    remove.add(i);
    if (processedKeys.has(key(url))) continue; // already recorded; just drop the stale Pending copy
    const [, company = '', role = ''] = body.split('|').map((s) => s.trim());
    add.push(`- [x] SKIP | ${url} | ${clean(company)} | ${clean(role)} | N/A | PDF ❌ | note: ${clean(reason).slice(0, 180)}`);
    processedKeys.add(key(url));
  }
  result.moved = remove.size;
  result.pendingAfter = result.pendingBefore - remove.size;
  if (DRY || remove.size === 0) return;

  const out = [];
  const procStart = lines.findIndex(isProc);
  for (let i = 0; i < lines.length; i++) {
    if (remove.has(i)) continue;
    out.push(lines[i]);
    if (i === procStart && add.length) out.push('', ...add);
  }
  if (procStart < 0 && add.length) out.push('', '## Processed', '', ...add);
  writeFileSync(PIPELINE + '.tmp', out.join('\n'));
  renameSync(PIPELINE + '.tmp', PIPELINE);
});

if (JSON_OUT) console.log(JSON.stringify(result));
else console.log(`reconcile-skips${DRY ? ' (dry run)' : ''}: ${result.moved} triage/seniority skips moved Pending → Processed · Pending ${result.pendingBefore} → ${result.pendingAfter}`);
