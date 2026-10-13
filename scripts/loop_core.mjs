import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { fileLock, rejectLinks } from "./loop_platform.mjs";
export const TTL = 7 * 86400;
export const ACTIVE = new Set(["waiting", "running"]);
export const now = () => Date.now() / 1000;
const uuid = () => randomUUID().replaceAll("-", "");
export const DEFAULT_PROMPT =
  "Continue unfinished work already authorized in this conversation. Then tend to the current branch's PR: review feedback, failed CI, and merge conflicts. If none is pending, perform a scoped bug hunt or simplification and verify the result. Do not start unrelated initiatives. Pushing, deleting, publishing, or messaging requires existing user authorization. If necessary context is absent, report that limitation; do not invent prior work or permissions.";
export function parseRequest(request) {
  let text = request
    .trim()
    .replace(/^(?:\$codex-loop|\/codex-loop|\/loop)(?:\s+|$)/, "")
    .trim();
  let interval = null;
  let match = text.match(/^(\d+[smhd])(?:\s+|$)/);
  if (match) {
    interval = match[1];
    text = text.slice(match[0].length).trim();
  } else {
    match = text.match(
      /(?:^|\s)every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i,
    );
    if (match) {
      interval = match[1] + match[2][0].toLowerCase();
      text = text.slice(0, match.index).trim();
    }
  }
  return {
    request,
    prompt: text || null,
    mode: interval ? "fixed" : "dynamic",
    schedule: interval ? intervalSchedule(interval) : null,
  };
}
export function intervalSchedule(token) {
  const m = token.match(/^(\d+)([smhd])$/);
  if (!m || +m[1] <= 0 || +m[1] > 1000000)
    throw new Error(
      "Interval must be a positive integer followed by s, m, h, or d",
    );
  const requested = +m[1] * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]],
    minutes = Math.ceil(requested / 60);
  const nearest = (values, target) =>
    values.reduce((a, b) =>
      Math.abs(b - target) <= Math.abs(a - target) ? b : a,
    );
  let cron, effective;
  if (minutes < 60) {
    const n = nearest([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60], minutes);
    cron = n < 60 ? `*/${n} * * * *` : "0 * * * *";
    effective = n * 60;
  } else if (minutes < 1440) {
    const n = nearest([1, 2, 3, 4, 6, 8, 12, 24], minutes / 60);
    cron = n < 24 ? `0 */${n} * * *` : "0 0 * * *";
    effective = n * 3600;
  } else {
    const n = Math.max(1, Math.round(minutes / 1440));
    if (n > 31)
      throw new Error(
        "Day intervals above 31 cannot be represented by day-of-month cron",
      );
    cron = n === 1 ? "0 0 * * *" : `0 0 */${n} * *`;
    effective = n * 86400;
  }
  return {
    cron,
    requested_seconds: requested,
    effective_seconds: effective,
    rounded: effective !== requested,
    note:
      effective > 86400 ? "Day-of-month steps reset at month boundaries" : null,
  };
}
const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        calendar: "gregory",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  return formatters.get(zone);
}
export function wall(stamp, zone) {
  return Object.fromEntries(
    formatter(zone)
      .formatToParts(new Date(stamp * 1000))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
}
const wallStamp = (p) =>
  Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
export class Cron {
  constructor(expression) {
    this.expression = expression;
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) throw new Error("Cron needs exactly five fields");
    this.domStar = fields[2].startsWith("*");
    this.dowStar = fields[4].startsWith("*");
    this.values = fields.map((f, i) =>
      Cron.field(
        f,
        ...[
          [0, 59],
          [0, 23],
          [1, 31],
          [1, 12],
          [0, 7],
        ][i],
      ),
    );
    if (this.values[4].delete(7)) this.values[4].add(0);
  }
  static field(field, lo, hi) {
    const values = new Set();
    for (const part of field.split(",")) {
      const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`Unsupported cron field: ${field}`);
      const step = +(m[2] ?? 1);
      if (!Number.isSafeInteger(step) || step < 1)
        throw new Error("Cron step must be positive");
      let start, end;
      if (m[1] === "*") [start, end] = [lo, hi];
      else if (m[1].includes("-")) [start, end] = m[1].split("-").map(Number);
      else {
        start = +m[1];
        end = m[2] ? hi : start;
      }
      if (!(lo <= start && start <= end && end <= hi))
        throw new Error(`Cron field out of range: ${field}`);
      for (let n = start; n <= end; n += step) values.add(n);
    }
    return values;
  }
  next(after, zone) {
    const local = wall(after, zone),
      start = Date.UTC(local.year, local.month - 1, local.day);
    for (let offset = 0; offset < 366 * 8; offset++) {
      const day = new Date(start + offset * 86400000);
      if (!this.values[3].has(day.getUTCMonth() + 1)) continue;
      const dom = this.values[2].has(day.getUTCDate()),
        dow = this.values[4].has(day.getUTCDay());
      if (!(this.domStar || this.dowStar ? dom && dow : dom || dow)) continue;
      // Sample surrounding UTC days for both offsets at DST transitions. Round-trip
      // every candidate so skipped wall times never fire and repeated times both do.
      const offsets = new Set();
      for (let hour = -48; hour <= 72; hour += 6) {
        const stamp = day.getTime() / 1000 + hour * 3600;
        offsets.add(wallStamp(wall(stamp, zone)) - stamp);
      }
      let best = Infinity;
      for (const hour of this.values[1])
        for (const minute of this.values[0]) {
          const naive = day.getTime() / 1000 + hour * 3600 + minute * 60;
          for (const shift of offsets) {
            const stamp = naive - shift;
            if (
              stamp > after &&
              stamp < best &&
              wallStamp(wall(stamp, zone)) === naive
            )
              best = stamp;
          }
        }
      if (Number.isFinite(best)) return best;
    }
    throw new Error("Cron has no occurrence within eight years");
  }
}
export const jitterFraction = (id) =>
  parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) /
  0xffffffff;
