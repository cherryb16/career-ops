# Mode: pdf — ATS-Optimized PDF Generation

## Full Pipeline

1. Read `cv.md` as the source of truth
2. Ask the user for the JD if it is not already in context (text or URL)
3. Extract 15-20 keywords from the JD
4. Detect the JD language → CV language (English by default)
5. Detect company location → paper format:
   - US/Canada → `letter`
   - Rest of world → `a4`
6. Detect the role archetype → adapt the framing
7. Rewrite the Professional Summary by injecting JD keywords + the exit-narrative bridge from `config/profile.yml`
8. Select the top 3-4 most relevant projects for the offer
9. Reorder experience bullets by relevance to the JD
10. Build a competency grid from JD requirements (6-8 keyword phrases)
11. Inject keywords naturally into existing accomplishments (NEVER invent)
12. Generate complete HTML from the template + personalized content
13. Write the HTML to `/tmp/cv-candidate-{company}.html`
14. Run: `node generate-pdf.mjs /tmp/cv-candidate-{company}.html output/cv-candidate-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`
15. Report: PDF path, page count, keyword coverage percentage

## ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS systems ignore them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- JD keywords distributed across: Summary (top 5), first bullet of each role, Skills section

## PDF Design

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500)
- **Fonts self-hosted**: `fonts/`
- **Header**: name in Space Grotesk 24px bold + gradient rule `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + contact row
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing `0.05em`, cyan primary
- **Body**: DM Sans 11px, line-height 1.5
- **Company names**: accent purple `hsl(270,70%,45%)`
- **Margins**: `0.6in`
- **Background**: pure white

## Section Order ("6-second recruiter scan" optimized)

1. Header (large name, gradient, contact, portfolio link)
2. Professional Summary (3-4 lines, keyword-dense)
3. Core Competencies (6-8 keyword phrases in a flex-grid)
4. Work Experience (reverse chronological)
5. Projects (top 3-4 most relevant)
6. Education & Certifications
7. Skills (languages + technical)

## Keyword Injection Strategy (truth-based)

Examples of legitimate rewriting:
- JD says "process improvement" and the CV says "automated recurring reports, saving 20+ hours per month" → rewrite to "process improvement through reporting automation that saved 20+ hours per month"
- JD says "stakeholder management" and the CV says "upskilled 30+ managers and associates" → rewrite to "stakeholder management and enablement across 30+ managers and associates"
- JD says "client delivery" and the CV says "consulting dashboards integrated into Salesforce" → rewrite to "client-facing dashboard delivery and CRM integration work"

**NEVER add skills the candidate does not have. Only rephrase real experience with the JD's exact vocabulary.**

## HTML Template

Use the template in `cv-template.html`. Replace the `{{...}}` placeholders with personalized content:

| Placeholder | Content |
|-------------|---------|
| `{{LANG}}` | `en` |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) or `210mm` (A4) |
| `{{NAME}}` | (from `config/profile.yml`) |
| `{{EMAIL}}` | (from `config/profile.yml`) |
| `{{LINKEDIN_URL}}` | [from `config/profile.yml`] |
| `{{LINKEDIN_DISPLAY}}` | [from `config/profile.yml`] |
| `{{PORTFOLIO_URL}}` | [from `config/profile.yml`] |
| `{{PORTFOLIO_DISPLAY}}` | [from `config/profile.yml`] |
| `{{LOCATION}}` | [from `config/profile.yml`] |
| `{{SECTION_SUMMARY}}` | Professional Summary |
| `{{SUMMARY_TEXT}}` | Personalized summary with keywords |
| `{{SECTION_COMPETENCIES}}` | Core Competencies |
| `{{COMPETENCIES}}` | `<span class="competency-tag">keyword</span>` × 6-8 |
| `{{SECTION_EXPERIENCE}}` | Work Experience |
| `{{EXPERIENCE}}` | HTML for each role with reordered bullets |
| `{{SECTION_PROJECTS}}` | Projects |
| `{{PROJECTS}}` | HTML for the top 3-4 projects |
| `{{SECTION_EDUCATION}}` | Education |
| `{{EDUCATION}}` | Education HTML |
| `{{SECTION_CERTIFICATIONS}}` | Certifications |
| `{{CERTIFICATIONS}}` | Certification HTML |
| `{{SECTION_SKILLS}}` | Skills |
| `{{SKILLS}}` | Skills HTML |

## Post-Generation

Update the tracker if the offer is already registered: change PDF from `❌` to `✅`.
