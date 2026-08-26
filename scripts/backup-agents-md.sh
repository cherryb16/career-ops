#!/usr/bin/env bash
# backup-agents-md.sh — snapshot AGENTS.md to ~/Documents/career-ops-backups/
# whenever it changes. Intended to run on every `git pull` / merge / checkout that
# touches AGENTS.md, or ad hoc.
#
# Usage:
#   scripts/backup-agents-md.sh            # backup only if changed
#   scripts/backup-agents-md.sh --force    # always overwrite the snapshot
set -euo pipefail

REPO="/Users/mac_studio/Documents/Githubv2/career-ops"
SRC="$REPO/AGENTS.md"
DEST_DIR="$HOME/Documents/career-ops-backups"
DEST="$DEST_DIR/AGENTS.md.bak"

FORCE="${1:-}"
mkdir -p "$DEST_DIR"

if [[ ! -f "$SRC" ]]; then
  echo "backup-agents-md: $SRC not found, nothing to do." >&2
  exit 0
fi

if [[ "$FORCE" == "--force" || ! -f "$DEST" ]] || ! cmp -s "$SRC" "$DEST"; then
  cp "$SRC" "$DEST"
  echo "backup-agents-md: snapshot updated -> $DEST ($(date '+%Y-%m-%d %H:%M:%S'))"
else
  echo "backup-agents-md: unchanged, skipping."
fi
