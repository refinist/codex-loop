"""Deterministic scheduling and durable state; no model or shell execution."""
from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
import uuid
from zoneinfo import ZoneInfo

TTL = 7 * 86400
MAX_TASKS = 50
ACTIVE = {"waiting", "running"}
DEFAULT_PROMPT = (
    "Continue unfinished work already authorized in this conversation. Then tend to "
    "the current branch's PR: review feedback, failed CI, and merge conflicts. If none "
    "is pending, perform a scoped bug hunt or simplification and verify the result. "
    "Do not start unrelated initiatives. Pushing, deleting, publishing, or messaging "
    "requires existing user authorization. If necessary context is absent, report "
    "that limitation; do not invent prior work or permissions."
)


def now() -> float:
    return time.time()


def parse_request(request: str) -> dict:
    text = request.strip()
    for prefix in ("$codex-loop", "/codex-loop", "/loop"):
        if text == prefix or text.startswith(prefix + " ") or text.startswith(prefix + "\n"):
            text = text[len(prefix):].strip()
            break
    interval = None
    match = re.match(r"^(\d+[smhd])(?:\s+|$)", text)
    if match:
        interval, text = match[1], text[match.end():].strip()
    else:
        match = re.search(
            r"(?:^|\s)every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$",
            text, re.I,
        )
        if match:
            interval = match[1] + match[2][0].lower()
            text = text[:match.start()].strip()
    return {"request": request, "prompt": text or None,
            "mode": "fixed" if interval else "dynamic",
            "schedule": interval_schedule(interval) if interval else None}


def interval_schedule(token: str) -> dict:
    match = re.fullmatch(r"(\d+)([smhd])", token)
    if not match or not 0 < int(match[1]) <= 1000000:
        raise ValueError("Interval must be a positive integer followed by s, m, h, or d")
    number, unit = int(match[1]), match[2]
    requested = number * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
    minutes = math.ceil(requested / 60)
    if minutes < 60:
        n = min((1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60), key=lambda x: (abs(x-minutes), -x))
        cron, effective = (f"*/{n} * * * *", n*60) if n < 60 else ("0 * * * *", 3600)
    elif minutes < 1440:
        n = min((1, 2, 3, 4, 6, 8, 12, 24), key=lambda x: (abs(x-minutes/60), -x))
        cron, effective = (f"0 */{n} * * *", n*3600) if n < 24 else ("0 0 * * *", 86400)
    else:
        n = max(1, math.floor(minutes / 1440 + .5))
        if n > 31:
            raise ValueError("Day intervals above 31 cannot be represented by day-of-month cron")
        cron, effective = ("0 0 * * *" if n == 1 else f"0 0 */{n} * *"), n*86400
    return {"cron": cron, "requested_seconds": requested, "effective_seconds": effective,
            "rounded": effective != requested,
            "note": "Day-of-month steps reset at month boundaries" if effective > 86400 else None}


class Cron:
    """Numeric five-field cron, including Vixie DOM/DOW OR semantics."""
    def __init__(self, expression: str):
        self.expression = expression
        fields = expression.split()
        if len(fields) != 5:
            raise ValueError("Cron needs exactly five fields")
        self.dom_star, self.dow_star = fields[2].startswith("*"), fields[4].startswith("*")
        self.values = [self._field(f, lo, hi) for f, (lo, hi) in zip(fields, [(0,59),(0,23),(1,31),(1,12),(0,7)])]
        if 7 in self.values[4]:
            self.values[4].remove(7)
            self.values[4].add(0)

    @staticmethod
    def _field(field, lo, hi):
        values = set()
        for part in field.split(","):
            match = re.fullmatch(r"(\*|\d+(?:-\d+)?)(?:/(\d+))?", part)
            if not match:
                raise ValueError(f"Unsupported cron field: {field}")
            base, step = match[1], int(match[2] or 1)
            if step < 1:
                raise ValueError("Cron step must be positive")
            if base == "*":
                start, end = lo, hi
            elif "-" in base:
                start, end = map(int, base.split("-"))
            else:
                start = int(base)
                end = hi if match[2] else start
            if not lo <= start <= end <= hi:
                raise ValueError(f"Cron field out of range: {field}")
            values.update(range(start, end+1, step))
        return values

    def next(self, after: float, timezone: str) -> float:
        zone = ZoneInfo(timezone)
        start = dt.datetime.fromtimestamp(after, zone).date()
        for offset in range(366*8):
            day = start + dt.timedelta(days=offset)
            if day.month not in self.values[3]:
                continue
            dom, dow = day.day in self.values[2], (day.weekday()+1) % 7 in self.values[4]
            matches = (dom and dow) if self.dom_star or self.dow_star else (dom or dow)
            if not matches:
                continue
            candidates = set()
            for hour in sorted(self.values[1]):
                for minute in sorted(self.values[0]):
                    naive = dt.datetime.combine(day, dt.time(hour, minute))
                    for fold in (0, 1):
                        stamp = naive.replace(tzinfo=zone, fold=fold).timestamp()
                        # Skip nonexistent wall times; include both fall-back occurrences.
                        if stamp > after and dt.datetime.fromtimestamp(stamp, zone).replace(tzinfo=None) == naive:
                            candidates.add(stamp)
            if candidates:
                return min(candidates)
        raise ValueError("Cron has no occurrence within eight years")


