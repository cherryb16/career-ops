# Mode: deep — Deep Research Prompt

Generate a structured prompt for Perplexity/Claude/ChatGPT across 6 axes:

```markdown
## Deep Research: [Company] — [Role]

Context: I am evaluating a candidacy for [role] at [company]. I need actionable interview research.

### 1. Business and Strategic Context
- What does the company actually sell, and to whom?
- What are its core growth drivers, margin pressures, or operational bottlenecks?
- What does leadership say the company is focused on right now?
- Why might this role matter to the business at this moment?

### 2. Recent Moves (last 6-12 months)
- Relevant hiring in strategy, ops, analytics, product, or field roles?
- Acquisitions or partnerships?
- Product launches or pivots?
- Funding rounds or leadership changes?

### 3. Team and Role Context
- Where does this team sit in the org?
- What backgrounds do people in similar roles tend to have?
- What does success likely look like in the first 6-12 months?
- How much client exposure, cross-functional work, or travel is likely involved?

### 4. Operating Culture
- How do they make decisions?
- Is the culture more analytical, client-service oriented, operator-heavy, or product-led?
- Remote-first, hybrid, or office-first?
- What do Glassdoor, Reddit, or public reviews say about pace, leadership, and development?

### 5. Competitors and Differentiation
- Who are their main competitors?
- What is their moat/differentiator?
- How do they position themselves vs the competition?

### 6. Candidate Angle
Given my profile (read from `cv.md`, `config/profile.yml`, and `modes/_profile.md` for specific experience):
- What unique value do I bring to this team?
- Which of my experiences are most relevant?
- How should I position being a BYU Marriott student with real client, analytics, and operations experience?
- What story should I tell in the interview?
```

Customize each section with the specific context of the evaluated offer and the detected archetype.
