#!/usr/bin/env node

/**
 * Deterministic, resumable overnight scan/evaluation coordinator.
 *
 * This file deliberately has no submission or communication capability. It
 * prepares drafts for human review and stops there.
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY_KEY_LIMIT = 100;
const ERROR_LIMIT = 20;
const ERROR_LENGTH = 180;
const TERMINAL = new Set(['completed', 'skipped']);
const BLOCKED_HOST_SUFFIXES = ['linkedin.com', 'handshake.com', 'joinhandshake.com'];
const BLOCKED_SOURCE_RE = /(?:linkedin|handshake|browser[-_ ]?login|authenticated|sign[-_ ]?in)/i;

function hash(value, length = 24) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function safeError(value) {
  return String(value ?? 'unknown error')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:\/Users|\/home)\/[^\s:]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_LENGTH);
}

function addError(errors, message) {
  if (errors.length < ERROR_LIMIT) errors.push(safeError(message));
}

function normalizeCommand(value, fallbackFile, fallbackArgs = []) {
  if (value && typeof value === 'object' && typeof value.file === 'string') {
    return { file: value.file, args: Array.isArray(value.args) ? value.args.map(String) : [] };
  }
  if (typeof value === 'string' && value) return { file: value, args: [] };
  return { file: fallbackFile, args: fallbackArgs };
}

function runCommand(command, extraArgs = [], { cwd = ROOT_DIR, env, maxBuffer = 512 * 1024 } = {}) {
  const result = spawnSync(command.file, [...command.args, ...extraArgs], {
    cwd, env: env || process.env, encoding: 'utf8', shell: false, maxBuffer,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null,
  };
}

function normalizeOptions(input = {}) {
  const batchDir = input.batchDir || process.env.CAREER_OPS_BATCH || path.join(ROOT_DIR, 'batch');
  const dataDir = input.dataDir || process.env.CAREER_OPS_DATA || path.join(ROOT_DIR, 'data');
  const reportsDir = input.reportsDir || process.env.CAREER_OPS_REPORTS || path.join(ROOT_DIR, 'reports');
  const outputDir = input.outputDir || process.env.CAREER_OPS_OUTPUT || path.join(ROOT_DIR, 'output');
  const rootDir = input.rootDir || ROOT_DIR;
  return {
    dryRun: Boolean(input.dryRun), json: Boolean(input.json), now: input.now || new Date(),
    rootDir, batchDir, dataDir, reportsDir, outputDir,
    pipelineFile: input.pipelineFile || process.env.CAREER_OPS_PIPELINE || path.join(dataDir, 'pipeline.md'),
    stateFile: input.stateFile || process.env.CAREER_OPS_STATE || path.join(batchDir, 'batch-state.tsv'),
    inputFile: input.inputFile || path.join(batchDir, 'batch-input.tsv'),
    checkpointFile: input.checkpointFile || process.env.CAREER_OPS_CHECKPOINT || path.join(dataDir, '.overnight-checkpoint.json'),
    lockFile: input.lockFile || path.join(batchDir, '.overnight-workflow.lock'),
    scanCommand: normalizeCommand(input.scanCommand || input.scanCmd || process.env.CAREER_OPS_SCAN_COMMAND, process.execPath, [path.join(ROOT_DIR, 'scan.mjs')]),
    dedupCommand: normalizeCommand(input.dedupCommand, process.execPath, [path.join(ROOT_DIR, 'dedup-tracker.mjs')]),
    runnerCommand: normalizeCommand(input.runnerCommand || input.runnerCmd || process.env.CAREER_OPS_RUNNER_COMMAND, path.join(ROOT_DIR, 'batch', 'batch-runner.sh')),
    reconcileCommand: normalizeCommand(input.reconcileCommand, process.execPath, [path.join(ROOT_DIR, 'reconcile-pipeline.mjs')]),
    verifyCommand: normalizeCommand(input.verifyCommand, process.execPath, [path.join(ROOT_DIR, 'verify-pipeline.mjs')]),
    livenessCommand: normalizeCommand(input.livenessCommand || input.livenessCmd || process.env.CAREER_OPS_LIVENESS_COMMAND, process.execPath, [path.join(ROOT_DIR, 'check-liveness.mjs')]),
    prepareCommand: normalizeCommand(input.prepareCommand || input.prepareCmd || process.env.CAREER_OPS_PREPARE_COMMAND, process.execPath, [path.join(ROOT_DIR, 'prepare-application.mjs')]),
    pdfCommand: normalizeCommand(input.pdfCommand, process.execPath, [path.join(ROOT_DIR, 'generate-pdf.mjs')]),
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

export function readActiveLock(lockFile) {
  if (!existsSync(lockFile)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    return pidAlive(Number(lock.pid)) ? lock : null;
  } catch { return null; }
}

export function acquireLock(lockFile, now = new Date()) {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID();
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started_at: now.toISOString() }));
      closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(readFileSync(lockFile, 'utf8'));
          if (current.pid === process.pid && current.token === token) unlinkSync(lockFile);
        } catch { /* ownership changed or already removed */ }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const active = readActiveLock(lockFile);
      if (active) throw new Error(`overnight workflow already active (pid ${active.pid})`);
      try { unlinkSync(lockFile); } catch (unlinkErr) {
        if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  throw new Error('could not acquire overnight workflow lock');
}