def jitter_fraction(job_id: str) -> float:
    return int(hashlib.sha256(job_id.encode()).hexdigest()[:8], 16) / 0xffffffff


def next_fixed(job: dict, after: float, timezone: str) -> float:
    if job["cron"] == "*/5 * * * *" and job["recurring"]:
        return after + 285
    cron = Cron(job["cron"])
    nominal = cron.next(after, timezone)
    if not job["recurring"]:
        minute = dt.datetime.fromtimestamp(nominal, ZoneInfo(timezone)).minute
        return max(after, nominal - jitter_fraction(job["id"])*90) if minute in (0,30) else nominal
    following = cron.next(nominal, timezone)
    delay = min((following - nominal)/2, 1800) * jitter_fraction(job["id"])
    return nominal + delay


def resolve_prompt(job: dict, project: str, codex_home: str | None = None) -> tuple[str, str]:
    if job.get("prompt") is not None:
        return job["prompt"], "explicit"
    home = Path(codex_home or os.environ.get("CODEX_HOME", str(Path.home()/".codex")))
    for path in (Path(project)/".codex"/"loop.md", home/"loop.md"):
        try:
            with path.open("rb") as stream:
                data = stream.read(25001)
        except (FileNotFoundError, IsADirectoryError):
            continue
        text = data[:25000].decode("utf-8", errors="ignore").strip()
        if text:
            if len(data) > 25000:
                text += "\n[loop.md truncated at 25,000 bytes]"
            return text, str(path)
    return DEFAULT_PROMPT, "built-in"


def new_session(project: str, timezone: str) -> dict:
    ZoneInfo(timezone)
    return {"version": 1, "id": uuid.uuid4().hex, "project": str(Path(project).resolve()),
            "timezone": timezone, "created_at": now(), "tasks": {}, "worker_thread": None}


def add_job(state: dict, request: str, stamp: float, cron: str | None = None, once=False) -> dict:
    if sum(j["status"] in ACTIVE for j in state["tasks"].values()) >= MAX_TASKS:
        raise ValueError("A session can hold at most 50 active jobs")
    parsed = parse_request(request)
    if cron:
        Cron(cron)
        if parsed["schedule"]:
            raise ValueError("Supply an interval or --cron, not both")
    if once and not cron:
        raise ValueError("One-shot reminders require --cron")
    job_id = uuid.uuid4().hex[:8]
    while job_id in state["tasks"]:
        job_id = uuid.uuid4().hex[:8]
    job = {**parsed, "id": job_id, "mode": "fixed" if cron else parsed["mode"],
           "cron": cron or (parsed["schedule"] or {}).get("cron"),
           "recurring": not once, "status": "waiting", "created_at": stamp,
           "expires_at": stamp + TTL if not once else None,
           "due_at": stamp, "lease": None, "fallback_used": False,
           "runs": 0, "reason": "Run immediately", "noop_count": 0}
    if cron:  # CronCreate semantics; /loop-style interval requests run immediately.
        job["due_at"] = next_fixed(job, stamp, state["timezone"])
    state["tasks"][job_id] = job
    return job


def disabled() -> bool:
    return os.environ.get("CODEX_LOOP_DISABLE", "").lower() in {"1", "true", "yes"}


def claim(state: dict, stamp: float) -> dict | None:
    if disabled() or any(j["status"] == "running" for j in state["tasks"].values()):
        return None
    jobs = sorted((j for j in state["tasks"].values() if j["status"] == "waiting" and j["due_at"] <= stamp), key=lambda j: (j["due_at"],j["id"]))
    if not jobs:
        return None
    job = jobs[0]
    job.update(status="running", lease=uuid.uuid4().hex, started_at=stamp)
    job["final_fire"] = bool(job["expires_at"] and stamp >= job["expires_at"])
    if job["mode"] == "fixed" and job["recurring"]:
        job["next_at"] = next_fixed(job, stamp, state["timezone"])
    return dict(job)


