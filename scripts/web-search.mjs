#!/usr/bin/env node

/**
 * Web Search Script — Career Ops
 * 
 * Searches for job postings at companies that require web search.
 * Uses Hermes CLI with ONLY the browser tool enabled.
 * 
 * Retry logic: if a company times out, retry with the next model in the pool.
 * Extended timeout: 300s per attempt, max 2 retries per company.
 * Companies run WEBSEARCH_CONCURRENCY (default 3) at a time, least recently
 * searched first, so each night covers different companies.
 *
 * Model pool: free routes first (nous Solar Mini 4, OpenRouter Nemotron 3.5
 * Lightning, NVIDIA NIM Nemotron 3.5 Super VL), then subscription fallbacks
 * (Solstice Gemini 3.5 Flash Lite, Codex GPT-6 Luna). See MODEL_POOL.
 * 
 * Usage: node scripts/web-search.mjs [--limit N] [--company NAME]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HERMES_BIN = resolve(process.env.HERMES_BIN || join(process.env.HOME || homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'));

const COMPANY_TIMEOUT = 300000; // 5 minutes per attempt
const MAX_RETRIES = 2; // Max retries per company
// Companies searched at once. Each worker starts on a different free provider,
// so parallel searches spread across rate limits instead of piling on one.
const CONCURRENCY = Math.max(1, Number(process.env.WEBSEARCH_CONCURRENCY || 3));

// Overall wall-clock budget for the whole sweep. The cron step that calls this
// script (career-ops-automation.mjs, WEBSEARCH EXECUTION) kills it at 30 min,
// which silently truncated every run around company ~20-30 of 76 and discarded
// the partial results. Finish cleanly under that ceiling instead, reporting
// what was actually searched.
const TOTAL_BUDGET_MS = Number(process.env.WEBSEARCH_BUDGET_MS || 25 * 60 * 1000);

// Model pool: free routes first (the same ones the batch fanout uses), then
// subscription (OAuth, no per-token billing) fallbacks. A worker starts at its
// own offset into the free routes and walks forward on retry.
const MODEL_POOL = [
  { model: 'upstage/solar-mini4:free', provider: 'nous' },
  { model: 'nvidia/nemotron-3.5-lightning:free', provider: 'openrouter' },
  { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', provider: 'nvidia' },
  { model: 'gemini-3.5-flash-lite', provider: 'solstice' },
  { model: 'gpt-6-luna', provider: 'openai-codex' }
];
const FREE_ROUTES = 3;

/**
 * Build a structured prompt for job extraction
 */
function buildPrompt(company, careersUrl) {
  return `You are helping Brayden Cherry find job opportunities at **${company}**.

## Your task

1. Navigate to: ${careersUrl}
2. Find entry-level positions matching these criteria:
   - **Roles:** Business Analyst, Strategy Analyst, Operations Analyst, Associate Consultant, Associate Product Manager, Program Manager, Junior Consultant, Financial Analyst, Data Analyst, Quantitative Analyst, Investment Analyst, Deployment Strategist
   - **Level:** Entry level, early career, new graduate, undergraduate, class of 2026/2027
   - **Location:** United States (remote, hybrid, or on-site)
   - **Exclude:** Senior, Staff, Director, VP, Principal, PhD required, Software Engineer, Trust & Safety

3. For each matching posting, extract:
   - Job title
   - Company name
   - Location (city/state or "Remote")
   - Direct URL to the posting (not just the careers homepage)

4. **Important:** If the page uses pagination or "Load More" buttons, click through to find all relevant postings. If the search has filters, use them to narrow to entry-level US roles.

## Output format

Return ONLY a JSON object (no markdown, no prose):

\`\`\`json
{
  "company": "${company}",
  "careers_url": "${careersUrl}",
  "postings_found": <number>,
  "postings": [
    {
      "title": "<job title>",
      "company": "<company name>",
      "location": "<location>",
      "url": "<direct job posting URL>"
    }
  ],
  "notes": "<brief context>"
}
\`\`\`

If no relevant postings are found, return \`"postings_found": 0\` with an empty array and explain why in notes.`;
}