export function getNextPhoenix1AM(now = new Date()) {
  let target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8));
  if (target <= now) target = new Date(target.getTime() + 86_400_000);
  return target.toISOString();
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const rendered = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += Date.UTC(year, month - 1, day, hour, minute) - rendered;
  }
  return new Date(guess);
}

export function parseResetTimestamp(logContent, now = new Date()) {
  if (typeof logContent !== 'string' || !logContent) return null;
  const candidates = [];
  const isoRe = /(?:reset(?:s|_at)?(?:\s+at)?|available(?:\s+at)?)[:\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/gi;
  for (const match of logContent.matchAll(isoRe)) {
    const date = new Date(match[1]);
    if (!Number.isNaN(date.getTime()) && date.getTime() >= now.getTime() - 300_000) candidates.push(date);
  }
  const clockRe = /resets?\s+(\d{1,2}):(\d{2})\s*([ap]m)(?:\s*\(([^)]+)\))?/gi;
  for (const match of logContent.matchAll(clockRe)) {
    let hour = +match[1];
    if (match[3].toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    const zone = match[4] || 'America/Phoenix';
    try {
      const p = zonedParts(now, zone);
      let date = zonedTimeToUtc({ year: +p.year, month: +p.month, day: +p.day, hour, minute: +match[2] }, zone);
      if (date <= now) {
        const tomorrow = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + 1));
        date = zonedTimeToUtc({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour, minute: +match[2] }, zone);
      }
      candidates.push(date);
    } catch { /* invalid or unavailable IANA timezone is not reliable */ }
  }
  const relativeRe = /(?:retry|try again|wait|resets?)(?:\s+(?:after|in|for))?\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/gi;
  for (const match of logContent.matchAll(relativeRe)) {
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
    candidates.push(new Date(now.getTime() + (+match[1] * multiplier)));
  }
  if (!candidates.length) return null;
  const latest = candidates.sort((a, b) => b - a)[0];
  return new Date(latest.getTime() + 300_000).toISOString();
}

export function parsePipelinePendingRoles(content) {
  if (typeof content !== 'string') return [];
  const roles = [];
  let pending = false;
  for (const raw of content.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      pending = /^(?:pending|pendientes|en attente|offen|bekleyenler|oczekujące|afventer|menunggu|लंबित)$/i.test(heading[1]);
      continue;
    }
    if (!pending) continue;
    const item = raw.match(/^- \[ \]\s+(.+)$/);
    if (!item) continue;
    const body = item[1].trim();
    const markdown = body.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)(?:\s*\|\s*(.*))?$/);
    if (markdown) {
      roles.push({ url: markdown[2].trim(), company: '', title: markdown[1].trim(), source: 'pipeline' });
      continue;
    }
    const parts = body.split('|').map((part) => part.trim());
    if (/^(?:https?:\/\/|local:)/i.test(parts[0] || '')) {
      roles.push({ url: parts[0], company: parts[1] || '', title: parts[2] || '', source: 'pipeline' });
    }
  }
  return roles;
}

