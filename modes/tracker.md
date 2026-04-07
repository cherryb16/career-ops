# Mode: tracker — Application Tracker

Read and display `data/applications.md`.

**Tracker format:**
```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
```

Possible states: `Evaluated` → `Applied` → `Responded` → `Interview` → `Offer` / `Rejected` / `Discarded` / `SKIP`

- `Applied` = the candidate submitted the application
- `Responded` = a recruiter/company replied and the candidate answered (inbound)
- `Interview` = the process moved into active interviews

If the user asks to update a status, edit the corresponding row.

Also show statistics:
- Total applications
- Count by status
- Average score
- % with PDF generated
- % with report generated
