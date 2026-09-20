import { resetNonTerminalBatchRows } from './scripts/career-ops-automation.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const stateFile = 'batch/batch-state.tsv';
if (existsSync(stateFile)) {
  const state = readFileSync(stateFile, 'utf8');
  const reset = resetNonTerminalBatchRows(state);
  writeFileSync(stateFile, reset);
  console.log('Batch state reset applied');
} else {
  console.log('No batch state to reset');
}