export function classifySource(role) {
  if (BLOCKED_SOURCE_RE.test(`${role?.source || ''} ${role?.company || ''}`)) {
    return { eligible: false, reason: 'authenticated_source' };
  }
  if (String(role?.url || '').startsWith('local:')) return { eligible: true, reason: null };
  try {
    const parsed = new URL(role.url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return { eligible: false, reason: 'non_https_source' };
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return { eligible: false, reason: 'authenticated_source' };
    }
    if (/\/(?:login|signin|auth)(?:\/|$)/i.test(parsed.pathname)) return { eligible: false, reason: 'browser_login_source' };
    return { eligible: true, reason: null };
  } catch { return { eligible: false, reason: 'invalid_source' }; }
}

export function roleIdempotencyKey(url) { return `role_${hash(String(url).trim().toLowerCase())}`; }
export function cardIdempotencyKey(url) { return `card_${hash(`review:${String(url).trim().toLowerCase()}`)}`; }

function parseBatchInput(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const [id, url, source, notes] = line.split('\t');
    return { id, url, source, notes };
  }).filter((row) => /^\d+$/.test(row.id) && row.url);
}

export function convertPendingRolesToBatchInput(inputFile, roles, { dryRun = false } = {}) {
  const rows = parseBatchInput(inputFile);
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  let max = rows.reduce((n, row) => Math.max(n, +row.id), 0);
  const added = [];
  for (const role of roles) {
    if (byUrl.has(role.url)) continue;
    const row = { id: String(++max), url: role.url, source: role.source || 'pipeline', notes: `${role.company || ''} | ${role.title || ''}`.replace(/[\t\r\n]/g, ' ') };
    rows.push(row); byUrl.set(row.url, row); added.push(row);
  }
  const content = ['id\turl\tsource\tnotes', ...rows.map((r) => [r.id, r.url, r.source, r.notes].join('\t'))].join('\n') + '\n';
  if (!dryRun && (added.length || !existsSync(inputFile))) atomicWrite(inputFile, content);
  return { addedCount: added.length, totalOffers: rows.length, rows, added };
}

export function parseBatchStateRows(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = (lines.shift() || '').split('\t');
  return lines.map((line) => {
    const values = line.split('\t');
    return Object.fromEntries(header.map((key, i) => [key, values[i] || '']));
  }).filter((row) => row.id && row.url && row.status);
}

export function isSupportedAtsUrl(url) {
  try {
    return new Set(['boards.greenhouse.io', 'greenhouse.io', 'jobs.ashbyhq.com', 'ashbyhq.com', 'jobs.lever.co', 'jobs.eu.lever.co', 'lever.co']).has(new URL(url).hostname.toLowerCase());
  } catch { return false; }
}

function reportForRow(reportsDir, reportNum) {
  if (!/^\d+$/.test(String(reportNum || '')) || !existsSync(reportsDir)) return null;
  const numeric = +reportNum;
  const name = readdirSync(reportsDir).find((file) => {
    const match = file.match(/^(\d+)-.*\.md$/); return match && +match[1] === numeric;
  });
  return name ? path.join(reportsDir, name) : null;
}

function reportField(content, name) {
  return content.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
}

function reportSection(content, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const lines = content.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.+?)\s*$/);
    if (heading && wanted.has(heading[1].toLowerCase())) { start = i + 1; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim() || null;
}

