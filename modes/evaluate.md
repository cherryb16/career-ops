# Mode: evaluate — Full A-F Evaluation

When the candidate pastes an offer (text or URL), ALWAYS deliver all 6 blocks:

## Step 0 — Archetype Detection

Classify the offer into one of the 6 archetypes (see `_shared.md`). If it is hybrid, list the 2 closest fits. This determines:
- Which proof points to prioritize in Block B
- How to rewrite the summary in Block E
- Which STAR stories to prepare in Block F

## Block A — Role Summary

Create a table with:
- Detected archetype
- Domain (consulting / strategy / analytics / product / operations / solutions)
- Function (analyze / recommend / manage / improve / implement)
- Seniority
- Remote (full/hybrid/onsite)
- Travel / client exposure (if mentioned)
- Team size (if mentioned)
- TL;DR in 1 sentence

## Block B — CV Match

Read `cv.md`. Create a table mapping each JD requirement to exact CV lines.

**Adapted to the archetype:**
- If Management Consulting → prioritize structured problem solving, client communication, slide/storyline thinking, and ambiguity handling
- If Strategy & Operations → prioritize KPI ownership, process improvement, cross-functional execution, and turning analysis into action
- If Business / Data Analyst → prioritize dashboards, SQL/data systems, reporting rigor, stakeholder communication, and automation
- If Associate Product Manager → prioritize customer understanding, prioritization, experimentation, writing, and cross-functional collaboration
- If Operations Manager → prioritize frontline leadership, throughput, staffing, process discipline, and measurable efficiency gains
- If Forward Deployed / Solutions → prioritize client-facing delivery, implementation, adaptability, and translating business needs into systems

Include a **gaps** section with a mitigation strategy for each gap:
1. Is it a hard blocker or a nice-to-have?
2. Can the candidate show adjacent experience?
3. Is there a portfolio project that covers the gap?
4. Concrete mitigation plan (cover letter sentence, quick project, and so on)

## Block C — Level and Strategy

1. **Detected level** in the JD vs the candidate's natural level for that archetype
2. **"Sell readiness without overstating experience" plan**: archetype-specific language, concrete accomplishments to emphasize, and how to position student status as a strength rather than a weakness
3. **"If they want someone more experienced" plan**: show how the candidate already has real operating reps during school, ask about ramp expectations, and assess whether the team is set up to mentor an early-career hire

## Block D — Compensation and Demand

Use WebSearch for:
- Current salaries for the role (Glassdoor, Levels.fyi when relevant, Salary.com, Indeed, and similar sources)
- The company's compensation reputation
- Demand trend for the role

Create a table with the data and cited sources. If no data exists, say so instead of inventing it.

## Block E — Personalization Plan

| # | Section | Current state | Proposed change | Why |
|---|---------|---------------|-----------------|-----|
| 1 | Summary | ... | ... | ... |
| ... | ... | ... | ... | ... |

Top 5 CV changes + Top 5 LinkedIn changes to maximize the match. Prefer honest reframing of existing work over adding new sections unless the evidence is already in `cv.md`.

## Block F — Interview Plan

Create 6-10 STAR+R stories mapped to JD requirements (STAR + **Reflection**):

| # | JD Requirement | STAR+R Story | S | T | A | R | Reflection |
|---|----------------|--------------|---|---|---|---|------------|

The **Reflection** column captures what was learned or what would be done differently. This signals seniority -- junior candidates describe what happened, senior candidates extract lessons.

**Story Bank:** If `interview-prep/story-bank.md` exists, check whether any of these stories are already there. If not, append new ones. Over time this builds a reusable bank of 5-10 master stories that can be adapted to many interview questions.

**Selected and framed by archetype:**
- Management Consulting → emphasize structuring ambiguity, synthesis, recommendations, and executive communication
- Strategy & Operations → emphasize execution, cross-functional coordination, KPI movement, and operating trade-offs
- Business / Data Analyst → emphasize data cleanup, dashboards, analysis quality, and insight-to-action
- Associate Product Manager → emphasize customer problems, prioritization, writing, and experimentation
- Operations Manager → emphasize staffing, throughput, process control, and frontline leadership
- Forward Deployed / Solutions → emphasize discovery, stakeholder trust, implementation speed, and adaptability

Also include:
- 1 recommended case study (which project to present and how)
- Red-flag questions and how to answer them (for example: "you're still in school -- how will you balance this?", "do you have enough experience for this level?", "why consulting / strategy / product?")

---

## Post-Evaluation

**ALWAYS** after generating blocks A-F:

### 1. Save the report `.md`

Save the full evaluation in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

- `{###}` = next sequential number (3 digits, zero-padded)
- `{company-slug}` = lowercase company name, no spaces (use hyphens)
- `{YYYY-MM-DD}` = current date

**Report format:**

```markdown
# Evaluation: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Archetype:** {detected}
**Score:** {X/5}
**URL:** {original offer URL}
**PDF:** {path or pending}

---

## A) Role Summary
(full Block A content)

## B) CV Match
(full Block B content)

## C) Level and Strategy
(full Block C content)

## D) Compensation and Demand
(full Block D content)

## E) Personalization Plan
(full Block E content)

## F) Interview Plan
(full Block F content)

## G) Draft Application Answers
(only if score >= 4.5 — draft answers for the application form)

---

## Extracted Keywords
(list of 15-20 JD keywords for ATS optimization)
```

### 2. Register it in the tracker

**ALWAYS** register it in `data/applications.md`:
- Next sequential number
- Current date
- Company
- Role
- Score: average match score (1-5)
- Status: `Evaluated`
- PDF: `❌` (or `✅` if auto-pipeline generated the PDF)
- Report: relative link to the report `.md` (for example: `[001](reports/001-company-2026-01-01.md)`)

**Tracker format:**

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```
