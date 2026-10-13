#!/usr/bin/env python3
"""Skill scheduler commands. All arguments are data; no shell interpolation."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from loop_core import (Store, add_job, cancel, claim, disabled, finish, now,
                       parse_request, reopen, resolve_prompt, wake)


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--state", type=Path, help="Private JSON state path; use a distinct file per session")
    sub = p.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="Parse without executing or saving")
    plan.add_argument("request", nargs="?", default="")
    create = sub.add_parser("create", help="Register a task; returns its ID and first due time")
    create.add_argument("request", nargs="?", default="")
    create.add_argument("--request-file", type=Path)
    create.add_argument("--project", type=Path, default=Path.cwd())
    create.add_argument("--timezone", default="UTC", help="IANA timezone, e.g. Asia/Shanghai")
    create.add_argument("--cron")
    create.add_argument("--once", action="store_true")
    create.add_argument("--driver", choices=["session", "cli"], default="session")
    sub.add_parser("list")
    sub.add_parser("claim", help="Claim at most one due job; execute it in the CURRENT conversation")
    complete = sub.add_parser("complete")
    complete.add_argument("id")
    complete.add_argument("lease")
    complete.add_argument("--decision-file", type=Path, required=True)
    stop = sub.add_parser("cancel")
    stop.add_argument("id", help="Job ID or all")
    notify = sub.add_parser("wake")
    notify.add_argument("id")
    sub.add_parser("close", help="Stop dynamic jobs; suspend fixed jobs until explicit restore")
    sub.add_parser("restore", help="Restore fixed schedules after reopening; dynamic jobs end")
    run = sub.add_parser("run", help="Run a CLI-owned session in the foreground")
    run.add_argument("--resume", action="store_true")
    run.add_argument("--sandbox", choices=["read-only", "workspace-write"], default="read-only")
    run.add_argument("--timeout", type=float, default=1800)
    run.add_argument("--max-runs", type=int)
    run.add_argument("--codex", default="codex", help="Codex executable path")
    return p


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = parser().parse_args(argv)
    if args.command == "plan":
        result = parse_request(args.request)
    else:
        if args.state is None:
            raise ValueError("--state is required for this command")
        store = Store(args.state)
        if args.command == "run":
            from loop_runner import run
            raise SystemExit(run(store, args.codex, args.sandbox, args.timeout, args.resume, args.max_runs))
        project = str(args.project) if args.command == "create" else None
        with store.transaction(project, getattr(args, "timezone", "UTC")) as state:
            if args.command == "create":
                if disabled():
                    raise ValueError("CODEX_LOOP_DISABLE is set")
                if state.get("closed"):
                    raise ValueError("Session is closed; restore it or use a new state file")
                if state.get("driver") not in (None, args.driver):
                    raise ValueError("Cannot mix session and CLI drivers")
                request = args.request_file.read_text(encoding="utf-8") if args.request_file else args.request
                result = add_job(state, request, now(), args.cron, args.once)
                state["driver"] = args.driver
            elif args.command == "list":
                result = {"session": state["id"], "project": state["project"], "timezone": state["timezone"],
                          "closed": state.get("closed", False), "worker_thread": state["worker_thread"],
                          "tasks": list(state["tasks"].values())}
            elif args.command == "claim":
                if state.get("driver") == "cli":
                    raise ValueError("CLI driver owns this state; use run")
                job = None if state.get("closed") else claim(state, now())
                if job:
                    prompt, source = resolve_prompt(job, state["project"])
                    result = {"task": job, "prompt": prompt, "source": source}
                else:
                    waiting = [j["due_at"] for j in state["tasks"].values() if j["status"] == "waiting"]
                    result = {"task": None, "next_at": min(waiting) if waiting and not state.get("closed") and not disabled() else None,
                              "disabled": disabled()}
            elif args.command == "complete":
                result = finish(state, args.id, args.lease, json.loads(args.decision_file.read_text(encoding="utf-8")), now())
            elif args.command == "cancel":
                ids = list(state["tasks"]) if args.id == "all" else [args.id]
                result = [cancel(state, i) for i in ids]
            elif args.command == "wake":
                if disabled() or state.get("closed"):
                    raise ValueError("Session is disabled or closed")
                result = wake(state, args.id, now())
            elif args.command == "close":
                state["closed"] = True
                for job in state["tasks"].values():
                    if job["mode"] == "dynamic" and job["status"] in {"waiting", "running"}:
                        cancel(state, job["id"], "Session closed")
                result = {"closed": True}
            elif args.command == "restore":
                if state.get("driver") == "cli":
                    raise ValueError("For CLI state use run --resume")
                reopen(state, now())
                state["closed"] = False
                result = {"restored": True, "tasks": list(state["tasks"].values())}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
