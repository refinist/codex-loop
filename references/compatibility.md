# Claude `/loop` comparison and evidence

Reference date: 2026-10-13. This is an independent implementation for Codex, not Anthropic code and not a native Codex feature. No Claude source, binary, or copied skill prompt is distributed.

## Primary references

- [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks): public behavior and lifecycle reference.
- Locally installed Claude Code **2.1.269**: inspected the bundled loop entrypoint, parsing rules, interval conversion guidance, immediate-run flow, default-file resolution, and dynamic continue/stop decision contract. The inspection informed behavior, not copied implementation. Local feature flags/version can differ from the live docs.
- [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode): JSONL events and output-schema contract.
- Codex CLI **0.157.0**: inspected `exec`, `exec resume`, and their help output to verify flags. Real read-only smoke tests passed: a single iteration returned stop; a two-iteration run waited 60 seconds, resumed the same owned thread, recognized prior context, and stopped. These smoke tasks requested no task-tool calls. Long-duration operation remains unverified.

## Implemented scheduler behavior

| Behavior | Implementation / verification |
|---|---|
| Explicit interval or self-paced mode | Parser and mode tests |
| Leading duration takes priority | Parser tests |
| Trailing `every N units` | Parser tests |
| Non-time `every PR` remains task text | Parser tests |
| Bare / interval-only defaults | Prompt resolution tests |
| First loop iteration runs now | Immediate-fire tests |
| Dynamic 60–3600-second decisions | Validation and completion-relative tests |
| Reason for each decision | Required structured field and runtime reports |
| Explicit stop and blocked state | Lifecycle tests |
| No-op bookkeeping | Consecutive counts; UI collapse is not implemented |
| Single fallback after omitted decision | Fallback/reset tests |
| Seconds rounded to minutes | Interval tests |
| Clean interval rounding | Deterministic nearest-divisor policy; ties up |
| Numeric cron syntax and DOM/DOW semantics | Calendar tests |
| Local timezone and DST behavior | Asia/Shanghai and New York tests |
| Recurring jitter and five-minute special cadence | Timing tests; cache benefits not assumed |
| One-shot reminders | Early/off-hour execution tests |
| Seven-day live expiry | Final-fire tests |
| No overlapping task execution | Leases and cross-process claim tests |
| Missed intervals coalesce | Long-iteration tests |
| Job IDs, list, cancel, 50 active slots | Lifecycle/CLI tests |
| Hot-reloaded project/user defaults, size limit | File precedence and UTF-8 tests |
| Fixed schedule restoration | Restore and interrupted-operation tests |
| Dynamic schedules do not restore | Explicit restore / driver shutdown |
| Disable switch | Registration and claim tests |
| CLI worker context continuity | Owned ID is reused; never `--last` |
| Cancellation during execution | Child process group termination integration test |
| Timeout and process failure | Blocks without blind retry |

## Material differences — do not hide these behind a percentage

1. **Invocation:** `$codex-loop` is the skill entrypoint. A skill cannot register the native `/loop` slash command in Codex's UI. Textual `/loop` can be parsed after dispatch, but dispatch itself belongs to the host.
2. **Between-turn scheduling:** current-chat mode keeps an active turn waiting. It cannot inject low-priority prompts into an idle chat after returning a final answer. The CLI adapter instead owns a separate worker process/session.
3. **Lifecycle integration:** the helper has explicit close/restore commands. It cannot hook Codex UI Escape, app closure, or automatic chat resume. An interrupted active turn has no autonomous timer; stale state does not mean the loop is alive.
4. **Monitor:** `wake` is an external event entrypoint, not Claude's background-script Monitor with notification routing. No watcher is installed automatically.
5. **Tool/context parity:** current-chat mode retains available chat tools; standalone CLI mode uses CLI configuration and an owned worker. It does not inherit desktop-only connectors or originating chat history.
6. **Fallback:** the core implements one fallback when told that a successful tick omitted a decision. It cannot rescue an agent that ends the current-chat turn without invoking any scheduling helper.
7. **Persistence/UI:** terminal records are retained for inspection, rather than disappearing from a native scheduled-task list. There is no native schedule panel or no-op message collapse.
8. **Implementation choices:** `.codex/loop.md` replaces `.claude/loop.md`; interval ties round up; jitter uses our stable hash; IANA timezone is explicit; macOS, Linux, and Windows are supported; Windows needs the `tzdata` package. Windows uses byte-range locks and process-tree termination instead of POSIX primitives. Day steps have month-boundary gaps. No feature-flag or cloud-upsell behavior is reproduced.

The tests establish concrete scheduling and adapter behavior. They do **not** establish 95% product equivalence, identical model judgment, or reliable seven-day uninterrupted execution in a desktop turn. Native scheduling would require a supported host extension or a custom client. These limitations are architecture boundaries, not features a longer skill prompt can supply.
