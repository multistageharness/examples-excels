#!/usr/bin/env bash
# cronctl.sh — manage macOS user cron jobs idempotently.
#
# Every job this tool writes is tagged with a marker comment so it can be
# added, replaced, or removed by id without disturbing hand-written entries:
#
#     # cronctl:<id>
#     <schedule> <command>
#
# Subcommands:
#   add     --id NAME --schedule "M H D M W" --command "CMD"  [--force]
#   remove  --id NAME
#   list
#   show                     # print the raw crontab
#   test    --id NAME        # run the job's command once, now (does not touch cron)
#   doctor                   # check cron is installed and warn about Full Disk Access
#
# Notes
#   * Operates on the *current user's* crontab (`crontab -l`/`crontab -`), never root's.
#   * Backs the crontab up to ~/.cronctl/backups before every mutation.
#   * Idempotent: re-adding an existing id replaces that entry only.
set -euo pipefail

BACKUP_DIR="${HOME}/.cronctl/backups"

die()  { printf 'cronctl: %s\n' "$*" >&2; exit 1; }
warn() { printf 'cronctl: %s\n' "$*" >&2; }

# --- helpers ---------------------------------------------------------------

# Read the current crontab, tolerating the "no crontab for user" case (exit 1).
read_crontab() {
  crontab -l 2>/dev/null || true
}

backup_crontab() {
  mkdir -p "$BACKUP_DIR"
  # Timestamp via the filesystem; `date` is fine here (this is a shell tool, not
  # a workflow script). Use a stable, sortable name.
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local content
  content="$(read_crontab)"
  if [ -n "$content" ]; then
    printf '%s\n' "$content" > "${BACKUP_DIR}/crontab-${ts}.bak"
  fi
}

# Validate a 5-field cron schedule (minute hour dom month dow). Loose check:
# exactly five whitespace-separated fields, each using only cron-legal chars.
validate_schedule() {
  local sched="$1"
  # shellcheck disable=SC2086
  set -- $sched
  [ "$#" -eq 5 ] || die "schedule must have exactly 5 fields (got $#): '$sched'"
  local f
  for f in "$@"; do
    case "$f" in
      *[!0-9,\-\*/A-Za-z]*) die "illegal character in schedule field '$f'" ;;
    esac
  done
}

require_id() {
  [ -n "${1:-}" ] || die "missing --id"
  case "$1" in
    *[!A-Za-z0-9_.-]*) die "id may only contain letters, digits, '.', '_', '-'" ;;
  esac
}

# Emit the crontab with the block for <id> removed. Reads stdin, writes stdout.
# A managed block is the marker line `# cronctl:<id>` plus the single line after it.
strip_block() {
  local id="$1"
  awk -v marker="# cronctl:${id}" '
    skip == 1 { skip = 0; next }        # drop the command line following the marker
    $0 == marker { skip = 1; next }     # drop the marker line, arm skip
    { print }
  '
}

# --- subcommands -----------------------------------------------------------

cmd_add() {
  local id="" sched="" command="" force=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --id)       id="$2"; shift 2 ;;
      --schedule) sched="$2"; shift 2 ;;
      --command)  command="$2"; shift 2 ;;
      --force)    force=1; shift ;;
      *) die "add: unknown argument '$1'" ;;
    esac
  done
  require_id "$id"
  [ -n "$sched" ]   || die "missing --schedule"
  [ -n "$command" ] || die "missing --command"
  validate_schedule "$sched"

  local current
  current="$(read_crontab)"

  if printf '%s\n' "$current" | grep -qF "# cronctl:${id}"; then
    [ "$force" -eq 1 ] || die "id '${id}' already exists (use --force to replace)"
  fi

  backup_crontab

  # Rebuild: existing crontab minus any block for this id, then append the new one.
  {
    printf '%s\n' "$current" | strip_block "$id" | sed '/^$/d'  # drop blank noise from empty crontab
    printf '# cronctl:%s\n' "$id"
    printf '%s %s\n' "$sched" "$command"
  } | crontab -

  printf 'cronctl: installed job "%s": %s %s\n' "$id" "$sched" "$command"
  warn "if the command touches Desktop/Documents/Downloads or external volumes, run 'cronctl.sh doctor' — cron needs Full Disk Access."
}

