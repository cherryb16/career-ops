# Mode: auto-pipeline — Full Automatic Pipeline

When the user pastes a JD (text or URL) without an explicit sub-command, run the entire pipeline in sequence:

## Step 0 — Extract the JD

If the input is a **URL** (not pasted JD text), use this strategy to extract the content:

**Priority order:**

1. **Playwright (preferred):** Most job portals (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read the JD.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, WeLoveProduct, company career pages).
3. **WebSearch (last resort):** Search the role title + company on secondary portals that index the JD in static HTML.

**If no method works:** Ask the candidate to paste the JD manually or share a screenshot.

**If the input is JD text** (not a URL): use it directly, no fetch needed.

## Step 1 — A-F Evaluation

Execute it exactly like the `evaluate` mode (read `modes/evaluate.md` for all A-F blocks).

## Step 2 — Save Report `.md`

Save the full evaluation in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (see the format in `modes/evaluate.md`).

## Step 3 — Generate PDF

Run the full `pdf` pipeline (read `modes/pdf.md`).

## Step 4 — Draft Application Answers (only if score >= 4.5)

If the final score is >= 4.5, generate draft answers for the application form:

1. **Extract the form questions**: Use Playwright to navigate to the form and take a snapshot. If they cannot be extracted, use the generic questions.
2. **Generate answers** using the tone rules below.
3. **Save them in the report** as section `## G) Draft Application Answers`.

### Generic Questions (use if the form cannot be extracted)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tone for Form Answers

**Position: "I'm choosing you."** The candidate has options and is choosing this company for concrete reasons.

**Tone rules:**
- **Confident without arrogance**: "I've spent the past few years building real analytics, operations, and systems experience during school -- this role is where I want to apply that next"
- **Selective without sounding entitled**: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- **Specific and concrete**: Always reference something REAL from the JD or company, and something REAL from the candidate's experience
- **Direct, no fluff**: 2-4 sentences per answer. No "I'm passionate about..." and no "I would love the opportunity to..."
- **Lead with proof, not claims**: Instead of "I'm great at X", say "I built X that does Y"

**Per-question framework:**
- **Why this role?** → "Your [specific thing] maps directly to [specific thing I built]."
- **Why this company?** → Mention something concrete about the company, team, or business. Only reference the product if that is actually true.
- **Relevant experience?** → Use one quantified proof point. "Built [X] that [metric]."
- **Good fit?** → "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- **How did you hear?** → Be honest: "Found through [portal/scan], evaluated against my criteria, and it scored highest."

**Language**: Always write in the JD language (English by default).

## Step 5 — Update the Tracker

Register the result in `data/applications.md` with all columns, including Report and PDF as `✅`.

**If any step fails**, continue with the remaining steps and mark the failed step as pending in the tracker.
