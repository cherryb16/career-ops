import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const STATE_FILE = join(ROOT, 'batch', 'batch-state.tsv');

if (existsSync(STATE_FILE)) {
  const state = readFileSync(STATE_FILE, 'utf8');
  const lines = state.split(/\r?\n/);
  const reset = lines.map((line, index) => {
    if (index === 0 || !line.trim()) return line;
    const cells = line.split('\t');
    if (cells.length < 9) return line;
    if (cells[2] === 'completed' || cells[2] === 'skipped') return line;
    return [cells[0], cells[1], 'pending', '-', '-', '-', '-', '-', '0'].join('\t');
  });
  writeFileSync(STATE_FILE, reset.join('\n'));
  console.log('Batch state reset applied');
} else {
  console.log('No batch state to reset');
}