cmd_remove() {
  local id=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --id) id="$2"; shift 2 ;;
      *) die "remove: unknown argument '$1'" ;;
    esac
  done
  require_id "$id"

  local current
  current="$(read_crontab)"
  printf '%s\n' "$current" | grep -qF "# cronctl:${id}" || die "no job with id '${id}'"

  backup_crontab
  printf '%s\n' "$current" | strip_block "$id" | crontab -
  printf 'cronctl: removed job "%s"\n' "$id"
}

cmd_list() {
  local current
  current="$(read_crontab)"
  [ -n "$current" ] || { printf '(no crontab installed)\n'; return 0; }
  printf '%s\n' "$current" | awk '
    /^# cronctl:/ { id = substr($0, 11); getline line; printf "%-24s %s\n", id, line; next }
  ' | { grep . || printf '(no cronctl-managed jobs)\n'; }
}

cmd_show() {
  local current
  current="$(read_crontab)"
  [ -n "$current" ] && printf '%s\n' "$current" || printf '(no crontab installed)\n'
}

cmd_test() {
  local id=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --id) id="$2"; shift 2 ;;
      *) die "test: unknown argument '$1'" ;;
    esac
  done
  require_id "$id"

  # Grab the line after the marker, then strip the 5 schedule fields to leave
  # just the command.
  local cmd
  cmd="$(read_crontab | awk -v marker="# cronctl:${id}" '
    $0 == marker {
      getline
      sub(/^[[:space:]]*([^[:space:]]+[[:space:]]+){5}/, "")
      print
      exit
    }
  ')"
  [ -n "$cmd" ] || die "no job with id '${id}'"
  printf 'cronctl: running "%s" now:\n  %s\n' "$id" "$cmd"
  # Run through a login shell so PATH resembles a real cron run as closely as we can.
  /bin/sh -c "$cmd"
}

cmd_doctor() {
  local ok=0
  if command -v cron >/dev/null 2>&1 || [ -x /usr/sbin/cron ]; then
    printf '[ok]   cron binary present\n'
  else
    printf '[warn] cron binary not found on PATH (try /usr/sbin/cron)\n'; ok=1
  fi

  if crontab -l >/dev/null 2>&1; then
    printf '[ok]   current user has a crontab\n'
  else
    printf '[info] no crontab yet for %s (add one with: cronctl.sh add ...)\n' "$(id -un)"
  fi

  cat <<'EOF'
[note] macOS privacy protection (TCC):
       If a job reads/writes Desktop, Documents, Downloads, or external
       volumes, it will FAIL SILENTLY until cron has Full Disk Access:
         System Settings > Privacy & Security > Full Disk Access > +
         Press Cmd+Shift+G, enter /usr/sbin, choose `cron`, enable it.
[note] cron does NOT run missed jobs after sleep. If the Mac may be asleep
       at the scheduled time and you need catch-up, use launchd instead
       (StartCalendarInterval). See the skill's SKILL.md.
EOF
  return "$ok"
}

# --- dispatch --------------------------------------------------------------

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  [ "$#" -ge 1 ] || { usage; exit 2; }
  local sub="$1"; shift
  case "$sub" in
    add)    cmd_add "$@" ;;
    remove) cmd_remove "$@" ;;
    list)   cmd_list "$@" ;;
    show)   cmd_show "$@" ;;
    test)   cmd_test "$@" ;;
    doctor) cmd_doctor "$@" ;;
    -h|--help|help) usage ;;
    *) die "unknown subcommand '$sub' (try: add remove list show test doctor)" ;;
  esac
}

main "$@"
