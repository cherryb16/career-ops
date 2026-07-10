// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Management Consulted provider — fetches jobs via jina.ai markdown proxy
// because the site is Cloudflare-protected for direct HTTP access.
// Source: https://jobs.managementconsulted.com/jobs
// Uses: https://r.jina.ai/http://jobs.managementconsulted.com/jobs (and paginated)

const JINA_BASE = 'https://r.jina.ai/http://jobs.managementconsulted.com/jobs';
const TRUSTED_JINA_HOST = 'r.jina.ai';
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 10;

const JOB_URL_PATTERN = /https:\/\/jobs\.managementconsulted\.com\/jobs\/(\d+)-([^)]+)/g;
const COMPANY_PATTERN = /\]\(https:\/\/jobs\.managementconsulted\.com\/companies\/([^)]+)\)/g;
const LOCATION_PATTERN = /•\[([^\]]+)\]\(https:\/\/jobs\.managementconsulted\.com\/jobs\/in-[^)]+\)/g;
const DATE_PATTERN = /(\d+min ago|\d+hour ago|\d+day ago|\d+week ago)/g;

/** @param {string} url */
function assertJinaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`management-consulted: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`management-consulted: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_JINA_HOST) {
    throw new Error(`management-consulted: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_JINA_HOST}`);
  }
  return url;
}

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function parseRelativeTime(text) {
  const now = Date.now();
  const match = text.match(/(\d+)\s*(min|hour|day|week)s?\s*ago/i);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { min: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000 };
  return now - value * (multipliers[unit] || 0);
}

function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function fetchPage(ctx, page) {
  const url = page === 1 ? JINA_BASE : `${JINA_BASE}?page=${page}`;
  assertJinaUrl(url);
  const text = await ctx.fetchText(url, { redirect: 'error' });
  return text;
}

function parseMarkdownJobs(markdown, fallbackCompany) {
  const jobs = [];
  
  // Find all job entries - they start with ### [Title](url)
  const jobBlocks = markdown.split(/^### /gm).slice(1); // Skip first empty split
  
  for (const block of jobBlocks) {
    // Extract title and URL
    const titleMatch = block.match(/^\[([^\]]+)\]\((https:\/\/jobs\.managementconsulted\.com\/jobs\/\d+-[^)]+)\)/);
    if (!titleMatch) continue;
    
    const title = titleMatch[1].trim();
    const url = titleMatch[2].trim();
    
    // Extract company
    let company = fallbackCompany;
    const companyMatch = block.match(/\]\(https:\/\/jobs\.managementconsulted\.com\/companies\/([^)]+)\)/);
    if (companyMatch) {
      // Decode company name from slug
      /** @type {string} */ const companySlug = companyMatch[1];
      company = companySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    
    // Extract location
    let location = '';
    const locationMatch = block.match(/•\[([^\]]+)\]\(https:\/\/jobs\.managementconsulted\.com\/jobs\/in-[^)]+\)/);
    if (locationMatch) {
      location = locationMatch[1].trim();
    }
    
    // Extract date
    let postedAt = undefined;
    const dateMatch = block.match(/(\d+)\s*(min|hour|day|week)s?\s*ago/i);
    if (dateMatch) {
      postedAt = parseRelativeTime(dateMatch[0]);
    }
    
    // Extract salary if present
    const salaryMatch = block.match(/\$[\d,.]+\s*-\s*\$[\d,.]+\s*\/\s*year/);
    const salary = salaryMatch ? salaryMatch[0] : undefined;
    
    if (title && url) {
      jobs.push({ title, url, company, location, postedAt, salary });
    }
  }
  
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'management-consulted',

  async fetch(entry, ctx) {
    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name || 'Management Consulted';
    const allJobs = [];

    for (let page = 1; page <= maxPages; page++) {
      try {
        const markdown = await fetchPage(ctx, page);
        const jobs = parseMarkdownJobs(markdown, fallbackCompany);
        
        if (jobs.length === 0) break; // No more jobs on this page
        
        allJobs.push(...jobs);
        
        // If we got fewer jobs than expected, might be last page
        if (jobs.length < 20) break;
      } catch (err) {
        console.error(`management-consulted: page ${page} failed — ${err.message}`);
        break;
      }
    }

    return allJobs;
  },
};