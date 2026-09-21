# Career-Ops Batch Runner Operations

## Multi-CLI Support

The batch runner supports multiple CLIs for parallel evaluation:

| CLI | Authentication | Model Used | Permission Mode |
|-----|---------------|------------|-----------------|
| `agy` | keyring/keyringAuth | Gemini 3.8 Flash (Medium) | `--dangerously-skip-permissions` |
| `agy-google` | same as agy | Claude Sonnet 4.6 (Thinking) | `--dangerously-skip-permissions` |
| `agy-other` | same as agy | Claude Sonnet 4.6 (Thinking) | `--dangerously-skip-permissions` |
| `claude` | Claude Code auth | configured model | `--permission-mode auto` |
| `codex` | Codex CLI auth | configured model | default |
| `hermes` | Hermes auth | configured model | `--yolo` |
| `opencode` | OpenCode auth | configured model | default |
| `gemini` | Gemini auth | Gemini models | default |
| `qwen` | Qwen CLI auth | Qwen models | default |

## Common Commands

```bash
# Run batch with AGY CLI (parallel 2, limit 10)
BATCH_INPUT_FILE=/tmp/orphan-urls-fixed.tsv ./batch/batch-runner.sh --cli agy --parallel 2 --limit 10

# Resume paused runs
./batch/batch-runner.sh --cli agy --parallel 2 --limit 10 --resume-paused

# Check current state
cat batch/batch-state.tsv | head

# Check logs
ls batch/logs/ | tail -10
```

## Scratch Directory Output

AGY batch runs write output to the scratch directory:
- **Reports:** `/Users/mac_studio/.gemini/antigravity-cli/scratch/reports/`
- **Tracker additions:** `/Users/mac_studio/.gemini/antigravity-cli/scratch/batch/tracker-additions/`

**Pitfall:** The scratch directory is ephemeral. Reports created by AGI batch runs must be manually copied to `reports/`:
```bash
cp /Users/mac_studio/.gemini/antigravity-cli/scratch/reports/*.md reports/
```

## Git Merge Conflicts

**Pitfall:** The local `batch/batch-runner.sh` may be simplified during git merges, losing multi-CLI support. After merging, verify the script contains all CLI options:

```bash
# Restore from origin if needed
git show origin/main:batch/batch-runner.sh > batch/batch-runner.sh
```

The upstream version supports: `agy`, `agy-google`, `agy-other`, `claude`, `codex`, `hermes`, `opencode`, `gemini`, `qwen`.

## State File Management

The `batch/batch-state.tsv` tracks evaluation status:
- `pending` - not yet processed
- `running` - currently being processed
- `completed` - finished successfully
- `failed` - error occurred

**Pitfall:** Status may be marked `failed` due to auth warnings even when work completed successfully. Check the corresponding `.log` file for completion JSON:
```bash
cat batch/logs/2378-20.log  # Contains status JSON with "status": "completed"
```