function reportDecision(content) {
  const machine = reportSection(content, ['Machine Summary']);
  return machine?.match(/^final_decision:\s*["']?([^"'\n]+)["']?\s*$/mi)?.[1]?.trim() || null;
}

function resolveArtifact(rootDir, expectedRoot, reference) {
  if (!reference || /not generated/i.test(reference)) return null;
  const clean = reference.replace(/^`|`$/g, '').split(/\s+/)[0];
  const absolute = path.resolve(rootDir, clean);
  const rel = path.relative(path.resolve(expectedRoot), absolute);
  return (!rel.startsWith('..') && !path.isAbsolute(rel) && existsSync(absolute)) ? absolute : null;
}

function relativeToRoot(opts, file) { return file ? path.relative(opts.rootDir, file) : null; }

function parseDeadline(content, now) {
  const matches = [...content.matchAll(/(?:deadline|apply by|closing date)\s*:?\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/gi)];
  const dates = matches.map((m) => new Date(m[1].length === 10 ? `${m[1]}T23:59:59Z` : m[1])).filter((d) => Number.isFinite(d.getTime()));
  if (!dates.length) return { deadline: null, urgent: false };
  const deadline = dates.sort((a, b) => a - b)[0];
  return { deadline: deadline.toISOString(), urgent: deadline >= now && deadline.getTime() - now.getTime() <= 172_800_000 };
}

function preparePassedReviewPackages(opts, rows, generationIds, generationId, errors) {
  let draftReady = 0, missingArtifact = 0, urgentDeadline = 0;
  const packages = [];
  const packagesDir = path.join(opts.reportsDir, 'packages');
  for (const row of rows.filter((item) => generationIds.has(item.id) && item.status === 'completed')) {
    const report = reportForRow(opts.reportsDir, row.report_num);
    if (!report) continue;
    const content = readFileSync(report, 'utf8');
    if (reportDecision(content)?.toLowerCase() !== 'apply') continue;
    const roleKey = roleIdempotencyKey(row.url);
    const cardKey = cardIdempotencyKey(row.url);
    const artifactDir = path.join(opts.outputDir, 'review-packages', roleKey);
    const manifestPath = path.join(packagesDir, `${cardKey}.json`);
    const deadline = parseDeadline(content, opts.now);
    if (deadline.urgent) urgentDeadline++;
    const missing = [], artifactErrors = [];
    let pdf = resolveArtifact(opts.rootDir, opts.outputDir, reportField(content, 'PDF'));
    const pdfRef = reportField(content, 'PDF');
    if (!pdf && pdfRef && /\.pdf\b/i.test(pdfRef)) {
      const pdfTarget = path.resolve(opts.rootDir, pdfRef.replace(/^`|`$/g, '').split(/\s+/)[0]);
      const html = pdfTarget.replace(/\.pdf$/i, '.html');
      if (existsSync(html)) {
        const generated = runCommand(opts.pdfCommand, [html, pdfTarget, `--report=${+row.report_num}`], { cwd: opts.rootDir });
        if (generated.status === 0) pdf = resolveArtifact(opts.rootDir, opts.outputDir, pdfRef);
        else artifactErrors.push({ artifact: 'tailored_pdf', code: 'generator_failed' });
      }
    }
    if (!pdf) missing.push('tailored_pdf');
    const coverText = reportSection(content, ['Cover Letter Draft']);
    const answersText = reportSection(content, ['H) Draft Application Answers', 'Application Answers']);
    let coverFile = null, answersFile = null;
    mkdirSync(artifactDir, { recursive: true });
    if (coverText) { coverFile = path.join(artifactDir, 'cover-letter.md'); atomicWrite(coverFile, `${coverText}\n`); } else missing.push('cover_letter');
    if (answersText) { answersFile = path.join(artifactDir, 'application-answers.md'); atomicWrite(answersFile, `${answersText}\n`); } else missing.push('application_answers');

    const live = runCommand(opts.livenessCommand, [row.url], { cwd: opts.rootDir });
    const liveOutput = `${live.stdout}\n${live.stderr}`;
    const liveness = /\bactive\b/i.test(liveOutput) && live.status === 0 ? 'active' : /\bexpired\b/i.test(liveOutput) ? 'expired' : 'uncertain';
    if (liveness !== 'active') artifactErrors.push({ artifact: 'liveness', code: liveness });

    let prefillFile = null;
    let humanBlocker = null;
    if (isSupportedAtsUrl(row.url)) {
      if (pdf && coverFile) {
        const prepared = runCommand(opts.prepareCommand, ['--url', row.url, '--pdf', relativeToRoot(opts, pdf), '--cover', relativeToRoot(opts, coverFile)], { cwd: opts.rootDir });
        if (prepared.status === 0) {
          prefillFile = path.join(artifactDir, 'ats-prefill.txt');
          atomicWrite(prefillFile, prepared.stdout.slice(0, 64 * 1024));
        } else artifactErrors.push({ artifact: 'ats_prefill', code: 'preparation_failed' });
      } else artifactErrors.push({ artifact: 'ats_prefill', code: 'prerequisite_missing' });
    } else {
      humanBlocker = classifySource(row).eligible ? 'unsupported_ats_manual_prefill' : 'authenticated_portal_manual_review';
      artifactErrors.push({ artifact: 'ats_prefill', code: humanBlocker });
    }
    const ready = missing.length === 0 && artifactErrors.length === 0 && Boolean(prefillFile);
    if (ready) draftReady++; else missingArtifact++;
    const manifest = {
      schema_version: 2, generation_id: generationId, role_key: roleKey, card_key: cardKey,
      status: 'Passed', draft_ready: ready,
      artifacts: {
        report: relativeToRoot(opts, report), tailored_pdf: relativeToRoot(opts, pdf),
        cover_letter: relativeToRoot(opts, coverFile), application_answers: relativeToRoot(opts, answersFile),
        ats_prefill: relativeToRoot(opts, prefillFile),
      },
      missing, errors: artifactErrors, liveness, deadline: deadline.deadline,
      urgent_deadline: deadline.urgent, human_blocker: humanBlocker,
    };
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    packages.push({ role_key: roleKey, card_key: cardKey, draft_ready: ready });
  }
  return { draftReady, missingArtifact, urgentDeadline, packages };
}

