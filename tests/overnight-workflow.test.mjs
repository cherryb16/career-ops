import { pass, fail, ROOT } from './helpers.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireLock, cardIdempotencyKey, classifySource, getNextPhoenix1AM, parsePipelinePendingRoles, parseResetTimestamp, roleIdempotencyKey, runOvernightWorkflow } from '../automation/overnight-workflow.mjs';
import { generateDailyDigest } from '../automation/daily-digest.mjs';
import { generateWeeklyReview } from '../automation/weekly-review.mjs';
import { generateExceptionReport } from '../automation/exception-report.mjs';
import { isPublicAutomationEntry } from '../scan.mjs';

console.log('\novernight career workflow — focused safety and resumability tests');
let failures = 0;
function check(condition, name, detail = '') { if (condition) pass(name); else { failures++; fail(`${name}${detail ? `: ${detail}` : ''}`); } }

function fixture() {
  const root = mkdtempSync(path.join(ROOT, 'tmp', 'overnight-'));
  const dirs = Object.fromEntries(['data', 'batch', 'reports', 'output'].map((name) => [name, path.join(root, name)]));
  Object.values(dirs).forEach((dir) => mkdirSync(dir, { recursive: true }));
  const noop = path.join(root, 'noop.mjs');
  writeFileSync(noop, 'process.stdout.write("ok\\n");\n');
  const active = path.join(root, 'active.mjs');
  writeFileSync(active, 'process.stdout.write("✅ active https://redacted.invalid/job\\n");\n');
  const prepare = path.join(root, 'prepare.mjs');
  writeFileSync(prepare, 'process.stdout.write("safe prefill prepared\\n");\n');
  const command = (script) => ({ file: process.execPath, args: [script] });
  const base = {
    rootDir: root, dataDir: dirs.data, batchDir: dirs.batch, reportsDir: dirs.reports, outputDir: dirs.output,
    pipelineFile: path.join(dirs.data, 'pipeline.md'), stateFile: path.join(dirs.batch, 'batch-state.tsv'),
    checkpointFile: path.join(dirs.data, '.overnight-checkpoint.json'),
    scanCommand: command(noop), dedupCommand: command(noop), runnerCommand: command(noop),
    reconcileCommand: command(noop), verifyCommand: command(noop), livenessCommand: command(active), prepareCommand: command(prepare),
    json: false, now: new Date('2026-07-21T07:00:00Z'),
  };
  return { root, ...dirs, base, command, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function pipeline(...rows) { return `# Pipeline\n\n## Pending\n\n${rows.join('\n')}\n\n## Processed\n\n- [x] old\n`; }
function state(rows) { return `id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n${rows.join('\n')}${rows.length ? '\n' : ''}`; }
function report({ decision = 'Apply', pdf = null, cover = true, answers = true, deadline = null } = {}) {
  return `# Report\n\n**PDF:** ${pdf || 'not generated'}\n\n## Machine Summary\n\n\`\`\`yaml\nfinal_decision: "${decision}"\n\`\`\`\n${cover ? '\n## Cover Letter Draft\n\nSpecific draft.\n' : ''}${answers ? '\n## H) Draft Application Answers\n\nSpecific answers.\n' : ''}${deadline ? `\nDeadline: ${deadline}\n` : ''}`;
}

// Real pipeline grammar and reliable section termination.
{
  const roles = parsePipelinePendingRoles(pipeline(
    '- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Engineer',
    '- [ ] [Designer](https://jobs.ashbyhq.com/acme/2)',
  ));
  check(roles.length === 2 && roles[0].company === 'Acme' && !roles.some((r) => r.url === 'old'), 'pipeline parser handles canonical rows and stops at next section');
}

// Empty scan and dry-run immutability (no input/checkpoint/lock/package writes).
{
  const ws = fixture();
  try {
    writeFileSync(ws.base.pipelineFile, pipeline());
    const before = readdirSync(ws.root, { recursive: true }).sort().join('\n');
    const result = await runOvernightWorkflow({ ...ws.base, dryRun: true });
    const after = readdirSync(ws.root, { recursive: true }).sort().join('\n');
    check(result.discovered === 0 && result.eligible === 0, 'empty scans produce zero scoped counts');
    check(before === after && !existsSync(ws.base.checkpointFile) && !existsSync(path.join(ws.batch, '.overnight-workflow.lock')), 'dry-run leaves persistent state and artifacts unchanged');
  } finally { ws.cleanup(); }
}

// Public-only allowlist boundary and authenticated blockers.
{
  check(classifySource({ url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'pipeline' }).eligible, 'public script-supported ATS is eligible');
  check(!classifySource({ url: 'https://www.linkedin.com/jobs/view/1', source: 'pipeline' }).eligible
    && !classifySource({ url: 'https://app.joinhandshake.com/jobs/1', source: 'pipeline' }).eligible
    && !classifySource({ url: 'https://example.com/login/job/1', source: 'pipeline' }).eligible, 'LinkedIn, Handshake, and login-only sources are excluded');
  check(isPublicAutomationEntry({ name: 'Greenhouse', provider: 'greenhouse', careers_url: 'https://boards.greenhouse.io/acme' })
    && !isPublicAutomationEntry({ name: 'LinkedIn', careers_url: 'https://linkedin.com/jobs' })
    && !isPublicAutomationEntry({ name: 'Handshake', careers_url: 'https://app.joinhandshake.com/jobs' }), 'scanner public-only boundary directly excludes authenticated sources');
}

// Atomic active lock rejection and stale lock recovery.
{
  const ws = fixture();
  try {
    const lock = path.join(ws.batch, '.overnight-workflow.lock');
    const release = acquireLock(lock, ws.base.now);
    let rejected = false;
    try { acquireLock(lock, ws.base.now); } catch { rejected = true; }
    check(rejected, 'atomic lock rejects a second active owner');
    release();
    writeFileSync(lock, JSON.stringify({ pid: 99999999, token: 'stale' }));
    const releaseRecovered = acquireLock(lock, ws.base.now);
    check(existsSync(lock), 'stale lock is recovered atomically');
    releaseRecovered();
  } finally { ws.cleanup(); }
}

// A missing tailored PDF is generated only from the same report's HTML by the
// repository PDF generator command, using argument arrays.
{
  const ws = fixture();
  try {
    const url = 'https://jobs.lever.co/acme/pdf-role';
    writeFileSync(ws.base.pipelineFile, pipeline(`- [ ] ${url} | Acme | PDF Role`));
    writeFileSync(ws.base.stateFile, state([`1\t${url}\tcompleted\t-\t-\t045\t4.8\t-\t0`]));
    writeFileSync(path.join(ws.output, 'cv-acme-045.html'), '<html>fixture</html>');
    writeFileSync(path.join(ws.reports, '045-acme.md'), report({ pdf: 'output/cv-acme-045.pdf' }));
    const pdfGenerator = path.join(ws.root, 'pdf-generator.mjs');
    writeFileSync(pdfGenerator, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], 'generated pdf'); writeFileSync(new URL('./pdf-args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));`);
    const result = await runOvernightWorkflow({ ...ws.base, pdfCommand: ws.command(pdfGenerator) });
    const args = JSON.parse(readFileSync(path.join(ws.root, 'pdf-args.json'), 'utf8'));
    check(result.draft_ready === 1 && args[0].endsWith('cv-acme-045.html') && args[1].endsWith('cv-acme-045.pdf') && args[2] === '--report=45', 'existing PDF generator is invoked with role-bound argument-array paths');
  } finally { ws.cleanup(); }
}

// Exact timezone-aware reset semantics and Phoenix fallback.
{
  const now = new Date('2026-07-21T00:00:00Z');
  check(parseResetTimestamp('session limit; resets 12:30pm (Asia/Taipei)', now) === '2026-07-21T04:35:00.000Z', 'timezone reset is exact reset plus five minutes');
  check(parseResetTimestamp('reset at 2026-07-21T11:10:00-04:00', now) === '2026-07-21T15:15:00.000Z', 'offset timestamp is exact reset plus five minutes');
  check(parseResetTimestamp('rate limited without a time', now) === null && getNextPhoenix1AM(now) === '2026-07-21T08:00:00.000Z', 'missing reset falls back to next 1:00 AM America/Phoenix');
}

// Duplicates, filtered sources, exact runner args, full normal+paused backlog drain.
{
  const ws = fixture();
  try {
    const runner = path.join(ws.root, 'runner.mjs');
    writeFileSync(runner, `
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
writeFileSync(path.join(root, 'runner-args.json'), JSON.stringify(process.argv.slice(2)));
const input = readFileSync(path.join(root, 'batch/batch-input.tsv'), 'utf8').trim().split('\\n').slice(1);
const rows = input.map((line, i) => { const [id,url] = line.split('\\t'); return [id,url,'completed','2026-07-21T07:00:00Z','2026-07-21T07:01:00Z',String(i+1).padStart(3,'0'),'4.5','-','0'].join('\\t'); });
writeFileSync(path.join(root, 'batch/batch-state.tsv'), 'id\\turl\\tstatus\\tstarted_at\\tcompleted_at\\treport_num\\tscore\\terror\\tretries\\n' + rows.join('\\n') + '\\n');
`);
    writeFileSync(ws.base.pipelineFile, pipeline(
      '- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Engineer',
      '- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Engineer',
      '- [ ] https://www.linkedin.com/jobs/view/9 | LinkedIn | Blocked',
      '- [ ] https://jobs.ashbyhq.com/acme/2 | Acme | Lead',
    ));
    writeFileSync(ws.base.stateFile, state(['1\thttps://boards.greenhouse.io/acme/jobs/1\tpaused_rate_limit\t-\t-\t001\t-\tlimit\t0']));
    const result = await runOvernightWorkflow({ ...ws.base, runnerCommand: ws.command(runner) });
    const args = JSON.parse(readFileSync(path.join(ws.root, 'runner-args.json'), 'utf8'));
    const inputRows = readFileSync(path.join(ws.batch, 'batch-input.tsv'), 'utf8').trim().split('\n').slice(1);
    check(JSON.stringify(args) === JSON.stringify(['--cli','agy','--parallel','2','--limit','0','--rate-limit-sleep','0','--resume-paused']), 'runner receives exact AGY parallelism-2 unbounded drain arguments');
    check(inputRows.length === 2 && result.evaluated === 2 && result.authenticated_blockers === 1, 'duplicates are idempotent, authenticated roles filter, and full backlog drains');
  } finally { ws.cleanup(); }
}

// Only Machine Summary Apply is Passed; complete package is role-bound and ready.
{
  const ws = fixture();
  try {
    const url = 'https://boards.greenhouse.io/acme/jobs/44';
    writeFileSync(ws.base.pipelineFile, pipeline(`- [ ] ${url} | Acme | Engineer`));
    writeFileSync(ws.base.stateFile, state([`1\t${url}\tcompleted\t-\t-\t044\t4.8\t-\t0`]));
    const pdf = path.join(ws.output, 'cv-acme-044.pdf'); writeFileSync(pdf, 'pdf');
    writeFileSync(path.join(ws.reports, '044-acme.md'), report({ pdf: 'output/cv-acme-044.pdf', deadline: '2026-07-22T06:00:00Z' }));
    const result = await runOvernightWorkflow(ws.base);
    const card = cardIdempotencyKey(url);
    const manifest = JSON.parse(readFileSync(path.join(ws.reports, 'packages', `${card}.json`), 'utf8'));
    check(result.passed === 1 && result.draft_ready === 1 && result.urgent_deadline === 1, 'proven Apply role creates a complete draft-ready package and urgent deadline count');
    check(manifest.role_key === roleIdempotencyKey(url) && manifest.artifacts.tailored_pdf === 'output/cv-acme-044.pdf'
      && manifest.artifacts.cover_letter && manifest.artifacts.application_answers && manifest.artifacts.ats_prefill
      && manifest.liveness === 'active' && manifest.missing.length === 0 && manifest.errors.length === 0, 'package binds all required artifacts to the same role');
  } finally { ws.cleanup(); }
}

// Completed is not Passed; Apply with missing artifacts is precise and never ready.
{
  const ws = fixture();
  try {
    const consider = 'https://jobs.ashbyhq.com/acme/consider';
    const missing = 'https://jobs.ashbyhq.com/acme/missing';
    writeFileSync(ws.base.pipelineFile, pipeline(`- [ ] ${consider} | Acme | Consider`, `- [ ] ${missing} | Acme | Missing`));
    writeFileSync(ws.base.stateFile, state([
      `1\t${consider}\tcompleted\t-\t-\t051\t4.9\t-\t0`, `2\t${missing}\tcompleted\t-\t-\t052\t4.9\t-\t0`,
    ]));
    writeFileSync(path.join(ws.reports, '051-consider.md'), report({ decision: 'Consider' }));
    writeFileSync(path.join(ws.reports, '052-missing.md'), report({ decision: 'Apply', cover: false, answers: false }));
    const result = await runOvernightWorkflow(ws.base);
    const packageFiles = readdirSync(path.join(ws.reports, 'packages'));
    const manifest = JSON.parse(readFileSync(path.join(ws.reports, 'packages', packageFiles[0]), 'utf8'));
    check(result.passed === 1 && packageFiles.length === 1 && result.draft_ready === 0 && result.missing_artifact === 1, 'completed Consider is never packaged while incomplete Apply is not draft-ready');
    check(manifest.missing.includes('tailored_pdf') && manifest.missing.includes('cover_letter') && manifest.missing.includes('application_answers')
      && manifest.errors.some((e) => e.artifact === 'ats_prefill'), 'missing package records precise artifact and preparation errors');
  } finally { ws.cleanup(); }
}

// Interrupted run uses only new relevant logs; exact resume and stable rerun generation.
{
  const ws = fixture();
  try {
    const url = 'https://jobs.ashbyhq.com/acme/paused';
    writeFileSync(ws.base.pipelineFile, pipeline(`- [ ] ${url} | Acme | Paused`));
    writeFileSync(ws.base.stateFile, state([`1\t${url}\tpaused_rate_limit\t-\t-\t061\t-\tlimit\t0`]));
    mkdirSync(path.join(ws.batch, 'logs'), { recursive: true });
    const old = path.join(ws.batch, 'logs', '061-1-old.log'); writeFileSync(old, 'resets 11:00pm (America/Phoenix)');
    utimesSync(old, new Date('2026-07-20T00:00:00Z'), new Date('2026-07-20T00:00:00Z'));
    const first = await runOvernightWorkflow(ws.base);
    const second = await runOvernightWorkflow(ws.base);
    const persisted = JSON.parse(readFileSync(ws.base.checkpointFile, 'utf8'));
    check(first.resume_at === '2026-07-21T08:00:00.000Z' && second.generation_id === first.generation_id, 'paused run ignores stale logs and uses deterministic resume fallback');
    check(persisted.runs.length === 1 && persisted.current.generation_id === first.generation_id, 'true rerun replaces one generation checkpoint without duplicate counts or cards');
  } finally { ws.cleanup(); }
}

// PID-aware digest, seven-day-scoped weekly report, and manifest completeness.
{
  const ws = fixture();
  try {
    const now = new Date('2026-07-21T20:00:00Z');
    writeFileSync(ws.base.checkpointFile, JSON.stringify({ schema_version: 2, current: { generation_id: 'new', evaluated: 2, passed: 1, draft_ready: 1 }, runs: [
      { generation_id: 'old', completed_at: '2026-07-10T00:00:00Z', evaluated: 99, passed: 99 },
      { generation_id: 'new', completed_at: '2026-07-20T00:00:00Z', evaluated: 2, passed: 1 },
    ] }));
    const lock = path.join(ws.batch, '.overnight-workflow.lock'); writeFileSync(lock, JSON.stringify({ pid: 99999999 }));
    check(generateDailyDigest({ ...ws.base, json: false }).in_progress === false, 'daily digest ignores stale lock PID');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: now.toISOString() }));
    check(generateDailyDigest({ ...ws.base, json: false }).in_progress === true, 'daily digest includes a live in-progress checkpoint');
    const packages = path.join(ws.reports, 'packages'); mkdirSync(packages, { recursive: true });
    writeFileSync(path.join(packages, 'complete.json'), JSON.stringify({ generation_id: 'new', status: 'Passed', draft_ready: true, liveness: 'active', artifacts: { report: 'r', tailored_pdf: 'p', cover_letter: 'c', application_answers: 'a', ats_prefill: 'f' }, missing: [], errors: [] }));
    writeFileSync(path.join(packages, 'false-ready.json'), JSON.stringify({ generation_id: 'new', status: 'Passed', draft_ready: true, liveness: 'active', artifacts: {}, missing: [], errors: [] }));
    writeFileSync(path.join(packages, 'old-complete.json'), JSON.stringify({ generation_id: 'old', status: 'Passed', draft_ready: true, liveness: 'active', artifacts: { report: 'r', tailored_pdf: 'p', cover_letter: 'c', application_answers: 'a', ats_prefill: 'f' }, missing: [], errors: [] }));
    const weekly = generateWeeklyReview({ ...ws.base, now, json: false });
    check(weekly.summary.evaluated === 2 && weekly.summary.draft_packages_ready === 1 && weekly.generations === 1, 'weekly review scopes seven days and counts only complete manifests');
  } finally { ws.cleanup(); }
}

