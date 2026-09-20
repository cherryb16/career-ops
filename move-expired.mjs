import { moveExpiredPipelineEntries, extractPendingPipelineEntries } from './scripts/career-ops-automation.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const pipeline = readFileSync('data/pipeline.md', 'utf8');
const pending = extractPendingPipelineEntries(pipeline);
console.log('Pending count:', pending.length);

// Parse the liveness output from earlier for expired URLs
const expiredUrls = new Set([
  'https://job-boards.greenhouse.io/anthropic/jobs/5399164008',
  'https://www.amazon.jobs/en/jobs/10519392/data-engineer-aws-dc-central-operations'
]);

const moved = moveExpiredPipelineEntries(pipeline, expiredUrls);
writeFileSync('data/pipeline.md', moved.text);
console.log('Moved', moved.moved, 'expired entries to Processed');