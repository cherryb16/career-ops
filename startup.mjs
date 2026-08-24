#!/usr/bin/env node
/**
 * startup.mjs — Session-start hook for career-ops.
 *
 * Shell hooks must write exactly one JSON object to stdout. The `context`
 * field is injected into the session; diagnostics stay in that context rather
 * than being printed as prose or prompting for input.
 */

import { execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

function run(command) {
  try {
    return execSync(command, {
      cwd: CAREER_OPS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    }).trim();
  } catch {
    return null;
  }
}

function parseJson(output) {
  try {
    return output ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}

function count(pattern, file) {
  const output = run(`rg -c ${JSON.stringify(pattern)} ${JSON.stringify(file)}`);
  return /^\d+$/.test(output ?? '') ? Number(output) : 0;
}

const update = parseJson(run('node update-system.mjs check'));
const doctor = parseJson(run('node doctor.mjs --json'));
const pending = count('^\\- \\[ \\]', 'data/pipeline.md');
const processed = count('^\\- \\[x\\]', 'data/pipeline.md');

const updateSummary = update?.status === 'update-available'
  ? `Update available: v${update.local} → v${update.remote}. Auto-applying it now (see AGENTS.md Update Check).`
  : update?.status === 'up-to-date'
    ? `System is up to date (v${update.local}).`
    : `Update status: ${update?.status ?? 'unavailable'}.`;

const healthSummary = doctor
  ? doctor.onboardingNeeded
    ? `Onboarding is incomplete; missing: ${(doctor.missing ?? []).join(', ') || 'unspecified items'}.`
    : 'System health check passed.'
  : 'System health check was unavailable.';

const context = [
  'Career-Ops session startup completed.',
  updateSummary,
  healthSummary,
  `Pipeline: ${pending} pending URLs and ${processed} processed URLs.`,
].join(' ');

process.stdout.write(`${JSON.stringify({ context })}\n`);