def validate_decision(decision: dict) -> None:
    if not isinstance(decision, dict) or decision.get("action") not in {"continue", "stop", "blocked", "fallback"}:
        raise ValueError("Expected action continue, stop, blocked, or fallback")
    if not isinstance(decision.get("reason"), str) or not decision["reason"].strip():
        raise ValueError("A nonempty reason is required")
    if type(decision.get("noop")) is not bool:
        raise ValueError("noop must be a boolean")
    delay = decision.get("delay_seconds")
    if decision["action"] == "continue" and (type(delay) is not int or not 60 <= delay <= 3600):
        raise ValueError("A continuation delay must be an integer from 60 to 3600 seconds")


def finish(state: dict, job_id: str, lease: str, decision: dict, stamp: float) -> dict:
    validate_decision(decision)
    job = state["tasks"][job_id]
    if job["status"] != "running" or job["lease"] != lease:
        raise ValueError("Stale completion: task was canceled or this lease does not own it")
    action = decision["action"]
    job.update(lease=None, runs=job["runs"]+1, reason=decision["reason"], finished_at=stamp)
    job["noop_count"] = job["noop_count"] + 1 if decision["noop"] else 0
    if action == "blocked":
        job["status"] = "blocked"
    elif job.get("final_fire") or not job["recurring"] or action == "stop":
        job["status"] = "stopped"
    elif job["mode"] == "fixed":
        job.update(status="waiting", due_at=job["next_at"])
    elif action == "fallback":
        if job["fallback_used"]:
            job.update(status="stopped", reason="No reschedule after the single fallback wakeup")
        else:
            job.update(status="waiting", fallback_used=True, due_at=stamp+1200)
    else:
        job.update(status="waiting", fallback_used=False, due_at=stamp+decision["delay_seconds"])
    return job


def cancel(state: dict, job_id: str, reason="Canceled by user") -> dict:
    job = state["tasks"][job_id]
    job.update(status="stopped", lease=None, reason=reason)
    return job


def wake(state: dict, job_id: str, stamp: float) -> dict:
    job = state["tasks"][job_id]
    if job["mode"] != "dynamic" or job["status"] != "waiting":
        raise ValueError("Only a waiting dynamic task can be woken by an event")
    job.update(due_at=stamp, reason="External event: verify the observed condition")
    return job


def reopen(state: dict, stamp: float) -> None:
    for job in state["tasks"].values():
        if job["status"] not in ACTIVE:
            continue
        if job["mode"] == "dynamic":
            cancel(state, job["id"], "Dynamic loops do not restore after exit; start a new loop")
        elif job["status"] == "running":
            job.update(status="blocked", lease=None, reason="Interrupted execution: inspect effects before retrying")
        elif (job["expires_at"] and stamp >= job["expires_at"]) or (not job["recurring"] and job["due_at"] <= stamp):
            cancel(state, job["id"], "Expired while the session was closed")
        else:
            job["due_at"] = next_fixed(job, stamp, state["timezone"])


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path).absolute()

    @contextlib.contextmanager
    def transaction(self, project: str | None = None, timezone: str = "UTC"):
        # Refuse symlink state paths so task data cannot overwrite an unrelated file.
        for path in (self.path, *self.path.parents):
            if path.is_symlink():
                raise ValueError("State path must not contain symlinks")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock = self.path.with_suffix(self.path.suffix + ".lock")
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "a+") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            if self.path.exists():
                state = json.loads(self.path.read_text())
                if state.get("version") != 1:
                    raise ValueError("Unsupported state version")
                if project and state["project"] != str(Path(project).resolve()):
                    raise ValueError("State belongs to a different project")
            else:
                if project is None:
                    raise ValueError("State does not exist; create a loop first")
                state = new_session(project, timezone)
            yield state
            descriptor, name = tempfile.mkstemp(prefix=".loop-", dir=self.path.parent)
            try:
                with os.fdopen(descriptor, "w") as out:
                    json.dump(state, out, ensure_ascii=False, indent=2, allow_nan=False)
                    out.write("\n")
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(name, self.path)
            finally:
                if os.path.exists(name):
                    os.unlink(name)
