#!/usr/bin/env bash
# mkwatch.sh — install a launchd LaunchAgent that runs a handler whenever a
# directory changes, dispatching the actual added/modified/removed files to it
# via dirwatch-run.sh (which solves launchd's "runs blind" limitation).
#
# Usage:
#   mkwatch.sh --id NAME --dir /abs/dir --handler /abs/handler.sh \
#              [--mode watch|queue] [--recursive] [--process-existing] \
#              [--out FILE] [--load]
#
#   --id                stable name; used for the label com.dirwatch.<id>
#   --dir               absolute path of the directory to watch
#   --handler           absolute path to your script; called once per changed
#                       file as: handler <event> <path>   (event: added|modified|removed)
#   --mode watch|queue  watch  = fire on ANY change in the dir (default)
#                       queue  = fire only while the dir is NON-EMPTY — the
#                                "drop a file, process it, delete it" spool pattern
#   --recursive         also watch files in subdirectories (diff is recursive;
#                       note the launchd trigger itself is the top dir — see SKILL.md)
#   --process-existing  treat files already in the dir as "added" on first fire
#                       (default: baseline them so only later changes dispatch)
#   --out FILE          write the plist here (default ~/Library/LaunchAgents/<label>.plist)
#   --load              load it now with launchctl (reloads if already loaded)
set -euo pipefail

die() { printf 'mkwatch: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="${SCRIPT_DIR}/dirwatch-run.sh"
[ -f "$RUNNER" ] || die "dirwatch-run.sh not found next to mkwatch.sh"

id="" dir="" handler="" mode="watch" recursive="0" process_existing=0 out="" load=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id)               id="$2"; shift 2 ;;
    --dir)              dir="$2"; shift 2 ;;
    --handler)          handler="$2"; shift 2 ;;
    --mode)             mode="$2"; shift 2 ;;
    --recursive)        recursive="1"; shift ;;
    --process-existing) process_existing=1; shift ;;
    --out)              out="$2"; shift 2 ;;
    --load)             load=1; shift ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[ -n "$id" ]      || die "missing --id"
case "$id" in *[!A-Za-z0-9_.-]*) die "id may only contain letters, digits, '.', '_', '-'";; esac
[ -n "$dir" ]     || die "missing --dir"
case "$dir" in /*) ;; *) die "--dir must be an absolute path" ;; esac
[ -d "$dir" ]     || die "--dir does not exist: $dir"
[ -n "$handler" ] || die "missing --handler"
case "$handler" in /*) ;; *) die "--handler must be an absolute path" ;; esac
[ -x "$handler" ] || die "--handler is not executable: $handler (chmod +x it)"
case "$mode" in watch|queue) ;; *) die "--mode must be 'watch' or 'queue'" ;; esac

label="com.dirwatch.${id}"
[ -n "$out" ] || out="${HOME}/Library/LaunchAgents/${label}.plist"
log_base="${HOME}/Library/Logs/${label}"

case "$mode" in
  watch) trigger_key="WatchPaths" ;;
  queue) trigger_key="QueueDirectories" ;;
esac

mkdir -p "$(dirname "$out")"
cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${RUNNER}</string>
        <string>${id}</string>
        <string>${dir}</string>
        <string>${handler}</string>
        <string>${recursive}</string>
    </array>
    <key>${trigger_key}</key>
    <array>
        <string>${dir}</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${log_base}.out.log</string>
    <key>StandardErrorPath</key>
    <string>${log_base}.err.log</string>
</dict>
</plist>
EOF
printf 'mkwatch: wrote %s\n' "$out"

# Baseline (or, with --process-existing, leave the snapshot empty so current
# files register as "added" on the first fire).
if [ "$process_existing" -eq 1 ]; then
  rm -f "${DIRWATCH_HOME:-${HOME}/.dirwatch}/${id}/snapshot.tsv"
  printf 'mkwatch: existing files will be dispatched as "added" on first change\n'
else
  DIRWATCH_BASELINE=1 "$RUNNER" "$id" "$dir" "$handler" "$recursive"
  printf 'mkwatch: baselined current contents; only later changes will dispatch\n'
fi

if [ "$load" -eq 1 ]; then
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$out"
  printf 'mkwatch: loaded %s (logs: %s.{out,err}.log and ~/.dirwatch/%s/dirwatch.log)\n' "$label" "$log_base" "$id"
else
  printf 'mkwatch: load it with:\n  launchctl bootstrap "gui/$(id -u)" "%s"\n' "$out"
fi
