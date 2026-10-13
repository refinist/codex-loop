# Standalone foreground driver

Use when the user requests a separate terminal process. Requirements: macOS/Linux/Windows, Python 3.10+, installed/authenticated Codex CLI with `exec --json --output-schema` and `exec resume`. CLI 0.157.0 argument support was inspected during development.

From a clone of this repository:

```bash
python3 scripts/codex_loop.py --state work/deploy-loop.json create \
  --driver cli --project /absolute/project --timezone Asia/Shanghai \
  'Check the deployment; stop when it succeeds or fails definitively'
python3 scripts/codex_loop.py --state work/deploy-loop.json run
```

`run` stays in the foreground. It starts a new, owned Codex worker and resumes only the ID returned by that worker. It never uses `--last` or an arbitrary UI chat ID. There is no conversation history from the chat that launched it; provide all required context in the prompt or project files. Bare maintenance mode cannot infer unfinished work from another chat.

The default sandbox is read-only; pass `--sandbox workspace-write` when the requested work includes project edits. The driver sets approval policy to `never` because noninteractive permission prompts cannot be answered; it does not bypass sandboxing, hooks, policy rules, or grant missing permissions. Requests needing additional access should return `blocked`. No model override is supplied: Codex uses its configured model. Normal model usage applies on each iteration.

The model returns a structured decision via output schema. Runtime errors, invalid output, nonzero exits, or the default 30-minute iteration timeout block the task without automatic retries. `--timeout` changes that bound. `--max-runs` is an optional cap; reaching it ends the driver and its dynamic loops.

From another terminal, against the same absolute state path:

```bash
python3 scripts/codex_loop.py --state /absolute/work/deploy-loop.json list
python3 scripts/codex_loop.py --state /absolute/work/deploy-loop.json wake JOB_ID
python3 scripts/codex_loop.py --state /absolute/work/deploy-loop.json cancel JOB_ID
```

Cancellation is noticed within a polling interval, terminates the owned worker process group (POSIX) or process tree (Windows), and prevents rescheduling. It cannot undo already executed actions. Ctrl-C stops the foreground driver and its worker. POSIX SIGTERM/SIGHUP and Windows Ctrl-Break are also handled. Forced process termination (including Windows Task Manager / `Stop-Process` and POSIX SIGKILL) cannot run cleanup; on explicit resume an interrupted job is blocked for inspection. Do not background the runner with `nohup` while claiming that closing the user's chat will stop it.

Fixed tasks can be resumed:

```bash
python3 scripts/codex_loop.py --state work/fixed-loop.json run --resume
```

Dynamic jobs are not restored. `create --driver cli` can add another task while a driver is running; the worker processes them serially. Use a new state file for a fresh session. After reviewing a blocked task, create a new explicitly scoped task rather than replaying an uncertain operation automatically.

For low-level current-chat operations, run `python3 scripts/codex_loop.py --help`. `plan '7m check CI'` is read-only and requires no state, authentication, or model calls.

## Windows / PowerShell

Install Python 3.10+, then `py -3 -m pip install tzdata`. Use an installed/authenticated Codex CLI. A standard npm `codex.cmd` installation is launched through its actual Node.js entrypoint without shell interpolation; `node` must be on PATH. Native `codex.exe` is supported via `--codex C:\path\codex.exe`. Arbitrary `.cmd`, `.bat`, or `.ps1` wrappers are rejected; use the native executable instead.

```powershell
py -3 scripts/codex_loop.py --state work/deploy.json create --driver cli --project 'C:\projects\my app' --timezone Asia/Shanghai 'Check deployment and stop when verified'
py -3 scripts/codex_loop.py --state work/deploy.json run
```

Use `cancel JOB_ID` or Ctrl-C to stop cleanly. The driver uses `taskkill /PID <owned-pid> /T /F` to end its Windows worker and descendants; work already performed cannot be undone. Closing a console forcibly is not a cleanup guarantee. File locks use `msvcrt` on Windows and `flock` on POSIX. Windows state files inherit directory ACLs; keep state in a private user directory.