/**
 * Search using Hermes CLI with web research toolset
 *
 * NOTE: `--toolsets browser` looks right but is wrong here. In a headless
 * `--oneshot` run the browser tools that actually navigate (browser_navigate /
 * browser_snapshot) need a live CDP browser session; without one the agent is
 * left holding only the browser_vault_* credential helpers and replies "I don't
 * have the ability to browse web pages", which parsePostings() reads as zero
 * results. Every company scored 0 postings on every cron run because of this.
 * `web` (web_search + web_extract) is the headless-safe toolset and returns
 * real postings.
 */
async function searchWithHermes(company, careersUrl, model, provider) {
  const prompt = buildPrompt(company, careersUrl);

  const args = [
    'chat',
    '--model', model,
    '--toolsets', 'web',
    '--oneshot',
    '-Q',
    '--run-budget', '180',
    '-q', prompt
  ];

  if (provider) {
    args.push('--provider', provider);
  }

  const { stdout } = await execFileAsync(HERMES_BIN, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: COMPANY_TIMEOUT,
    maxBuffer: 16 * 1024 * 1024
  });

  return stdout;
}

/**
 * Parse job postings from agent response
 */
function parsePostings(company, response) {
  if (!response) return [];

  const cleaned = response
    .replace(/session_id:\s*\S+/g, '')
    .replace(/Bitwarden Secrets Manager:.*$/gm, '')
    .replace(/Warning:.*$/gm, '')
    .replace(/⚠️.*$/gm, '')
    .trim();

  // Try JSON code block first
  const codeBlockMatch = cleaned.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed.postings && Array.isArray(parsed.postings)) {
        return parsed.postings.map(p => ({
          title: (p.title || '').trim(),
          company: (p.company || company).trim(),
          location: (p.location || '').trim(),
          url: (p.url || '').trim()
        })).filter(p => p.title && p.url);
      }
    } catch (e) {
      // Fall through
    }
  }

  // Try raw JSON object
  const jsonMatches = cleaned.match(/\{[\s\S]*\}/g);
  if (jsonMatches) {
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonMatches[i]);
        if (parsed.postings && Array.isArray(parsed.postings)) {
          return parsed.postings.map(p => ({
            title: (p.title || '').trim(),
            company: (p.company || company).trim(),
            location: (p.location || '').trim(),
            url: (p.url || '').trim()
          })).filter(p => p.title && p.url);
        }
      } catch (e) {
        continue;
      }
    }
  }

  return [];
}

/**
 * Search for a single company with retry logic
 * Tries each model in the pool until one succeeds
 */
