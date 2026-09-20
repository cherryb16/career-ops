import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const PIPELINE_FILE = join(ROOT, 'data', 'pipeline.md');
const BATCH_INPUT_FILE = join(ROOT, 'batch', 'batch-input.tsv');

const PENDING_SECTION_RE = /^(pending|pendientes)$/i;
const LABELED_SEGMENT_RE = /^(posted|trust|note|rank)\s*:/i;

const text = readFileSync(PIPELINE_FILE, 'utf8');
const entries = [];
const seen = new Set();
let inPending = false;

for (const rawLine of text.split(/\r?\n/)) {
  const heading = rawLine.match(/^##\s+(.+?)\s*$/);
  if (heading) {
    inPending = PENDING_SECTION_RE.test(heading[1]);
    continue;
  }
  if (!inPending) continue;

  // Match "- [ ] url | company | title | location | ..."
  const item = rawLine.match(/^-\s*\[\s\]\s+(.+?)\s*$/);
  if (!item) continue;

  const cells = item[1].split('|').map((cell) => cell.trim());
  const url = cells[0];
  if (!url || seen.has(url)) continue;
  seen.add(url);

  const positional = cells.slice(1).filter((cell) => !LABELED_SEGMENT_RE.test(cell));
  
  // Skip entries that have already been processed (have report file references or scores)
  const notes = positional.join(' | ');
  if (notes.includes('../reports/') || notes.includes('prior eval') || notes.includes('prior score')) {
    console.log('Skipping already-processed entry:', url);
    continue;
  }
  
  entries.push({
    url,
    company: positional[0] || '',
    title: positional[1] || '',
    location: positional[2] || '',
    raw: rawLine.trim(),
  });
}

console.log(`Found ${entries.length} new pending pipeline entries to evaluate`);

if (entries.length > 0) {
  const clean = (value) => String(value || '').replace(/[\t\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = ['id\turl\tsource\tnotes'];
  entries.forEach((entry, index) => {
    const notes = [entry.company, entry.title, entry.location].map(clean).filter(Boolean).join(' | ');
    rows.push(`${index + 1}\t${clean(entry.url)}\tscheduled-pipeline\t${notes}`);
  });
  writeFileSync(BATCH_INPUT_FILE, `${rows.join('\n')}\n`);
  console.log(`Synced ${entries.length} entries to ${BATCH_INPUT_FILE}`);
} else {
  console.log('No new pending entries to sync');
  // Reset batch state for re-evaluation
  const stateFile = join(ROOT, 'batch', 'batch-state.tsv');
  if (existsSync(stateFile)) {
    const state = readFileSync(stateFile, 'utf8');
    const lines = state.split(/\r?\n/);
    const reset = lines.map((line, index) => {
      if (index === 0 || !line.trim()) return line;
      const cells = line.split('\t');
      if (cells.length < 9) return line;
      if (cells[2] === 'completed' || cells[2] === 'skipped') return line;
      return [cells[0], cells[1], 'pending', '-', '-', '-', '-', '-', '0'].join('\t');
    });
    writeFileSync(stateFile, reset.join('\n'));
    console.log('Batch state reset applied');
  }
}