export function nextFixed(job, after, zone) {
  if (job.cron === "*/5 * * * *" && job.recurring) return after + 285;
  const cron = new Cron(job.cron),
    nominal = cron.next(after, zone);
  if (!job.recurring)
    return [0, 30].includes(wall(nominal, zone).minute)
      ? Math.max(after, nominal - jitterFraction(job.id) * 90)
      : nominal;
  return (
    nominal +
    Math.min((cron.next(nominal, zone) - nominal) / 2, 1800) *
      jitterFraction(job.id)
  );
}
export function resolvePrompt(job, project, codexHome) {
  if (job.prompt != null) return [job.prompt, "explicit"];
  const home =
    codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  for (const file of [
    path.join(project, ".codex", "loop.md"),
    path.join(home, "loop.md"),
  ]) {
    let data;
    try {
      const fd = fs.openSync(file, "r");
      try {
        if (!fs.fstatSync(fd).isFile()) continue;
        data = Buffer.alloc(25001);
        data = data.subarray(0, fs.readSync(fd, data));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (["ENOENT", "EISDIR"].includes(error.code)) continue;
      throw error;
    }
    const decoder = new TextDecoder("utf-8");
    let text = decoder
      .decode(data.subarray(0, 25000), { stream: data.length > 25000 })
      .trim();
    if (text) {
      if (data.length > 25000) text += "\n[loop.md truncated at 25,000 bytes]";
      return [text, file];
    }
  }
  return [DEFAULT_PROMPT, "built-in"];
}
export function newSession(project, timezone) {
  formatter(timezone);
  return {
    version: 1,
    id: uuid(),
    project: fs.realpathSync(project),
    timezone,
    created_at: now(),
    tasks: {},
    worker_thread: null,
  };
}
export function addJob(state, request, stamp, cron = null, once = false) {
  if (
    Object.values(state.tasks).filter((j) => ACTIVE.has(j.status)).length >= 50
  )
    throw new Error("A session can hold at most 50 active jobs");
  const parsed = parseRequest(request);
  if (cron) {
    new Cron(cron);
    if (parsed.schedule)
      throw new Error("Supply an interval or --cron, not both");
  }
  if (once && !cron) throw new Error("One-shot reminders require --cron");
  let id;
  do {
    id = uuid().slice(0, 8);
  } while (state.tasks[id]);
  const job = {
    ...parsed,
    id,
    mode: cron ? "fixed" : parsed.mode,
    cron: cron || parsed.schedule?.cron || null,
    recurring: !once,
    status: "waiting",
    created_at: stamp,
    expires_at: once ? null : stamp + TTL,
    due_at: stamp,
    lease: null,
    fallback_used: false,
    runs: 0,
    reason: "Run immediately",
    noop_count: 0,
  };
  if (cron) job.due_at = nextFixed(job, stamp, state.timezone);
  state.tasks[id] = job;
  return job;
}
export const disabled = () =>
  ["1", "true", "yes"].includes(
    (process.env.CODEX_LOOP_DISABLE || "").toLowerCase(),
  );
export function claim(state, stamp) {
  if (
    disabled() ||
    Object.values(state.tasks).some((j) => j.status === "running")
  )
    return null;
  const job = Object.values(state.tasks)
    .filter((j) => j.status === "waiting" && j.due_at <= stamp)
    .sort((a, b) => a.due_at - b.due_at || a.id.localeCompare(b.id))[0];
  if (!job) return null;
  Object.assign(job, {
    status: "running",
    lease: uuid(),
    started_at: stamp,
    final_fire: !!job.expires_at && stamp >= job.expires_at,
  });
  if (job.mode === "fixed" && job.recurring)
    job.next_at = nextFixed(job, stamp, state.timezone);
  return { ...job };
}
export function validateDecision(d) {
  if (!d || !["continue", "stop", "blocked", "fallback"].includes(d.action))
    throw new Error("Expected action continue, stop, blocked, or fallback");
  if (typeof d.reason !== "string" || !d.reason.trim())
    throw new Error("A nonempty reason is required");
  if (typeof d.noop !== "boolean") throw new Error("noop must be a boolean");
  if (
    d.action === "continue" &&
    (!Number.isInteger(d.delay_seconds) ||
      d.delay_seconds < 60 ||
      d.delay_seconds > 3600)
  )
    throw new Error(
      "A continuation delay must be an integer from 60 to 3600 seconds",
    );
}
const getJob = (state, id) => {
  if (!Object.hasOwn(state.tasks, id)) throw new Error(`Unknown job: ${id}`);
  return state.tasks[id];
};
export function finish(state, id, lease, d, stamp) {
  validateDecision(d);
  const job = getJob(state, id);
  if (job.status !== "running" || job.lease !== lease)
    throw new Error(
      "Stale completion: task was canceled or this lease does not own it",
    );
  Object.assign(job, {
    lease: null,
    runs: job.runs + 1,
    reason: d.reason,
    finished_at: stamp,
    noop_count: d.noop ? job.noop_count + 1 : 0,
  });
  if (d.action === "blocked") job.status = "blocked";
  else if (job.final_fire || !job.recurring || d.action === "stop")
    job.status = "stopped";
  else if (job.mode === "fixed")
    Object.assign(job, { status: "waiting", due_at: job.next_at });
  else if (d.action === "fallback") {
    if (job.fallback_used)
      Object.assign(job, {
        status: "stopped",
        reason: "No reschedule after the single fallback wakeup",
      });
    else
      Object.assign(job, {
        status: "waiting",
        fallback_used: true,
        due_at: stamp + 1200,
      });
  } else
    Object.assign(job, {
      status: "waiting",
      fallback_used: false,
      due_at: stamp + d.delay_seconds,
    });
  return job;
}
export function cancel(state, id, reason = "Canceled by user") {
  return Object.assign(getJob(state, id), {
    status: "stopped",
    lease: null,
    reason,
  });
}
export function wake(state, id, stamp) {
  const job = getJob(state, id);
  if (job.mode !== "dynamic" || job.status !== "waiting")
    throw new Error("Only a waiting dynamic task can be woken by an event");
  return Object.assign(job, {
    due_at: stamp,
    reason: "External event: verify the observed condition",
  });
}
export function reopen(state, stamp) {
  for (const job of Object.values(state.tasks)) {
    if (!ACTIVE.has(job.status)) continue;
    if (job.mode === "dynamic")
      cancel(
        state,
        job.id,
        "Dynamic loops do not restore after exit; start a new loop",
      );
    else if (job.status === "running")
      Object.assign(job, {
        status: "blocked",
        lease: null,
        reason: "Interrupted execution: inspect effects before retrying",
      });
    else if (
      (job.expires_at && stamp >= job.expires_at) ||
      (!job.recurring && job.due_at <= stamp)
    )
      cancel(state, job.id, "Expired while the session was closed");
    else job.due_at = nextFixed(job, stamp, state.timezone);
  }
}
export class Store {
  constructor(file) {
    this.path = path.resolve(file);
  }
  async transaction(fn, project = null, timezone = "UTC") {
    rejectLinks(this.path);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const unlock = await fileLock(this.path + ".node-lock");
    let temp;
    try {
      rejectLinks(this.path);
      let state;
      if (fs.existsSync(this.path)) {
        state = JSON.parse(fs.readFileSync(this.path, "utf8"));
        if (state.version !== 1) throw new Error("Unsupported state version");
        if (project && state.project !== fs.realpathSync(project))
          throw new Error("State belongs to a different project");
      } else {
        if (!project)
          throw new Error("State does not exist; create a loop first");
        state = newSession(project, timezone);
      }
      const result = await fn(state);
      const data =
        JSON.stringify(
          state,
          (_key, value) => {
            if (typeof value === "number" && !Number.isFinite(value))
              throw new Error("Non-finite state value");
            return value;
          },
          2,
        ) + "\n";
      temp = path.join(path.dirname(this.path), `.loop-${uuid()}`);
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, data, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.path);
      return result;
    } finally {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      unlock();
    }
  }
}
