# Mode: apply — Live Application Assistant

Interactive mode for when the candidate is filling out an application form in Chrome. Read what is on screen, load the prior context for the job, and generate tailored answers for each form question.

## Requirements

- **Best with visible Playwright**: In visible mode, the candidate sees the browser and Claude can interact with the page.
- **Without Playwright**: the candidate shares a screenshot or pastes the questions manually.

## Workflow

```
1. DETECT     → Read the active Chrome tab (screenshot/URL/title)
2. IDENTIFY   → Extract company + role from the page
3. SEARCH     → Match against existing reports in reports/
4. LOAD       → Read the full report + Section G (if it exists)
5. COMPARE    → Does the role on screen match the evaluated one? If it changed, warn the user
6. ANALYZE    → Identify ALL visible form questions
7. GENERATE   → Generate a tailored answer for each question
8. PRESENT    → Show formatted answers ready to copy-paste
```

## Step 1 — Detect the Job

**With Playwright:** Take a snapshot of the active page. Read the title, URL, and visible content.

**Without Playwright:** Ask the candidate to:
- Share a screenshot of the form (the Read tool can read images)
- Paste the questions as text
- Or provide the company + role so the context can be located

## Step 2 — Identify and Load Context

1. Extract the company name and role title from the page
2. Search `reports/` by company name (case-insensitive grep)
3. If there is a match, load the full report
4. If Section G exists, load the prior draft answers as a base
5. If there is no match, warn the candidate and offer to run a quick auto-pipeline

## Step 3 — Detect Role Changes

If the role on screen differs from the evaluated one:
- **Warn the candidate**: "The role changed from [X] to [Y]. Do you want me to re-evaluate it or adapt the answers to the new title?"
- **If adapting**: adjust the answers to the new role without re-evaluating
- **If re-evaluating**: run the full A-F evaluation, update the report, and regenerate Section G
- **Update the tracker**: change the role title in `applications.md` if appropriate

## Step 4 — Analyze Form Questions

Identify ALL visible questions:
- Free-text fields (cover letter, why this role, and so on)
- Dropdowns (how did you hear about us, work authorization, and so on)
- Yes/No questions (relocation, visa, availability)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

Classify each question:
- **Already answered in Section G** → adapt the existing answer
- **New question** → generate an answer from the report + `cv.md`

## Step 5 — Generate Answers

For each question, generate an answer using:

1. **Report context**: Use proof points from Block B and STAR stories from Block F
2. **Prior Section G**: If a draft answer exists, use it as a base and refine it
3. **"I'm choosing you" tone**: Use the same framework as auto-pipeline
4. **Specificity**: Reference something concrete from the JD visible on screen
5. **Strongest proof point**: Include one quantified accomplishment from the report or `cv.md` in "Additional info" if that field exists

**Output format:**

```markdown
## Answers for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]
> [Answer ready to copy-paste]

### 2. [Next question]
> [Answer]

...

---

Notes:
- [Any observations about the role, changes, and so on]
- [Customization suggestions the candidate should review]
```

## Step 6 — Post-Apply (Optional)

If the candidate confirms the application was submitted:
1. Update the status in `applications.md` from "Evaluated" to "Applied"
2. Update Section G in the report with the final answers
3. Suggest the next step: `/career-ops contact` for LinkedIn outreach

## Scroll Handling

If the form has more questions than are visible:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process in iterations until the full form is covered
