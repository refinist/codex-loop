# Scheduling contract

The Node.js helper implements deterministic state transitions. Model judgment only determines task actions and dynamic delay; no heuristic in the scheduler substitutes for that judgment.

- Leading integer duration wins over a trailing `every` clause. Seconds round up to minutes. Invalid zero durations fail before saving state.
- Minute steps use the nearest divisor of 60; hour steps use the nearest divisor of 24. Ties round up, an explicit implementation choice where Claude leaves the choice to the model. Thus `7m` becomes `6m`; `90m` becomes `2h`.
- Day steps use day-of-month cron and reset at month boundaries. They are not exact elapsed durations. Intervals above 31 days are rejected. Cadence and rounding are returned at creation.
- Five-field numeric cron supports wildcards, steps, lists, ranges, Sunday 0/7, and DOM/DOW OR when neither field starts with `*`. Extended aliases (`MON`, `L`, `W`, `?`) are rejected. IANA timezone is stored in state. Nonexistent DST wall times are skipped, repeated wall times are eligible twice.
- An interval request fires immediately. An explicit `--cron` behaves like scheduling a task and waits for its first fire. `--once` requires `--cron` and expires after one execution.
- A fixed recurring run has a stable per-job offset bounded by half the next cron gap and 30 minutes. Uneven gaps use their own bound. `*/5 * * * *` uses 285 seconds from the preceding claim; this reproduces cadence, not a guarantee of Codex cache behavior.
- One-shot cron times on `:00`/`:30` are advanced by up to 90 seconds, never before creation. Other minutes are unchanged.
- Only one claimed job runs per state file. Due jobs coalesce: after lengthy work, execute once, then compute from the actual new start. No accumulated backlog replay.
- Dynamic continuation is 60–3600 seconds **after completion**; it has no jitter. Event wakeups can advance the deadline. Fixed scheduling is anchored at the preceding claim and is independent of task duration.
- Recurring jobs have seven-day lifetimes. In a live driver, the first due run claimed after expiry is final. Reopening a closed driver removes already-expired jobs instead of firing them.
- A successful dynamic tick lacking a scheduling decision gets one 1,200-second fallback. An explicit continuation resets that fallback allowance. The standalone driver only applies this when the process completed successfully but supplied no result file; malformed decisions block for inspection.
- Completion must match an active lease. Cancellation invalidates it, so late results cannot restart canceled jobs. State writes use file locking, atomic replacement, and mode 0600 on POSIX; Windows uses inherited directory ACLs. Locks use atomic directory creation on all platforms.
- There can be at most 50 active jobs. Stopped and blocked records are retained for inspection. They are not queued work.

CLI state is pinned to its original project path; creation from another path fails. The runner uses that saved project, even when invoked from a different directory. Moving a state file does not retarget the project.
