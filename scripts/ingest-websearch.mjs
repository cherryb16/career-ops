#!/usr/bin/env node
// Ingest web-search results into data/pipeline.md.
//
// scripts/web-search.mjs saves postings for the `scan_method: websearch`
// companies to data/websearch-results/*.json, but nothing read those files, so
// none of those postings ever reached the pipeline. This applies the same
// portals.yml title and location filters the portal scanner uses, drops search
// and listing pages and redacted URLs, and appends the rest through scan.mjs's
// locked, deduplicating appendToPipeline / appendToScanHistory. Safe to run
// every night: postings already in the pipeline or scan history are skipped by
// those functions, and history is only written for postings actually appended.
//
// Usage: node scripts/ingest-websearch.mjs [--dry-run] [--json]
//
// Importing this file runs it. Never import it to inspect it; use --dry-run.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// js-yaml >= 4: load() uses the safe default schema (no function/type
// construction), and portals.yml is the user's own version-controlled config.
import * as yaml from 'js-yaml';
import {
  appendToPipeline,
  appendToScanHistory,
  buildLocationFilter,
  buildTitleFilterWithOverrides,
  PIPELINE_PATH,
} from '../scan.mjs';
import { canonicalJobKey } from '../url-key.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'data', 'websearch-results');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const JSON_OUT = args.includes('--json');
const key = (u) => canonicalJobKey(u) || u;

const portals = yaml.load(readFileSync(join(ROOT, 'portals.yml'), 'utf8')) || {};
const titleOk = buildTitleFilterWithOverrides(portals.title_filter, new Map());
const locationOk = buildLocationFilter(portals.location_filter);
const careersUrls = new Set(
  Object.values(portals.tracked_companies || {})
    .map((c) => String(c?.careers_url || '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean),
);

// A URL whose path ends in a listing/search segment is a results page, not a
// posting; evaluating it wastes a worker (triage marks these "inaccessible").
const LISTING_TAIL = /\/(careers?|jobs?|search-jobs|job-search|jobsearch|openings|positions|vacancies|find-a-role|apply|join(-[a-z]+)*|students?|university|early-careers?)\/?$/i;
function isPostingUrl(url) {
  // Hermes' secret redaction can rewrite a numeric job ID to [PHONE] etc. in
  // the model's output; such a URL points nowhere.
  if (/\[|\]|%5B|%5D/i.test(url)) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const bare = `${u.origin}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  if (careersUrls.has(bare)) return false;
  if (u.pathname === '/' || LISTING_TAIL.test(u.pathname)) return false;
  return true;
}
// A model sometimes nests its whole JSON reply inside a posting's title; the
// title filter would then match a keyword inside that blob.
const plausibleTitle = (t) => t.length > 0 && t.length <= 160 && !/^[[{]/.test(t) && !t.includes('"postings"');

const counts = { files: 0, postings: 0, uniqueUrls: 0, notPosting: 0, titleRejected: 0, locationRejected: 0, candidates: 0, added: 0 };
const byUrl = new Map();
const files = existsSync(RESULTS)
  ? readdirSync(RESULTS).filter((f) => /^websearch-.*\.json$/.test(f) && !f.includes('partial')).sort()
  : [];
for (const f of files) {
  let data;
  try { data = JSON.parse(readFileSync(join(RESULTS, f), 'utf8')); } catch { continue; }
  counts.files += 1;
  for (const r of Array.isArray(data) ? data : []) {
    for (const p of r?.postings || []) {
      counts.postings += 1;
      const url = String(p?.url || '').trim();
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, {
        url,
        company: String(p.company || r.company || '').trim(),
        title: String(p.title || '').trim(),
        location: String(p.location || '').trim(),
        source: 'websearch',
      });
    }
  }
}
counts.uniqueUrls = byUrl.size;

const offers = [];
for (const o of byUrl.values()) {
  if (!plausibleTitle(o.title) || !isPostingUrl(o.url)) { counts.notPosting += 1; continue; }
  if (!titleOk(o.title, o.company)) { counts.titleRejected += 1; continue; }
  if (!locationOk(o.location, o.url)) { counts.locationRejected += 1; continue; }
  offers.push(o);
}
counts.candidates = offers.length;

const pendingKeys = () => {
  if (!existsSync(PIPELINE_PATH)) return new Set();
  const t = readFileSync(PIPELINE_PATH, 'utf8');
  return new Set([...t.matchAll(/^- \[[ x]\] .*?(https?:\/\/[^\s|)\]>]+)/gm)].map((m) => key(m[1])));
};
if (!DRY && offers.length) {
  const before = pendingKeys();
  await appendToPipeline(offers);
  const after = pendingKeys();
  // Record history only for postings this run actually appended, so a posting
  // the pipeline already holds (or refused) never gains a misleading row.
  const appended = offers.filter((o) => after.has(key(o.url)) && !before.has(key(o.url)));
  counts.added = appended.length;
  if (appended.length) await appendToScanHistory(appended, new Date().toISOString().slice(0, 10), 'added');
}

if (JSON_OUT) console.log(JSON.stringify({ dryRun: DRY, ...counts }));
else {
  console.log(`websearch ingest${DRY ? ' (dry run)' : ''}: ${counts.files} result files · ${counts.postings} postings · ${counts.uniqueUrls} unique URLs`);
  console.log(`  dropped: ${counts.notPosting} not a single posting · ${counts.titleRejected} title filter · ${counts.locationRejected} location filter`);
  console.log(`  candidates: ${counts.candidates}${DRY ? '' : ` · added to pipeline: ${counts.added} (rest already in pipeline or scan history)`}`);
}
