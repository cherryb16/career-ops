import { extractPendingPipelineEntries } from './scripts/career-ops-automation.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const pipeline = readFileSync('data/pipeline.md', 'utf8');
const pending = extractPendingPipelineEntries(pipeline);
console.log('Pending count:', pending.length);
writeFileSync('/tmp/liveness-urls.txt', pending.map(e => e.url).join('\n') + '\n');
console.log('Written to /tmp/liveness-urls.txt');