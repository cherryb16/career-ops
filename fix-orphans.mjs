import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this script's location so it works from any checkout path
// (e.g. the iCloud-synced copy on either Mac).
const APPS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'data', 'applications.md');
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

// Remove lines with tracker numbers 2319 and 2331 that have missing reports
const filtered = lines.filter(line => {
  // Check if this line starts with a tracker entry for 2319 or 2331
  const match = line.match(/^\|\s*(\d+)\s*\|/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num === 2319 || num === 2331) {
      console.log('Removing line:', line.substring(0, 100));
      return false;
    }
  }
  return true;
});

writeFileSync(APPS_FILE, filtered.join('\n'));
console.log('Removed orphaned tracker entries 2319 and 2331');