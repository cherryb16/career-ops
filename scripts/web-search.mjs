#!/usr/bin/env node

/**
 * Web Search Script — Career Ops
 * 
 * Searches for job postings at companies that require web search.
 * Uses Hermes CLI with ONLY the browser tool enabled.
 * 
 * Retry logic: if a company times out, retry with next model in pool.
 * Extended timeout: 300s per attempt, max 2 retries per company.
 * 
 * Model pool (in order of preference):
 *   1. openai-codex/gpt-4o-mini (fast, cheap)
 *   2. anthropic/claude-sonnet-4 (reliable, fast)
 *   3. anthropic/claude-haiku-4 (fast, cheap)
 *   4. meituan/longcat-2.0:free (free, slower)
 *   5. nvidia/nemotron-3-super-120b-a12b:free (free)
 * 
 * Usage: node scripts/web-search.mjs [--limit N] [--company NAME]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HERMES_BIN = resolve(process.env.HERMES_BIN || join(process.env.HOME || '/Users/mac_studio', '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'));

const COMPANY_TIMEOUT = 300000; // 5 minutes per attempt
const MAX_RETRIES = 2; // Max retries per company

// Model pool — tried in order on retry
const MODEL_POOL = [
  { model: 'openai-codex/gpt-4o-mini', provider: 'openai-codex' },
  { model: 'anthropic/claude-sonnet-4', provider: 'anthropic' },
  { model: 'anthropic/claude-haiku-4', provider: 'anthropic' },
  { model: 'meituan/longcat-2.0:free', provider: 'nous' },
  { model: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'nvidia' }
];

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
 * Search using Hermes CLI with browser toolset
 */
function searchWithHermes(company, careersUrl, model, provider) {
  const prompt = buildPrompt(company, careersUrl);

  const args = [
    'chat',
    '--model', model,
    '--toolsets', 'browser',
    '--oneshot',
    '-Q',
    '--run-budget', '180',
    '-q', prompt
  ];

  if (provider) {
    args.push('--provider', provider);
  }

  const result = execFileSync(HERMES_BIN, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout: COMPANY_TIMEOUT,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  return result;
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
function searchCompanyWithRetry(company, careersUrl) {
  let lastError = null;
  const triedModels = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Pick model for this attempt (cycle through pool)
    const modelIndex = attempt % MODEL_POOL.length;
    const { model, provider } = MODEL_POOL[modelIndex];
    
    // Skip if we already tried this model
    if (triedModels.includes(model)) {
      continue;
    }
    triedModels.push(model);

    try {
      const response = searchWithHermes(company, careersUrl, model, provider);
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

  const toProcess = webSearchCompanies.slice(0, limit);
  console.log(`Processing ${toProcess.length} companies with retry logic (max ${MAX_RETRIES} retries)...\n`);

  const results = [];
  const outputDir = join(ROOT, 'data', 'websearch-results');
  mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < toProcess.length; i++) {
    const company = toProcess[i];
    console.log(`[${i + 1}/${toProcess.length}] ${company.name}...`);
    const result = searchCompanyWithRetry(company.name, company.careers_url);
    results.push(result);
    
    const status = result.success 
      ? `${result.postings_found} postings (via ${result.provider}${result.retries > 0 ? `, ${result.retries} retries` : ''})`
      : `FAILED after ${result.retries} retries`;
    console.log(`  Found: ${status}`);

    // Save incrementally
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const incrementalFile = join(outputDir, `websearch-${timestamp}-partial.json`);
    writeFileSync(incrementalFile, JSON.stringify(results, null, 2));
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
  console.log(`Companies searched: ${results.length}`);
  console.log(`Successful: ${successCount}, Failed: ${failCount}, Retried: ${retryCount}`);
  console.log(`Total postings found: ${totalPostings}`);
  console.log(`Model usage: ${Object.entries(modelCounts).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  console.log(`Results saved to: ${outputFile}`);
}

main().catch(err => {
  console.error('Web search failed:', err);
  process.exit(1);
});