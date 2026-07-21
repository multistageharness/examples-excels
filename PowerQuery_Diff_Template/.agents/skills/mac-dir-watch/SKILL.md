---
name: mac-dir-watch
description: Run a script automatically whenever files in a directory change on macOS — and, unlike a bare launchd WatchPaths agent, tell the script exactly WHICH files were added, modified, or removed. Installs a launchd LaunchAgent wired to a snapshot-diff dispatcher, so your handler is called once per changed file with the event type and path. Supports a "watch" mode (fire on any change) and a "queue"/spool mode (fire only while a drop folder is non-empty), recursive watching, and a baseline so you only react to changes made after setup. Use when asked to watch a folder, trigger on file drop, auto-process an inbox/spool directory, or run something on file save. Extends mac-cron-setup's launchd path.
license: MIT
compatibility: macOS (zsh/bash 3.2+). Uses only launchd, find, stat, awk — nothing to install.
metadata:
  role: entry-point
dependencies:
  - mac-cron-setup
---

# mac-dir-watch

Trigger a script when a directory's files change. This is the extended sibling of
[`mac-cron-setup`](../mac-cron-setup/SKILL.md): that skill's `mkplist.sh --watch` installs a bare
launchd `WatchPaths` agent, but launchd tells the job only *that* the directory changed, never
*what* changed — the handler "runs blind". This skill closes that gap. Paths below are relative to
this skill's directory.

```
   file dropped/edited/deleted in DIR
                │
                ▼
        launchd  (WatchPaths or QueueDirectories on DIR)
                │  fires — but names no file
                ▼
     scripts/dirwatch-run.sh   ← snapshots DIR, diffs vs last snapshot
                │
     added / modified / removed  (one call per file)
                ▼
        your handler:  handler <event> <path>
```

## Set it up — `scripts/mkwatch.sh`

```bash
# handler is called once per changed file: handler <event> <path>
scripts/mkwatch.sh --id ingest --dir /Users/Shared/Drop --handler /Users/Shared/x/on_change.sh --load
```

Options:

| Flag | Meaning |
| --- | --- |
| `--id NAME` | stable name; becomes the launchd label `com.dirwatch.<id>` |
| `--dir /abs/dir` | directory to watch (must exist, absolute) |
| `--handler /abs/h.sh` | your script, **executable**, absolute path |
| `--mode watch` *(default)* | fire on **any** change in the directory |
| `--mode queue` | fire only while the directory is **non-empty** — the drop/spool pattern |
| `--recursive` | diff files in subdirectories too (caveat below) |
| `--process-existing` | treat files already present as `added` on the first fire |
| `--load` | load the agent now with `launchctl` |

Without `--process-existing`, setup **baselines** the current contents, so only changes made
*after* setup are dispatched.

## What your handler receives

Per changed file, the handler is invoked as `handler <event> <path>` with matching env vars:

| | value |
| --- | --- |
| `$1` / `$DIRWATCH_EVENT` | `added` · `modified` · `removed` |
| `$2` / `$DIRWATCH_FILE` | absolute path of the file |
| `$DIRWATCH_ID` | the watch id |

Minimal handler:

```bash
#!/bin/sh
# on_change.sh
case "$1" in
  added|modified) echo "process $2" ;;
  removed)        echo "clean up after $2" ;;
esac
```

`chmod +x` it — `mkwatch.sh` refuses a non-executable handler.

## watch vs queue — pick by intent

- **`watch`** (`WatchPaths`) — react to edits/additions/deletions in a directory you otherwise
  leave in place: a source tree, a config dir, an export folder. Fires on any change.
- **`queue`** (`QueueDirectories`) — a **spool / inbox**: files are dropped in, your handler
  processes each and **deletes it**. launchd keeps re-firing *as long as the directory is
  non-empty*, so nothing sits unprocessed. Your handler must remove files it has handled or it
  will loop.

## Managing the agent

```bash
launchctl print "gui/$(id -u)/com.dirwatch.ingest"     # status
launchctl bootout "gui/$(id -u)/com.dirwatch.ingest"   # stop/unload
tail -f ~/.dirwatch/ingest/dirwatch.log                # per-file dispatch log
tail -f ~/Library/Logs/com.dirwatch.ingest.err.log     # launchd stderr
```

State (the snapshot the diff is computed against) lives in `~/.dirwatch/<id>/`. Delete that
directory to reset; the next fire re-baselines. Override the location with `DIRWATCH_HOME`.

## Three caveats that will bite you

**Recursive watching is diffed recursively but *triggered* shallowly.** `--recursive` makes the
snapshot-diff include files in subdirectories, so when the agent fires you get nested changes too.
But launchd's `WatchPaths` on a directory reliably fires only for changes to that directory's own
entries — a change **deep** inside a subtree may not wake the agent on its own. For guaranteed deep
triggering, either watch each subdirectory (one agent per path) or add a periodic fallback poll
(`mac-cron-setup`'s `mkplist.sh --interval` calling `dirwatch-run.sh`). Native launchd cannot watch
a whole tree recursively; a real recursive FS watcher (`fswatch`, requires install) is the only
full fix.

**The handler runs with a bare environment.** launchd does not source your shell profile. Use
absolute paths inside the handler and set `PATH` yourself if you call non-system tools.

**Editors and copies fire more than once.** Saving a file can produce several filesystem events
(write temp → rename), and a large copy fires while still in progress. The dispatcher already
diffs to real per-file changes and `ThrottleInterval` (10s) rate-limits the agent, but make your
handler **idempotent** — safe to run twice on the same file.

## Related skills

[`mac-cron-setup`](../mac-cron-setup/SKILL.md) — time-based cron jobs and the general launchd
generator (`mkplist.sh`) this skill specializes. Use it for "every day at 10:30"; use this for
"whenever this folder changes".
