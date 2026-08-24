# Pipeline Cleanup Recipes

Reference for the `career-ops` skill. Detailed recipes for common tracker, batch, and update issues.

## Tracker Column Normalization

The tracker (`data/applications.md`) must be a 12-column table (including leading/trailing pipes = 13 pipe-separated parts). Standard format:

```
| # | Date | Company | Role | Score | Status | Deadline | PDF | Report | Notes |
```

### Detect Column Count Issues

```bash
node -e "
import { readFileSync } from 'fs';
const content = readFileSync('data/applications.md', 'utf-8');
const lines = content.split('\n');
let issues = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length !== 12 && parts.length > 3) {
    console.log('Row with', parts.length, 'columns:', line.substring(0, 100));
    issues++;
  }
}
console.log('\nTotal issues:', issues);
"
```

### Fix Script

```javascript
node -e "
import { readFileSync, writeFileSync } from 'fs';
const content = readFileSync('data/applications.md', 'utf-8');
const lines = content.split('\n');
const result = [];

for (const line of lines) {
  if (!line.startsWith('|')) {
    result.push(line);
    continue;
  }
  let parts = line.split('|').map(s => s.trim());
  
  // Normalize ' |' → '|'
  if (line.startsWith(' |')) {
    result.push('|' + line.slice(2));
    continue;
  }
  
  // 11 columns: insert empty Deadline at index 7
  if (parts.length === 11) {
    parts = [...parts.slice(0, 7), '', ...parts.slice(7)];
  }
  
  // 13 columns: remove trailing empty column
  if (parts.length === 13) {
    parts = parts.slice(0, 12);
  }
  
  if (parts.length === 12) {
    result.push('| ' + parts.slice(1).join(' | ') + ' |');
  } else {
    result.push(line);
  }
}

writeFileSync('data/applications.md', result.join('\n'));
"
```

## Fixing Broken Report Links

Tracker rows referencing non-existent report numbers (e.g., `[050]` but file `reports/050-*.md` doesn't exist).

```javascript
node -e "
import { readFileSync, writeFileSync, readdirSync } from 'fs';
const content = readFileSync('data/applications.md', 'utf-8');
const lines = content.split('\n');
const result = [];

// Collect all existing report numbers
const reportNums = new Set();
for (const f of readdirSync('reports')) {
  const m = f.match(/^(\d+)-/);
  if (m) reportNums.add(parseInt(m[1]));
}

for (const line of lines) {
  if (!line.startsWith('|')) {
    result.push(line);
    continue;
  }
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 10) {
    result.push(line);
    continue;
  }
  
  const reportCol = parts[9] || '';
  const reportMatch = reportCol.match(/\[(\d+)\]/);
  if (reportMatch) {
    const reportNum = parseInt(reportMatch[1]);
    if (!reportNums.has(reportNum)) {
      parts[9] = '❌';
    }
  }
  
  result.push('| ' + parts.slice(1).join(' | ') + ' |');
}

writeFileSync('data/applications.md', result.join('\n'));
"
```

## Deleting Orphan Reports

After normalizing and fixing links, reports still flagged as orphans are stale re-eval duplicates.

```bash
# Identify orphan reports
node verify-pipeline.mjs 2>&1 | grep "Orphan report"

# For each orphan, check if a newer report for the same company+role exists
# If yes, delete the stale one. If no, keep it (it may be the only report).
```

## Batch Input File Format

`batch/batch-input.tsv` MUST use actual tab characters (`\t`), not literal `\t` (backslash-t).

### Detect

```bash
# Literal backslash-t (BAD) — should be 0
grep -c '\\t' batch/batch-input.tsv

# Real tabs (GOOD) — should show consistent field counts
awk -F'\t' '{print NF}' batch/batch-input.tsv | sort | uniq -c
```

### Fix

```bash
sed -i '' 's/\\t/\t/g' batch/batch-input.tsv
```

### Verify

```bash
# Should show 4 fields per line (id, url, source, notes)
awk -F'\t' '{print NF}' batch/batch-input.tsv | sort | uniq -c
```

## Batch Runner Permission Modes

| CLI | Flag | Notes |
|-----|------|-------|
| Claude Code | `--permission-mode auto` | NOT `--dangerously-skip-permissions` |
| Antigravity (agy) | `--dangerously-skip-permissions` | AGY has no `--permission-mode` |
| Hermes | `--yolo` | Plus `--accept-hooks` for shell hooks |

## update-system.mjs Recovery

### Stale Ref Blocking Fetch

```
fatal: bad object refs/heads/main 2
```

```bash
# Remove the stale ref (note the space in filename)
rm ".git/refs/heads/main 2"
# Re-run
node update-system.mjs apply
```

### Index Lock Blocking Commit

```
fatal: Unable to create '.git/index.lock': File exists.
```

```bash
rm .git/index.lock
# The file checkout already ran; manually commit staged changes
git add -A
git commit -m "chore: auto-update system files to vX.Y.Z"
```

### Protecting Custom Files

Add to `config/local-paths.txt` (gitignored, one path per line):
```
providers/management-consulted.mjs
```

Move user-owned directories into `documents/` (a `USER_PATHS` entry):
```
templates/BYU-Specific/ → documents/templates/BYU-Specific/
```

## Consolidating Multiple Batch Input Files

If offers are spread across multiple files (`batch-input.tsv`, `batch-input-2.tsv`, `batch-input-3.tsv`):

```javascript
node -e "
import { readFileSync, writeFileSync } from 'fs';
const files = ['batch/batch-input-2.tsv', 'batch/batch-input-3.tsv', 'batch/batch-input.tsv'];
const seenIds = new Set();
const uniqueLines = [];
let header = null;

for (const f of files) {
  const lines = readFileSync(f, 'utf-8').split('\n');
  if (!header) header = lines[0];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split('\t');
    if (parts[0] && parts[0] !== 'id' && !seenIds.has(parts[0])) {
      seenIds.add(parts[0]);
      uniqueLines.push(line);
    }
  }
}

uniqueLines.sort((a, b) => parseInt(a.split('\t')[0]) - parseInt(b.split('\t')[0]));
writeFileSync('batch/batch-input.tsv', header + '\n' + uniqueLines.join('\n'));
"
```

Then delete the extra files: `rm batch/batch-input-2.tsv batch/batch-input-3.tsv`