async function searchCompanyWithRetry(company, careersUrl, startAt = 0) {
  let lastError = null;
  const triedModels = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Start at this worker's free route, then walk forward through the pool
    const modelIndex = (startAt + attempt) % MODEL_POOL.length;
    const { model, provider } = MODEL_POOL[modelIndex];
    
    // Skip if we already tried this model
    if (triedModels.includes(model)) {
      continue;
    }
    triedModels.push(model);

    try {
      const response = await searchWithHermes(company, careersUrl, model, provider);
      const postings = parsePostings(company, response);

      return {
        company,
        postings_found: postings.length,
        postings,
        provider: model,
        retries: attempt,
        success: true
      };
    } catch (err) {
      lastError = err;
      // Continue to next retry
    }
  }

  // All retries exhausted
  return {
    company,
    postings_found: 0,
    postings: [],
    provider: 'failed',
    retries: MAX_RETRIES,
    success: false,
    notes: lastError?.message?.substring(0, 100) || 'All retries failed'
  };
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let companyFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--company' && args[i + 1]) {
      companyFilter = args[i + 1];
      i++;
    }
  }

  const portalsPath = join(ROOT, 'portals.yml');
  if (!existsSync(portalsPath)) {
    console.error('portals.yml not found');
    process.exit(1);
  }

  // portals.yml is trusted configuration under version control
  const portalsContent = readFileSync(portalsPath, 'utf8');
  const yaml = await import('js-yaml');
  const portals = yaml.load(portalsContent);

  const webSearchCompanies = [];
  if (portals && portals.tracked_companies) {
    for (const [key, config] of Object.entries(portals.tracked_companies)) {
      if (config?.scan_method === 'websearch') {
        const displayName = config.name || key;
        if (!companyFilter || displayName.toLowerCase().includes(companyFilter.toLowerCase())) {
          webSearchCompanies.push({
            name: displayName,
            query: config.scan_query || '',
            careers_url: config.careers_url || ''
          });
        }
      }
    }
  }

  console.log(`Found ${webSearchCompanies.length} companies requiring web search`);

  if (webSearchCompanies.length === 0) {
    console.log('No companies to search');
    return;
  }

  // Rotate: never-searched companies first, then the least recently searched.
  // The old portals.yml order with a fixed budget re-searched the same first
  // dozen every night and never reached the rest of the list.
  const lastSearched = new Map();
  const resultsDir = join(ROOT, 'data', 'websearch-results');
  if (existsSync(resultsDir)) {
    for (const f of readdirSync(resultsDir).filter((n) => /^websearch-.*\.json$/.test(n)).sort()) {
      const stamp = (f.match(/^websearch-(.+?)(-partial)?\.json$/) || [])[1] || '';
      try {
        for (const r of JSON.parse(readFileSync(join(resultsDir, f), 'utf8'))) {
          if (r?.company && stamp > (lastSearched.get(r.company) || '')) lastSearched.set(r.company, stamp);
        }
      } catch { /* skip unreadable result files */ }
    }
  }
  const ordered = webSearchCompanies
    .map((c, i) => ({ c, i, last: lastSearched.get(c.name) || '' }))
    .sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : a.i - b.i))
    .map((x) => x.c);
  const neverSearched = webSearchCompanies.filter((c) => !lastSearched.has(c.name)).length;

  const toProcess = ordered.slice(0, limit);
  console.log(`Processing ${toProcess.length} companies, ${CONCURRENCY} at a time, least recently searched first (${neverSearched} never searched); max ${MAX_RETRIES} retries each...\n`);

  const results = [];
  const outputDir = resultsDir;
  mkdirSync(outputDir, { recursive: true });

  const startedAt = Date.now();
  let budgetExhausted = false;
  let next = 0;

  const worker = async (w) => {
    while (next < toProcess.length) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) { budgetExhausted = true; return; }
      const i = next++;
      const company = toProcess[i];
      console.log(`[${i + 1}/${toProcess.length}] ${company.name}...`);
      const result = await searchCompanyWithRetry(company.name, company.careers_url, w % FREE_ROUTES);
      results.push(result);

      const status = result.success 
        ? `${result.postings_found} postings (via ${result.provider}${result.retries > 0 ? `, ${result.retries} retries` : ''})`
        : `FAILED after ${result.retries} retries`;
      console.log(`  ${company.name}: ${status}`);

      // Save incrementally
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(outputDir, `websearch-${timestamp}-partial.json`), JSON.stringify(results, null, 2));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toProcess.length) }, (_, w) => worker(w)));
  if (budgetExhausted) {
    console.log(`\nBudget of ${Math.round(TOTAL_BUDGET_MS / 60000)} min reached after ${results.length} companies — stopping cleanly so partial results are saved.`);
  }

  // Save final results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = join(outputDir, `websearch-${timestamp}.json`);
  writeFileSync(outputFile, JSON.stringify(results, null, 2));

  // Summary
  const totalPostings = results.reduce((sum, r) => sum + (r.postings_found || 0), 0);
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const retryCount = results.filter(r => r.retries > 0 && r.success).length;
  const modelCounts = {};
  for (const r of results) {
    if (r.success) {
      const m = r.provider || 'none';
      modelCounts[m] = (modelCounts[m] || 0) + 1;
    }
  }

  console.log(`\n=== Web Search Complete ===`);
  console.log(`Companies searched: ${results.length}${budgetExhausted ? ` of ${toProcess.length} (budget reached)` : ''}`);
  console.log(`Successful: ${successCount}, Failed: ${failCount}, Retried: ${retryCount}`);
  console.log(`Total postings found: ${totalPostings}`);
  console.log(`Model usage: ${Object.entries(modelCounts).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  console.log(`Results saved to: ${outputFile}`);
}

main().catch(err => {
  console.error('Web search failed:', err);
  process.exit(1);
});