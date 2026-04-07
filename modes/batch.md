# Mode: batch — Bulk Offer Processing

Two usage modes: **conductor --chrome** (navigates portals in real time) or **standalone** (script for URLs already collected).

## Architecture

```
Claude Conductor (claude --chrome --dangerously-skip-permissions)
  │
  │  Chrome: navigates portals (logged-in sessions)
  │  Reads the live DOM -- the user sees everything in real time
  │
  ├─ Offer 1: reads the JD from the DOM + URL
  │    └─► claude -p worker → report .md + PDF + tracker-line
  │
  ├─ Offer 2: clicks next, reads JD + URL
  │    └─► claude -p worker → report .md + PDF + tracker-line
  │
  └─ End: merge tracker-additions → applications.md + summary
```

Each worker is a child `claude -p` process with a clean 200K-token context. The conductor only orchestrates.

## Files

```
batch/
  batch-input.tsv               # URLs (from the conductor or manual entry)
  batch-state.tsv               # Progress (auto-generated, gitignored)
  batch-runner.sh               # Standalone orchestrator script
  batch-prompt.md               # Prompt template for workers
  logs/                         # One log per offer (gitignored)
  tracker-additions/            # Tracker lines (gitignored)
```

## Mode A: Conductor --chrome

1. **Read state**: `batch/batch-state.tsv` → know what has already been processed
2. **Navigate the portal**: Chrome → search URL
3. **Extract URLs**: read the results DOM → extract a list of URLs → append to `batch-input.tsv`
4. **For each pending URL**:
   a. Chrome: click the offer → read the JD text from the DOM
   b. Save the JD to `/tmp/batch-jd-{id}.txt`
   c. Calculate the next sequential `REPORT_NUM`
   d. Execute via Bash:
      ```bash
      claude -p --dangerously-skip-permissions \
        --append-system-prompt-file batch/batch-prompt.md \
        "Process this offer. URL: {url}. JD: /tmp/batch-jd-{id}.txt. Report: {num}. ID: {id}"
      ```
   e. Update `batch-state.tsv` (completed/failed + score + report_num)
   f. Log to `logs/{report_num}-{id}.log`
   g. Chrome: go back → next offer
5. **Pagination**: If there are no more offers → click "Next" → repeat
6. **Finish**: merge `tracker-additions/` → `applications.md` + summary

## Mode B: Standalone Script

```bash
batch/batch-runner.sh [OPTIONS]
```

Options:
- `--dry-run` -- list pending items without executing
- `--retry-failed` -- retry only failed items
- `--start-from N` -- start from ID N
- `--parallel N` -- N workers in parallel
- `--max-retries N` -- attempts per offer (default: 2)

## `batch-state.tsv` Format

```
id	url	status	started_at	completed_at	report_num	score	error	retries
1	https://...	completed	2026-...	2026-...	002	4.2	-	0
2	https://...	failed	2026-...	2026-...	-	-	Error msg	1
3	https://...	pending	-	-	-	-	-	0
```

## Resumability

- If it dies → rerun it → read `batch-state.tsv` → skip completed items
- Lock file (`batch-runner.pid`) prevents double execution
- Each worker is independent: failure on offer #47 does not affect the rest

## Workers (`claude -p`)

Each worker receives `batch-prompt.md` as the system prompt. It is self-contained.

The worker produces:
1. Report `.md` in `reports/`
2. PDF in `output/`
3. Tracker line in `batch/tracker-additions/{id}.tsv`
4. Result JSON on stdout

## Error Handling

| Error | Recovery |
|-------|----------|
| Unreachable URL | Worker fails → conductor marks `failed`, continue |
| JD behind login | Conductor tries to read the DOM. If it fails → `failed` |
| Portal layout changes | Conductor reasons over the HTML and adapts |
| Worker crashes | Conductor marks `failed`, continue. Retry with `--retry-failed` |
| Conductor dies | Rerun it → read state → skip completed items |
| PDF fails | Report `.md` is still saved. PDF remains pending |