function readCheckpoint(file) {
  if (!existsSync(file)) return { schema_version: 2, runs: [], current: null };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(value.runs)) return value;
    return { schema_version: 2, runs: value.run_id ? [value] : [], current: value.run_id ? value : null };
  } catch { return { schema_version: 2, runs: [], current: null }; }
}

function boundedKeys(packages, roles) {
  const roleKeys = [...new Set(roles.map((role) => roleIdempotencyKey(role.url)))];
  const cardKeys = [...new Set(packages.map((item) => item.card_key))];
  return {
    role_keys: roleKeys.slice(0, SUMMARY_KEY_LIMIT), role_keys_omitted: Math.max(0, roleKeys.length - SUMMARY_KEY_LIMIT),
    card_keys: cardKeys.slice(0, SUMMARY_KEY_LIMIT), card_keys_omitted: Math.max(0, cardKeys.length - SUMMARY_KEY_LIMIT),
  };
}

function recentPauseLogs(opts, pausedRows, startedAt) {
  const pieces = [];
  const pauseFile = path.join(opts.batchDir, 'batch-runner.paused');
  if (existsSync(pauseFile) && statSync(pauseFile).mtimeMs >= startedAt.getTime() - 1000) pieces.push(readFileSync(pauseFile, 'utf8'));
  const logsDir = path.join(opts.batchDir, 'logs');
  if (existsSync(logsDir)) {
    const ids = new Set(pausedRows.map((row) => String(row.id)));
    const files = readdirSync(logsDir).map((name) => path.join(logsDir, name))
      .filter((file) => { try { return statSync(file).isFile() && statSync(file).mtimeMs >= startedAt.getTime() - 1000; } catch { return false; } })
      .filter((file) => ids.size === 0 || [...ids].some((id) => path.basename(file).includes(`-${id}`)))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 5);
    for (const file of files) pieces.push(readFileSync(file, 'utf8').slice(-32 * 1024));
  }
  return pieces.join('\n');
}