// Exception output is silent when clean and bounded/PII-safe when material.
{
  const ws = fixture();
  try {
    check(generateExceptionReport({ ...ws.base, json: false }) === null, 'exception report is silent when non-material');
    writeFileSync(ws.base.checkpointFile, JSON.stringify({ current: { generation_id: 'g', urgent_deadline: 1, errors: ['scan failure https://secret.example/jobs/1 person@example.com'] } }));
    const exception = generateExceptionReport({ ...ws.base, json: false });
    check(JSON.stringify(exception).includes('[url]') && JSON.stringify(exception).includes('[email]') && !JSON.stringify(exception).includes('secret.example'), 'exception report is bounded and PII-safe');
  } finally { ws.cleanup(); }
}

// Static safety: array child processes only; no submission/contact/status mutation paths.
{
  const files = ['automation/overnight-workflow.mjs', 'automation/daily-digest.mjs', 'automation/weekly-review.mjs', 'automation/exception-report.mjs'];
  const source = files.map((file) => readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  check(!/exec(?:Sync|FileSync)?\s*\(/.test(source) && /shell:\s*false/.test(source), 'role-controlled child process execution is argument-array and shell-free');
  check(!/(?:set-status\.mjs|contacto|sendEmail|axios\.post|method:\s*['"]POST['"]|status\s*[=:]\s*['"](?:Applied|Submitted)['"])/i.test(source), 'workflow has no submission, applied-state, email, or recruiter-contact invocation path');
  const runner = readFileSync(path.join(ROOT, 'batch/batch-runner.sh'), 'utf8');
  check(!/\/Users\/[A-Za-z0-9._-]+\//.test(runner) && runner.includes('CLI="agy"'), 'tracked runner has AGY default and no user-specific executable path');
}

if (failures) process.exitCode = 1;
