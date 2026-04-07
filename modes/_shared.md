# System Context -- career-ops

<!-- ============================================================
     THIS FILE IS AUTO-UPDATABLE. Do not put personal data here.

     Your customizations go in modes/_profile.md (never auto-updated).
     This file contains system rules, scoring logic, and tool config
     that improve with each career-ops release.
     ============================================================ -->

## Sources of Truth

| File | Path | When |
|------|------|------|
| cv.md | `cv.md` (project root) | ALWAYS |
| article-digest.md | `article-digest.md` (if it exists) | ALWAYS (detailed proof points) |
| profile.yml | `config/profile.yml` | ALWAYS (candidate identity and targets) |
| _profile.md | `modes/_profile.md` | ALWAYS (user archetypes, narrative, negotiation) |

**RULE: NEVER hardcode metrics from proof points.** Read them from `cv.md` + `article-digest.md` at evaluation time.
**RULE: For article/project metrics, `article-digest.md` takes precedence over `cv.md`.**
**RULE: Read `_profile.md` AFTER this file. User customizations in `_profile.md` override the defaults here.**

---

## Scoring System

The evaluation uses 6 blocks (A-F) with a global score of 1-5:

| Dimension | What it measures |
|-----------|------------------|
| CV match | Skills, experience, and proof-point alignment |
| North Star alignment | How well the role fits the user's target archetypes (from `_profile.md`) |
| Compensation | Salary vs market (5 = top quartile, 1 = well below) |
| Cultural signals | Company culture, growth, stability, remote policy |
| Red flags | Blockers and warnings (negative adjustments) |
| **Global** | Weighted average of the above |

**Score interpretation:**
- 4.5+ → Strong match, recommend applying immediately
- 4.0-4.4 → Good match, worth applying
- 3.5-3.9 → Decent but not ideal, apply only if there is a specific reason
- Below 3.5 → Recommend against applying (see Ethical Use in `CLAUDE.md`)

## Archetype Detection

Classify every offer into one of these types (or a hybrid of 2):

| Archetype | Key signals in the JD |
|-----------|-----------------------|
| Management Consulting | "case", "client", "engagement", "workstream", "deck", "associate consultant", "business analyst", "McKinsey", "BCG", "Bain", "Deloitte", "strategy consulting" |
| Strategy & Operations | "strategy & operations", "cross-functional", "go-to-market", "GTM", "operational efficiency", "process improvement", "growth", "scale", "OKR", "KPI" |
| Business / Data Analyst | "SQL", "dashboard", "reporting", "insights", "data-driven", "Power BI", "Tableau", "business intelligence", "analytics", "Excel modeling" |
| Associate Product Manager | "product roadmap", "PRD", "user story", "product manager", "APM", "product strategy", "feature", "discovery", "product-led", "PM" |
| Operations Manager | "operations manager", "area manager", "fulfillment", "logistics", "throughput", "team lead", "shift", "warehouse", "supply chain", "staffing" |
| Forward Deployed / Solutions | "deployment strategist", "forward deployed", "solutions engineer", "client-facing", "implementation", "field", "customer success", "onboarding" |

After detecting the archetype, read `modes/_profile.md` for the user's specific framing and proof points for that archetype.

## Global Rules

### NEVER

1. Invent experience or metrics
2. Modify `cv.md` or portfolio files
3. Submit applications on behalf of the candidate
4. Share a phone number in generated messages
5. Recommend compensation below market rate
6. Generate a PDF without reading the JD first
7. Use corporate-speak
8. Ignore the tracker (every evaluated offer gets registered)

### ALWAYS

0. **Cover letter:** If the form allows it, ALWAYS include one. Use the same visual design as the CV. Map JD quotes to proof points. 1 page max.
1. Read `cv.md`, `_profile.md`, and `article-digest.md` (if it exists) before evaluating
1b. **First evaluation of each session:** Run `node cv-sync-check.mjs`. If there are warnings, notify the user.
2. Detect the role archetype and adapt framing per `_profile.md`
3. Cite exact lines from the CV when matching
4. Use WebSearch for compensation and company data
5. Register the result in the tracker after evaluating
6. Generate content in the language of the JD (English by default)
7. Be direct and actionable -- no fluff
8. Write natural tech English for generated text. Short sentences, active verbs, no passive voice.
8b. Put case study URLs in the PDF Professional Summary when relevant (recruiters may only read this).
9. **Tracker additions as TSV** -- NEVER edit `applications.md` directly when adding a new entry. Write TSV to `batch/tracker-additions/`.
10. **Include `**URL:**` in every report header.**

### Tools

| Tool | Use |
|------|-----|
| WebSearch | Compensation research, trends, company culture, LinkedIn contacts, fallback for JDs |
| WebFetch | Fallback for extracting JDs from static pages |
| Playwright | Verify offers (`browser_navigate` + `browser_snapshot`). **NEVER start 2+ Playwright agents in parallel.** |
| Read | `cv.md`, `_profile.md`, `article-digest.md`, `cv-template.html` |
| Write | Temporary HTML for PDFs, tracker TSVs, and reports |
| Edit | Update existing tracker entries |
| Bash | `node generate-pdf.mjs` |

### Time-to-offer priority

- Working demo + metrics > perfection
- Applying sooner > learning more
- Use an 80/20 approach and timebox everything
