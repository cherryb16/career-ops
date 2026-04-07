#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in applications.md
 *
 * Maps all non-canonical statuses to canonical ones per states.yml:
 *   Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP
 *
 * Also strips markdown bold (**) and dates from the status field,
 * moving duplicate/repost info to the notes column.
 *
 * Run: node career-ops/normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';

const CAREER_OPS = new URL('.', import.meta.url).pathname;
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

function normalizeStatus(raw) {
  let s = raw.replace(/\*\*/g, '').trim();
  const lower = s.toLowerCase();

  if (/^(duplicate|dup)\b/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }
  if (/^repost/i.test(s)) {
    return { status: 'Discarded', moveToNotes: raw.trim() };
  }
  if (/^(closed|cancelled|canceled)$/i.test(s)) return { status: 'Discarded' };
  if (/^rejected\s+\d{4}/i.test(s)) return { status: 'Rejected' };
  if (/^applied\s+\d{4}/i.test(s)) return { status: 'Applied' };
  if (s === '—' || s === '-' || s === '') return { status: 'Discarded' };

  const canonical = [
    'Evaluated', 'Applied', 'Responded', 'Interview',
    'Offer', 'Rejected', 'Discarded', 'SKIP',
  ];
  for (const c of canonical) {
    if (lower === c.toLowerCase()) return { status: c };
  }

  const aliases = {
    submitted: 'Applied',
    sent: 'Applied',
    to_apply: 'Evaluated',
    'to apply': 'Evaluated',
    watch: 'Evaluated',
    watching: 'Evaluated',
    under_review: 'Evaluated',
    screening: 'Interview',
    phone_screen: 'Interview',
    onsite: 'Interview',
    final_round: 'Interview',
    offered: 'Offer',
    declined_by_company: 'Rejected',
    no_apply: 'SKIP',
    'no apply': 'SKIP',
    monitor: 'SKIP',
    hold: 'SKIP',
    cancelled: 'Discarded',
    canceled: 'Discarded',
    closed: 'Discarded',
    duplicate: 'Discarded',
    repost: 'Discarded',
  };
  if (aliases[lower]) return { status: aliases[lower] };

  return { status: null, unknown: true };
}

if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to normalize.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

let changes = 0;
let unknowns = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('|')) continue;

  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) continue;
  if (parts[1] === '#' || parts[1] === '---' || parts[1] === '') continue;

  const num = parseInt(parts[1]);
  if (isNaN(num)) continue;

  const rawStatus = parts[6];
  const result = normalizeStatus(rawStatus);

  if (result.unknown) {
    unknowns.push({ num, rawStatus, line: i + 1 });
    continue;
  }

  if (result.status === rawStatus) continue;

  const oldStatus = rawStatus;
  parts[6] = result.status;

  if (result.moveToNotes && parts[9]) {
    const existing = parts[9] || '';
    if (!existing.includes(result.moveToNotes)) {
      parts[9] = result.moveToNotes + (existing ? '. ' + existing : '');
    }
  } else if (result.moveToNotes && !parts[9]) {
    parts[9] = result.moveToNotes;
  }

  if (parts[5]) {
    parts[5] = parts[5].replace(/\*\*/g, '');
  }

  lines[i] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
  changes++;
  console.log(`#${num}: "${oldStatus}" → "${result.status}"`);
}

if (unknowns.length > 0) {
  console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
  for (const u of unknowns) {
    console.log(`  #${u.num} (line ${u.line}): "${u.rawStatus}"`);
  }
}

console.log(`\n📊 ${changes} statuses normalized`);

if (!DRY_RUN && changes > 0) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run -- no changes written)');
} else {
  console.log('✅ No changes needed');
}