export async function runOvernightWorkflow(input = {}) {
  const opts = normalizeOptions(input);
  const startedAt = new Date(opts.now);
  let releaseLock = () => {};
  if (!opts.dryRun) releaseLock = acquireLock(opts.lockFile, startedAt);
  const errors = [];
  let summary;
  try {
    const scan = runCommand(opts.scanCommand, ['--public-only', ...(opts.dryRun ? ['--dry-run'] : [])], { cwd: opts.rootDir });
    if (scan.status !== 0) addError(errors, `scan failure: ${scan.stderr || scan.error || scan.stdout}`);
    const dedup = runCommand(opts.dedupCommand, opts.dryRun ? ['--dry-run'] : [], { cwd: opts.rootDir });
    if (dedup.status !== 0) addError(errors, `dedup failure: ${dedup.stderr || dedup.error || dedup.stdout}`);

    const pending = existsSync(opts.pipelineFile) ? parsePipelinePendingRoles(readFileSync(opts.pipelineFile, 'utf8')) : [];
    const unique = [...new Map(pending.map((role) => [role.url, role])).values()];
    const eligibleRoles = [], blockedRoles = [];
    for (const role of unique) (classifySource(role).eligible ? eligibleRoles : blockedRoles).push(role);
    const converted = convertPendingRolesToBatchInput(opts.inputFile, eligibleRoles, { dryRun: opts.dryRun });
    const beforeState = parseBatchStateRows(opts.stateFile);
    const unfinishedIds = new Set(beforeState.filter((row) => !TERMINAL.has(row.status)).map((row) => row.id));
    const generationRows = converted.rows.filter((row) => eligibleRoles.some((role) => role.url === row.url) || unfinishedIds.has(row.id));
    const generationIds = new Set(generationRows.map((row) => row.id));
    const generationId = `gen_${hash(generationRows.map((row) => roleIdempotencyKey(row.url)).sort().join('\n') || 'empty')}`;

    const runnerArgs = ['--cli', 'agy', '--parallel', '2', '--limit', '0', '--rate-limit-sleep', '0', '--resume-paused', '--batch-dir', opts.batchDir];
    if (opts.dryRun) runnerArgs.push('--dry-run');
    const runner = runCommand(opts.runnerCommand, runnerArgs, { cwd: opts.rootDir });
    if (runner.status !== 0 && !/(?:paused|rate limit|session limit)/i.test(`${runner.stdout}\n${runner.stderr}`)) {
      addError(errors, `runner failure: ${runner.stderr || runner.error || runner.stdout}`);
    }
    if (!opts.dryRun) {
      const reconcile = runCommand(opts.reconcileCommand, ['--state', opts.stateFile, '--pipeline', opts.pipelineFile], { cwd: opts.rootDir });
      if (reconcile.status !== 0) addError(errors, `reconcile failure: ${reconcile.stderr || reconcile.error || reconcile.stdout}`);
      const verify = runCommand(opts.verifyCommand, [], { cwd: opts.rootDir });
      if (verify.status !== 0) addError(errors, `verification failure: ${verify.stderr || verify.error || verify.stdout}`);
    }

    const stateRows = parseBatchStateRows(opts.stateFile);
    const scoped = stateRows.filter((row) => generationIds.has(row.id));
    const completed = scoped.filter((row) => row.status === 'completed');
    const skipped = scoped.filter((row) => row.status === 'skipped');
    const failedRows = scoped.filter((row) => row.status === 'failed');
    const pausedRows = scoped.filter((row) => /^(?:paused_rate_limit|rate_limited)$/.test(row.status));
    const unrecoverable = failedRows.filter((row) => Number(row.retries || 0) >= 2 || /(?:fatal|unrecoverable|provider)/i.test(row.error || ''));
    if (unrecoverable.length) addError(errors, `unrecoverable provider failure count: ${unrecoverable.length}`);
    const passedRows = completed.filter((row) => {
      const report = reportForRow(opts.reportsDir, row.report_num);
      return report && reportDecision(readFileSync(report, 'utf8'))?.toLowerCase() === 'apply';
    });
    let packages = { draftReady: 0, missingArtifact: 0, urgentDeadline: 0, packages: [] };
    if (!opts.dryRun) packages = preparePassedReviewPackages(opts, stateRows, generationIds, generationId, errors);
    const reset = pausedRows.length ? parseResetTimestamp(`${runner.stdout}\n${runner.stderr}\n${recentPauseLogs(opts, pausedRows, startedAt)}`, startedAt) : null;
    const keys = boundedKeys(packages.packages, generationRows);
    summary = {
      schema_version: 2, run_id: `run_${hash(`${generationId}:${startedAt.toISOString()}`)}`, generation_id: generationId,
      started_at: startedAt.toISOString(), completed_at: new Date().toISOString(), dry_run: opts.dryRun,
      discovered: unique.length, auto_filtered: skipped.length + blockedRoles.length, eligible: generationRows.length,
      evaluated: completed.length + failedRows.length + skipped.length, passed: passedRows.length,
      failed: failedRows.length, paused: pausedRows.length, draft_ready: packages.draftReady,
      missing_artifact: packages.missingArtifact, urgent_deadline: packages.urgentDeadline,
      authenticated_blockers: blockedRoles.length, ...keys,
      resume_at: pausedRows.length ? (reset || getNextPhoenix1AM(startedAt)) : null,
      errors,
    };
    if (!opts.dryRun) {
      const persisted = readCheckpoint(opts.checkpointFile);
      const prior = persisted.runs.filter((run) => run.generation_id !== generationId);
      persisted.runs = [...prior, summary].slice(-32);
      persisted.current = summary;
      atomicWrite(opts.checkpointFile, JSON.stringify(persisted, null, 2) + '\n');
    }
  } finally {
    // The production lock is intentionally held through the atomic checkpoint write.
    releaseLock();
  }
  if (opts.json) console.log(JSON.stringify(summary));
  else {
    console.log(`Overnight ${summary.dry_run ? 'dry run' : 'run'} ${summary.generation_id}: ${summary.eligible} eligible, ${summary.evaluated} evaluated, ${summary.passed} passed.`);
    console.log(`Draft-ready ${summary.draft_ready}; missing artifacts ${summary.missing_artifact}; paused ${summary.paused}.`);
    if (summary.resume_at) console.log(`Resume at ${summary.resume_at}.`);
    if (summary.errors.length) console.log(`${summary.errors.length} bounded error(s); run with --json for codes.`);
  }
  return summary;
}

function parseArgs(argv = process.argv.slice(2)) {
  const input = { dryRun: false, json: false };
  const values = new Map([
    ['--data-dir', 'dataDir'], ['--batch-dir', 'batchDir'], ['--reports-dir', 'reportsDir'],
    ['--output-dir', 'outputDir'], ['--pipeline-file', 'pipelineFile'], ['--state-file', 'stateFile'],
    ['--checkpoint-file', 'checkpointFile'], ['--scan-command', 'scanCommand'],
    ['--runner-command', 'runnerCommand'], ['--prepare-command', 'prepareCommand'], ['--liveness-command', 'livenessCommand'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') input.dryRun = true;
    else if (argv[i] === '--json') input.json = true;
    else if (values.has(argv[i]) && argv[i + 1]) input[values.get(argv[i])] = argv[++i];
  }
  return input;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runOvernightWorkflow(parseArgs()).catch((err) => { console.error(`overnight workflow failed: ${safeError(err.message)}`); process.exit(1); });
}
