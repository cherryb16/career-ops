# Mode: scan — Portal Scanner (Offer Discovery)

Scan configured job portals, filter by title relevance, and add new offers to the pipeline for later evaluation.

## Recommended Execution

Run as a sub-agent so it does not consume the main thread's context:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + task-specific data]",
    run_in_background=True
)
```

## Configuration

Read `portals.yml`, which contains:
- `search_queries`: List of WebSearch queries with portal-specific `site:` filters (broad discovery)
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: positive/negative/seniority_boost keywords for title filtering

## Discovery Strategy (3 levels)

### Level 1 — Direct Playwright (PRIMARY)

**For each company in `tracked_companies`:** Navigate to its `careers_url` with Playwright (`browser_navigate` + `browser_snapshot`), read ALL visible job listings, and extract the title + URL for each one. This is the most reliable method because it:
- Sees the page in real time (not cached Google results)
- Works with SPAs (Ashby, Lever, Workday)
- Detects new offers immediately
- Does not depend on Google indexing

**Every company SHOULD have `careers_url` in `portals.yml`.** If it is missing, find it once, save it, and reuse it in future scans.

### Level 2 — Greenhouse API (SUPPLEMENTARY)

For Greenhouse companies, the JSON API (`boards-api.greenhouse.io/v1/boards/{slug}/jobs`) returns clean structured data. Use it as a fast supplement to Level 1 -- it is faster than Playwright but only works with Greenhouse.

### Level 3 — WebSearch Queries (BROAD DISCOVERY)

`search_queries` with `site:` filters cover portals broadly (all Ashby boards, all Greenhouse boards, and so on). Useful for discovering NEW companies not yet in `tracked_companies`, but results may lag behind live listings.

**Execution priority:**
1. Level 1: Playwright → all `tracked_companies` with `careers_url`
2. Level 2: API → all `tracked_companies` with `api:`
3. Level 3: WebSearch → all `search_queries` with `enabled: true`

The levels are additive -- run all of them, merge the results, then deduplicate.

## Workflow

1. **Read configuration**: `portals.yml`
2. **Read history**: `data/scan-history.tsv` → URLs already seen
3. **Read dedup sources**: `data/applications.md` + `data/pipeline.md`

4. **Level 1 — Playwright scan** (parallel in batches of 3-5):
   For each company in `tracked_companies` with `enabled: true` and `careers_url` defined:
   a. `browser_navigate` to the `careers_url`
   b. `browser_snapshot` to read all job listings
   c. If the page has filters/departments, navigate the relevant sections
   d. For each listing extract: `{title, url, company}`
   e. If the page paginates results, navigate additional pages
   f. Accumulate a candidate list
   g. If `careers_url` fails (404, redirect), try `scan_query` as a fallback and note that the URL should be updated

5. **Level 2 — Greenhouse APIs** (parallel):
   For each company in `tracked_companies` with `api:` defined and `enabled: true`:
   a. WebFetch the API URL → JSON with job listings
   b. For each job extract: `{title, url, company}`
   c. Add to the candidate list (dedup against Level 1)

6. **Level 3 — WebSearch queries** (parallel if possible):
   For each query in `search_queries` with `enabled: true`:
   a. Run WebSearch with the configured query
   b. From each result extract: `{title, url, company}`
      - **title**: from the result title (before ` @ ` or ` | `)
      - **url**: result URL
      - **company**: after ` @ ` in the title, or inferred from the domain/path
   c. Add to the candidate list (dedup against Levels 1+2)

7. **Filter by title** using `title_filter` from `portals.yml`:
   - At least 1 keyword from `positive` must appear in the title (case-insensitive)
   - 0 keywords from `negative` may appear
   - `seniority_boost` keywords raise priority but are not required

8. **Deduplicate** against 3 sources:
   - `scan-history.tsv` → exact URL already seen
   - `applications.md` → normalized company + role already evaluated
   - `pipeline.md` → exact URL already pending or processed

9. **For each new offer that passes filters**:
   a. Add to the "Pending" section of `pipeline.md`: `- [ ] {url} | {company} | {title}`
   b. Register in `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

10. **Offers filtered by title**: register them in `scan-history.tsv` with status `skipped_title`
11. **Duplicate offers**: register them with status `skipped_dup`

## Extracting Title and Company from WebSearch Results

WebSearch results typically arrive as `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`.

Portal-specific extraction patterns:
- **Ashby**: `"Strategy & Operations Associate (Remote) @ Acme"` → title: `Strategy & Operations Associate`, company: `Acme`
- **Greenhouse**: `"Business Analyst at Northstar"` → title: `Business Analyst`, company: `Northstar`
- **Lever**: `"Associate Product Manager @ Redwood"` → title: `Associate Product Manager`, company: `Redwood`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Private URLs

If you find a URL that is not publicly accessible:
1. Save the JD in `jds/{company}-{role-slug}.md`
2. Add it to `pipeline.md` as: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` tracks ALL URLs seen:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — Strategy Ops	Strategy & Operations Associate	Acme	added
https://...	2026-02-10	Greenhouse — Analyst	Junior Developer	BigCo	skipped_title
https://...	2026-02-10	Ashby — Strategy Ops	Business Analyst	OldCo	skipped_dup
```

## Output Summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries executed: N
Offers found: N total
Filtered by title: N relevant
Duplicates: N (already evaluated or already in pipeline)
New offers added to pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Run /career-ops pipeline to evaluate the new offers.
```

## `careers_url` Management

Each company in `tracked_companies` should have `careers_url` -- the direct URL to its jobs page. This prevents rediscovering it every time.

**Known platform patterns:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **Custom:** The company's own URL (for example, `https://openai.com/careers`)

**If `careers_url` does not exist** for a company:
1. Try the known platform pattern
2. If that fails, do a quick WebSearch: `"{company}" careers jobs`
3. Navigate with Playwright to confirm it works
4. **Save the discovered URL in `portals.yml`** for future scans

**If `careers_url` returns 404 or redirects:**
1. Note it in the output summary
2. Try `scan_query` as a fallback
3. Mark it for manual update

## `portals.yml` Maintenance

- **ALWAYS save `careers_url`** when you add a new company
- Add new queries as you discover interesting portals or role patterns
- Disable noisy queries with `enabled: false`
- Adjust filtering keywords as target roles evolve
- Add companies to `tracked_companies` when they are worth following closely
- Re-check `careers_url` periodically -- companies do change ATS platforms
