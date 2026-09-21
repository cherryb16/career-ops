# Batch Runner Git Merge Recovery

## Problem

During git merges, the local `batch/batch-runner.sh` may be simplified (e.g., claude-only version) while the upstream has full multi-CLI support (agy, agy-google, agy-other, claude, codex, hermes, opencode, gemini, qwen).

## Solution

Restore the full multi-CLI version from origin:

```bash
git show origin/main:batch/batch-runner.sh > batch/batch-runner.sh
```

## Verification

After restore, verify the script supports all required CLIs:

```bash
grep -E "case \"\$CLI\"" batch/batch-runner.sh -A 15
```

Expected output should include: `agy`, `agy-google`, `agy-other`, `claude`, `codex`, `hermes`, `opencode`, `gemini`, `qwen`

## Prevention

Consider adding a pre-merge hook or CI check to detect this issue early.