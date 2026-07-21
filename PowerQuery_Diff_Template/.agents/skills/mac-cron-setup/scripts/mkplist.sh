#!/usr/bin/env bash
# mkplist.sh — generate (and optionally load) a launchd LaunchAgent for the
# cases cron cannot cover on macOS: catch-up after sleep, and folder watching.
#
# Usage:
#   mkplist.sh --label com.you.job --command "/abs/script.sh" \
#              [--calendar "H:M" | --interval SECONDS | --watch /abs/dir] \
#              [--out FILE] [--load]
#
#   --calendar H:M     run daily at hour:minute; launchd runs it on wake if missed
#   --interval N       run every N seconds
#   --watch DIR        run whenever DIR's contents change (RunAtLoad disabled)
#   --out FILE         write here (default: ~/Library/LaunchAgents/<label>.plist)
#   --load             load it now with launchctl (reloads if already loaded)
#
# Exactly one of --calendar / --interval / --watch is required.
set -euo pipefail

die() { printf 'mkplist: %s\n' "$*" >&2; exit 1; }

label="" command="" calendar="" interval="" watch="" out="" load=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --label)    label="$2"; shift 2 ;;
    --command)  command="$2"; shift 2 ;;
    --calendar) calendar="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --watch)    watch="$2"; shift 2 ;;
    --out)      out="$2"; shift 2 ;;
    --load)     load=1; shift ;;
    *) die "unknown argument '$1'" ;;
  esac
done

[ -n "$label" ]   || die "missing --label (e.g. com.you.backup)"
[ -n "$command" ] || die "missing --command (absolute path to your script)"
case "$command" in /*) ;; *) die "--command must be an absolute path" ;; esac

# Exactly one trigger.
triggers=0
[ -n "$calendar" ] && triggers=$((triggers+1))
[ -n "$interval" ] && triggers=$((triggers+1))
[ -n "$watch" ]    && triggers=$((triggers+1))
[ "$triggers" -eq 1 ] || die "specify exactly one of --calendar / --interval / --watch"

[ -n "$out" ] || out="${HOME}/Library/LaunchAgents/${label}.plist"

# Build the trigger XML block.
trigger_xml=""
if [ -n "$calendar" ]; then
  case "$calendar" in
    *:*) hh="${calendar%%:*}"; mm="${calendar##*:}" ;;
    *)   die "--calendar must be H:M (e.g. 10:30)" ;;
  esac
  trigger_xml=$(printf '    <key>StartCalendarInterval</key>\n    <dict>\n      <key>Hour</key><integer>%d</integer>\n      <key>Minute</key><integer>%d</integer>\n    </dict>' "$hh" "$mm")
elif [ -n "$interval" ]; then
  trigger_xml=$(printf '    <key>StartInterval</key>\n    <integer>%d</integer>' "$interval")
else
  case "$watch" in /*) ;; *) die "--watch must be an absolute path" ;; esac
  trigger_xml=$(printf '    <key>WatchPaths</key>\n    <array>\n      <string>%s</string>\n    </array>\n    <key>RunAtLoad</key>\n    <false/>\n    <key>ThrottleInterval</key>\n    <integer>10</integer>' "$watch")
fi

mkdir -p "$(dirname "$out")"
log_base="${HOME}/Library/Logs/${label}"

cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${command}</string>
    </array>
${trigger_xml}
    <key>StandardOutPath</key>
    <string>${log_base}.out.log</string>
    <key>StandardErrorPath</key>
    <string>${log_base}.err.log</string>
</dict>
</plist>
EOF

printf 'mkplist: wrote %s\n' "$out"

if [ "$load" -eq 1 ]; then
  # bootout first so a re-run reloads cleanly; ignore "not loaded" errors.
  launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$out"
  printf 'mkplist: loaded %s (logs: %s.{out,err}.log)\n' "$label" "$log_base"
else
  printf 'mkplist: load it with:\n  launchctl bootstrap "gui/$(id -u)" "%s"\n' "$out"
fi
