import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ROOT, 'batch', 'batch-runner.sh');

test('BATCH_STATE_FILE isolates status output from the shared historical state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-batch-state-'));
  try {
    const state = join(dir, 'state.tsv');
    writeFileSync(
      state,
      [
        'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
        '900001\thttps://example.test/job\tcompleted\t-\t-\t777\t4.6\t-\t0',
        '',
      ].join('\n'),
    );

    const output = execFileSync('/bin/bash', [RUNNER, '--status'], {
      cwd: ROOT,
      env: { ...process.env, BATCH_STATE_FILE: state },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.match(output, /Total: 1\b/);
    assert.match(output, /900001/);
    assert.match(output, /4\.6/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
