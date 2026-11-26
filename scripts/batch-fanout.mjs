#!/usr/bin/env node
// Multi-model batch evaluation: one worker per route in config/batch-routes.json,
// all pulling small chunks of batch/batch-input.tsv from a shared queue, each
// chunk run through batch/batch-runner.sh (no --limit). Faster routes take more
// chunks. A route whose chunks keep producing no terminal rows is retired and
// its unprocessed offers go back on the queue. After all workers finish, repair
// mechanical worker defects: literal "\t" tracker files and completed state rows
// missing a score (backfilled only from the report's **Score:** header when the
// report URL matches the posting URL).
//
// Usage: node scripts/batch-fanout.mjs [--json] [--dry-run] [--routes FILE]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = join(ROOT, 'batch');
const STATE = join(BATCH, 'batch-state.tsv');
const INPUT = join(BATCH, 'batch-input.tsv');
const WORK = join(BATCH, 'fanout');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const cfg = JSON.parse(readFileSync(opt('--routes', join(ROOT, 'config', 'batch-routes.json')), 'utf8'));
const routes = cfg.routes.filter((r) => r.enabled !== false);
const CHUNK = cfg.chunk_size ?? 6;
const deadline = Date.now() + (cfg.deadline_minutes ?? 540) * 60_000;
const RETIRE = cfg.retire_after_dead_chunks ?? 2;
const TERMINAL = new Set(['completed', 'skipped', 'failed']);

function readState() {
  const m = new Map();
  if (!existsSync(STATE)) return m;
  for (const l of readFileSync(STATE, 'utf8').split('\n').slice(1)) {
    const f = l.split('\t');
    if (f.length >= 9 && /^\d+$/.test(f[0])) m.set(f[0], f);
  }
  return m;
}

const inputLines = existsSync(INPUT) ? readFileSync(INPUT, 'utf8').split('\n') : [];
const header = inputLines[0] || 'id\turl\tsource\tnotes';
const startState = readState();
const rows = inputLines.slice(1).filter((l) => /^\d+\t/.test(l))
  .filter((l) => !TERMINAL.has(startState.get(l.split('\t')[0])?.[2]));
const queue = [];
for (let i = 0; i < rows.length; i += CHUNK) queue.push(rows.slice(i, i + CHUNK));

const log = (s) => { if (!flag('--json')) process.stdout.write(s + '\n'); };
log(`fanout: ${rows.length} offers · ${queue.length} chunks of ${CHUNK} · routes: ${routes.map((r) => r.name).join(', ')}`);
if (flag('--dry-run') || rows.length === 0) {
  const out = { offers: rows.length, chunks: queue.length, routes: routes.map((r) => r.name), dryRun: flag('--dry-run') };
  if (flag('--json')) console.log(JSON.stringify(out)); else log(JSON.stringify(out));
  process.exit(0);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

function runChunk(route, chunk, n) {
  const file = join(WORK, `${route.name}-${n}.tsv`);
  writeFileSync(file, [header, ...chunk].join('\n') + '\n');
  const a = ['--cli', route.cli, '--parallel', String(route.parallel ?? 1)];
  if (cfg.skip_pdf !== false) a.push('--skip-pdf'); // CV/PDF generation is off for batch runs unless skip_pdf: false
  if (route.provider) a.push('--provider', route.provider);
  if (route.model) a.push('--model', route.model);
  return new Promise((resolve) => {
    const p = spawn('./batch/batch-runner.sh', a, {
      cwd: ROOT,
      env: { ...process.env, BATCH_INPUT_FILE: file, BATCH_LOCK_FILE: join(WORK, `${route.name}.pid`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => { writeFileSync(join(WORK, `${route.name}-${n}.log`), out); resolve(code); });
  });
}

const tries = new Map(); // offer id -> times handed out; cap requeues so a stuck offer can't loop forever
const requeue = (lines) => {
  const keep = lines.filter((l) => { const id = l.split('\t')[0]; const t = (tries.get(id) ?? 1) + 1; tries.set(id, t); return t <= 3; });
  if (keep.length) queue.push(keep);
};
const stats = Object.fromEntries(routes.map((r) => [r.name, { chunks: 0, completed: 0, skipped: 0, failed: 0, other: 0, retired: false }]));
async function worker(route) {
  const s = stats[route.name];
  let dead = 0;
  while (queue.length && Date.now() < deadline) {
    const chunk = queue.shift();
    s.chunks += 1;
    await runChunk(route, chunk, s.chunks);
    const st = readState();
    let terminal = 0;
    const leftover = [];
    for (const l of chunk) {
      const status = st.get(l.split('\t')[0])?.[2] ?? 'pending';
      if (TERMINAL.has(status)) { terminal += 1; s[status] += 1; } else { s.other += 1; leftover.push(l); }
    }
    log(`  [${route.name}] chunk ${s.chunks}: ${terminal}/${chunk.length} done · queue ${queue.length}`);
    if (terminal === 0) {
      dead += 1;
      requeue(leftover); // give it to another route
      if (dead >= RETIRE) { s.retired = true; log(`  [${route.name}] retired after ${dead} dead chunks`); return; }
    } else {
      dead = 0;
      requeue(leftover);
    }
  }
}

await Promise.all(routes.map(worker));
const unprocessed = queue.reduce((n, c) => n + c.length, 0);

// --- post-run repairs (all runners stopped, so the state file is quiescent) ---
const repairs = { trackerFiles: 0, scoresBackfilled: 0 };
const TA = join(BATCH, 'tracker-additions');
const TA_HEADER = 'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl';
for (const f of existsSync(TA) ? readdirSync(TA).filter((x) => x.endsWith('.tsv')) : []) {
  const p = join(TA, f);
  const raw = readFileSync(p, 'utf8');
  if (raw.includes('\t') || !raw.includes('\\t')) continue;
  const lines = raw.replace(/\\t/g, '\t').replace(/\\n/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines[0].startsWith('num\t')) lines.unshift(TA_HEADER);
  writeFileSync(p, lines.join('\n') + '\n');
  repairs.trackerFiles += 1;
}
const reports = existsSync(join(ROOT, 'reports')) ? readdirSync(join(ROOT, 'reports')) : [];
const stateText = existsSync(STATE) ? readFileSync(STATE, 'utf8').split('\n') : [];
const fixed = stateText.map((l) => {
  const f = l.split('\t');
  if (f.length < 9 || f[2] !== 'completed' || (f[6] && f[6] !== '-') || !/^\d+$/.test(f[5])) return l;
  const rep = reports.find((r) => r.startsWith(`${f[5]}-`) && r.endsWith('.md'));
  if (!rep) return l;
  const head = readFileSync(join(ROOT, 'reports', rep), 'utf8').slice(0, 5000);
  const score = head.match(/\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/)?.[1];
  const url = head.match(/\*\*URL:\*\*\s*<?(\S+?)>?\s*$/m)?.[1];
  if (!score || url !== f[1]) return l;
  f[6] = score;
  repairs.scoresBackfilled += 1;
  return f.join('\t');
});
if (repairs.scoresBackfilled) { writeFileSync(STATE + '.tmp', fixed.join('\n')); renameSync(STATE + '.tmp', STATE); }

const summary = { offers: rows.length, unprocessed, deadlineHit: Date.now() >= deadline, routes: stats, repairs };
if (flag('--json')) console.log(JSON.stringify(summary)); else log(JSON.stringify(summary, null, 2));
