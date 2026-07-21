#!/usr/bin/env bash
# dirwatch-run.sh — the dispatcher launchd fires when a watched directory changes.
#
#   dirwatch-run.sh <id> <dir> <handler> <recursive:0|1>
#
# launchd's WatchPaths/QueueDirectories tells you *that* a directory changed but
# not *what* changed — the job "runs blind". This script closes that gap: it keeps
# a snapshot (path -> mtime, size) of <dir> and, on each fire, diffs the current
# state against it to compute added / modified / removed files, then invokes
# <handler> once per changed file with the event and path.
#
# The handler receives:
#   $1 = event   (added | modified | removed)
#   $2 = path    (absolute path of the file)
# and the same values in $DIRWATCH_EVENT / $DIRWATCH_FILE, plus $DIRWATCH_ID.
#
# Env:
#   DIRWATCH_HOME        state root (default ~/.dirwatch)
#   DIRWATCH_BASELINE=1  build/refresh the snapshot and exit WITHOUT dispatching
#                        (used at setup so only post-setup changes fire the handler)
set -euo pipefail

ID="${1:?usage: dirwatch-run.sh <id> <dir> <handler> <recursive>}"
DIR="${2:?missing dir}"
HANDLER="${3:?missing handler}"
RECURSIVE="${4:-0}"

STATE_ROOT="${DIRWATCH_HOME:-${HOME}/.dirwatch}"
STATE="${STATE_ROOT}/${ID}"
SNAP="${STATE}/snapshot.tsv"
LOCKDIR="${STATE}/lock"
LOG="${STATE}/dirwatch.log"
mkdir -p "$STATE"

# tab-separated stat format: path \t mtime \t size
FMT="$(printf '%%N\t%%m\t%%z')"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }

# Serialize concurrent fires (launchd can re-fire during a slow run). mkdir is atomic.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  log "skip: another dirwatch-run for '${ID}' is already running"
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

# --- build current snapshot ------------------------------------------------
CUR="$(mktemp "${TMPDIR:-/tmp}/dirwatch.XXXXXX")"
if [ -d "$DIR" ]; then
  if [ "$RECURSIVE" = "1" ]; then
    find "$DIR" -type f -print0
  else
    find "$DIR" -maxdepth 1 -type f -print0
  fi 2>/dev/null | while IFS= read -r -d '' f; do
    stat -f "$FMT" "$f" 2>/dev/null || true
  done | LC_ALL=C sort > "$CUR"
fi

# Baseline mode: adopt current state as the snapshot, dispatch nothing.
if [ "${DIRWATCH_BASELINE:-0}" = "1" ]; then
  mv "$CUR" "$SNAP"
  log "baseline set for '${ID}' ($(wc -l < "$SNAP" | tr -d ' ') files)"
  exit 0
fi

[ -f "$SNAP" ] || : > "$SNAP"

# --- diff snapshot vs current ---------------------------------------------
EVENTS="$(mktemp "${TMPDIR:-/tmp}/dirwatch-ev.XXXXXX")"
awk -F'\t' '
  NR==FNR { m[$1]=$2; s[$1]=$3; prev[$1]=1; next }
          { cur[$1]=1
            if (!($1 in prev))                     print "added\t"    $1
            else if (m[$1]!=$2 || s[$1]!=$3)       print "modified\t" $1
          }
  END     { for (p in prev) if (!(p in cur))       print "removed\t"  p }
' "$SNAP" "$CUR" | LC_ALL=C sort > "$EVENTS"

# Adopt the new snapshot before dispatching, so a handler that itself edits the
# directory does not cause its own edits to re-fire as fresh changes.
mv "$CUR" "$SNAP"

COUNT="$(wc -l < "$EVENTS" | tr -d ' ')"
if [ "$COUNT" = "0" ]; then
  log "fired, no file-level changes for '${ID}'"
  rm -f "$EVENTS"
  exit 0
fi
log "dispatching ${COUNT} change(s) for '${ID}'"

# --- dispatch --------------------------------------------------------------
rc=0
while IFS="$(printf '\t')" read -r ev path; do
  [ -n "$ev" ] || continue
  if DIRWATCH_ID="$ID" DIRWATCH_EVENT="$ev" DIRWATCH_FILE="$path" \
       "$HANDLER" "$ev" "$path" >> "$LOG" 2>&1; then
    log "  ok   ${ev} ${path}"
  else
    log "  FAIL ${ev} ${path} (handler exit $?)"
    rc=1
  fi
done < "$EVENTS"

rm -f "$EVENTS"
exit "$rc"
