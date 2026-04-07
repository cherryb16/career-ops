# Mode: pipeline — URL Inbox (Second Brain)

Process accumulated job URLs from `data/pipeline.md`. The user adds URLs whenever they want and later runs `/career-ops pipeline` to process all of them.

## Workflow

1. **Read** `data/pipeline.md` → find `- [ ]` items in the "Pending" section
2. **For each pending URL**:
   a. Calculate the next sequential `REPORT_NUM` (read `reports/`, take the highest number + 1)
   b. **Extract the JD** using Playwright (`browser_navigate` + `browser_snapshot`) → WebFetch → WebSearch
   c. If the URL is not accessible → mark it as `- [!]` with a note and continue
   d. **Run the full auto-pipeline**: A-F evaluation → report `.md` → PDF (if score >= 3.0) → tracker
   e. **Move it from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`
3. **If there are 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **At the end**, show a summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## `pipeline.md` Format

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | Business Analyst | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | Strategy Analyst | 2.1/5 | PDF ❌
```

## Smart JD Extraction from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-business-analyst.md` → read `jds/linkedin-business-analyst.md`

## Automatic Numbering

1. List all files in `reports/`
2. Extract the number prefix (for example, `142-medispend...` → 142)
3. New number = highest existing number + 1

## Source Synchronization

Before processing any URL, verify sync:

```bash
node cv-sync-check.mjs
```

If there is a sync issue, warn the user before continuing.
