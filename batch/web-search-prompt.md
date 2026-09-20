# Web Search Task — Career Ops

You are helping Brayden Cherry find job opportunities at **{{company}}**.

## Task

Search for entry-level positions matching these criteria at {{company}}:
- **Target roles:** Business Analyst, Strategy Analyst, Operations Analyst, Associate Consultant, Associate Product Manager, Program Manager, Junior Consultant, Financial Analyst, Data Analyst, Quantitative Analyst
- **Target level:** Entry level, early career, new graduate, undergraduate (class of 2026 or 2027)
- **Location:** United States (remote, hybrid, or on-site)
- **Excluded:** Senior, Staff, Director, VP, Principal, PhD required, Software Engineer

## Search Query

Use this query to search for relevant postings:
```
{{query}}
```

## Instructions

1. **Search the web** for recent job postings matching the criteria above at {{company}}
2. **Filter results** to only include relevant entry-level positions (skip senior, software engineering, etc.)
3. **For each valid posting**, extract:
   - Job title
   - Company name
   - Location
   - Job URL (direct link to the posting)
   - Posting date (if available)
4. **Format output** as JSON with this structure:
```json
{
  "company": "{{company}}",
  "query": "{{query}}",
  "careers_url": "{{careers_url}}",
  "postings_found": <number_of_postings>,
  "postings": [
    {
      "title": "<job_title>",
      "company": "<company_name>",
      "location": "<location>",
      "url": "<direct_job_url>",
      "date_posted": "<date_if_available>"
    }
  ],
  "notes": "<any_additional_context>"
}
```

## Important

- Only include **entry-level** positions (analyst, associate, APM, etc.)
- Exclude senior/leadership roles and pure software engineering roles
- If no relevant postings are found, return `"postings_found": 0` with an empty array
- Use the careers URL {{careers_url}} as a starting point if search results are sparse
- Prioritize postings from the last 30 days