---
name: mac-cron-setup
description: Set up, list, replace, remove, and test recurring cron jobs in the current user's crontab on macOS — idempotently, with each job tagged by a stable id and the crontab backed up before every change. Also generates a launchd LaunchAgent for the two things cron cannot do on macOS: run a missed job after the Mac wakes from sleep, and trigger a script when a folder changes. Use when asked to schedule a repeating script/command on a Mac, "add a cron job", automate a periodic task, watch a folder, or when a cron job is silently not running (the Full Disk Access gotcha).
license: MIT
compatibility: macOS (zsh/bash). Uses only the system crontab, launchctl, awk, sed — nothing to install.
metadata:
  role: entry-point
---

# mac-cron-setup

Schedule a repeating command on a Mac. `cron` is the fast path for "run this every day at
10:30"; `launchd` is the right tool for the two cases cron cannot handle. This skill gives you a
safe wrapper for each. Paths below are relative to this skill's directory.

## Decide first: cron or launchd?

| You need… | Use | Why |
| --- | --- | --- |
| Run on a fixed schedule, don't care if a run is skipped during sleep | **cron** (`cronctl.sh`) | One line, instant, no logout needed |
| A missed run to **catch up** after the Mac wakes | **launchd** (`mkplist.sh --calendar`) | cron silently skips jobs that fall during sleep |
| Trigger on a **folder change** | **launchd** (`mkplist.sh --watch`), or [`mac-dir-watch`](../mac-dir-watch/SKILL.md) to know *which* files changed | cron is time-only; it cannot watch paths |
| Run as **root / with no user logged in** | launchd `/Library/LaunchDaemons` (do by hand) | out of scope for these user-level scripts |

Apple deprecated `cron` in favor of `launchd`, but cron still works and is far terser. Prefer it
for ordinary "every day / every hour" jobs; reach for launchd only when the table above says so.

## cron — `scripts/cronctl.sh`

Every job it writes is tagged with a marker comment so it can be added, replaced, or removed **by
id** without disturbing any hand-written crontab entries:

```
# cronctl:<id>
<schedule> <command>
```

```bash
# add (idempotent; re-adding the same id needs --force to replace)
scripts/cronctl.sh add --id backup --schedule "30 10 * * *" --command "/Users/Shared/x/backup.sh"

scripts/cronctl.sh list                 # show only the jobs this tool manages
scripts/cronctl.sh show                 # print the whole raw crontab
scripts/cronctl.sh test --id backup     # run that job's command once, now (does NOT touch cron)
scripts/cronctl.sh remove --id backup
scripts/cronctl.sh doctor               # check cron + warn about Full Disk Access
```

- The schedule is the 5-field cron form: `minute hour day-of-month month day-of-week`
  (`30 10 * * *` = 10:30 every day; `0 * * * *` = top of every hour; `0 0 * * 0` = Sundays midnight).
- Operates on the **current user's** crontab only (`crontab -l` / `crontab -`), never root's.
- Backs the crontab up to `~/.cronctl/backups/` before every mutation.
- `add` validates the schedule and rejects an id collision unless `--force` is given.

**Always use an absolute path** for the script in `--command` — cron runs with a bare `PATH` and
no shell profile. Redirect output if you want a log: `--command "/abs/job.sh >> /abs/job.log 2>&1"`.

## The macOS gotcha that makes cron "silently not work"

If a cron job reads or writes **Desktop, Documents, Downloads, or an external volume**, macOS
privacy protection (TCC) blocks it and the job fails with no error. Grant cron Full Disk Access:

> System Settings → Privacy & Security → **Full Disk Access** → **+** →
> press **Cmd+Shift+G**, enter `/usr/sbin`, choose **`cron`**, enable the toggle.

`scripts/cronctl.sh doctor` prints this reminder along with a cron/crontab health check.

## launchd — `scripts/mkplist.sh`

Generates a LaunchAgent plist in `~/Library/LaunchAgents/` (and can load it). Exactly one trigger:

```bash
# daily at 10:30 — runs on wake if the Mac was asleep at 10:30
scripts/mkplist.sh --label com.you.backup --command /Users/Shared/x/backup.sh --calendar 10:30 --load

# every 900 seconds
scripts/mkplist.sh --label com.you.sync --command /Users/Shared/x/sync.sh --interval 900 --load

# whenever a folder's contents change (RunAtLoad disabled, throttled)
scripts/mkplist.sh --label com.you.ingest --command /Users/Shared/x/ingest.sh --watch /Users/Shared/Drop --load
```

- `--label` uses reverse-DNS naming (`com.you.jobname`); it is the plist's identity.
- `--command` must be an absolute path.
- Without `--load` it just writes the file and prints the `launchctl bootstrap` line to run yourself.
- stdout/stderr are captured to `~/Library/Logs/<label>.{out,err}.log`.
- **Folder watching runs the script "blind"** — launchd does not pass the changed filename as an
  argument. The script must inspect the folder itself to find what changed. If you need to know
  *which* files were added/modified/removed, use the [`mac-dir-watch`](../mac-dir-watch/SKILL.md)
  skill instead — it wires the same launchd trigger to a snapshot-diff dispatcher that calls your
  handler once per changed file with the event and path.

Load / unload / inspect a LaunchAgent manually:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.you.backup.plist   # load
launchctl bootout   "gui/$(id -u)/com.you.backup"                                # unload
launchctl print     "gui/$(id -u)/com.you.backup"                                # status
```

## Two things people get wrong

**cron does not run missed jobs.** If the Mac is asleep at the scheduled minute, that run is gone
— cron never catches up. When catch-up matters, use `mkplist.sh --calendar`; launchd runs the job
on the next wake.

**A relative path or an assumed `PATH` will fail under cron/launchd.** Neither runs your login
shell. Use absolute paths for the interpreter, the script, and anything the script calls, or set
`PATH` explicitly at the top of the script.
