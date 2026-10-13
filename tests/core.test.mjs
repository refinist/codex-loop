import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as c from "../scripts/loop_core.mjs";
import {
  checkVersion,
  fileLock,
  executablePrefix,
} from "../scripts/loop_platform.mjs";
const d = (action = "continue", delay = 60) => ({
  action,
  delay_seconds: delay,
  reason: "Observed pending work",
  noop: true,
});
const timestamp = (s) => Date.parse(s) / 1000;
const t = timestamp("2026-10-13T00:01:00Z");
const session = () => c.newSession(".", "UTC");
const temporary = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "loop test ")));
for (const [text, mode, prompt] of [
  ["", "dynamic", null],
  ["/loop", "dynamic", null],
  ["$codex-loop check CI", "dynamic", "check CI"],
  ["5m", "fixed", null],
  ["/loop 5m check CI", "fixed", "check CI"],
  ["check CI every 2 hours", "fixed", "check CI"],
  ["check every PR", "dynamic", "check every PR"],
  ["check every 20m", "fixed", "check"],
  ["every 5 minutes", "fixed", null],
  ["5m check every 2 hours", "fixed", "check every 2 hours"],
]) {
  test(`parse ${text}`, () =>
    assert.deepEqual(
      [c.parseRequest(text).mode, c.parseRequest(text).prompt],
      [mode, prompt],
    ));
}
test("interval rounding and invalid intervals", () => {
  for (const [token, seconds] of [
    ["1s", 60],
    ["61s", 120],
    ["7m", 360],
    ["90m", 7200],
    ["5h", 21600],
    ["24h", 86400],
    ["2d", 172800],
  ])
    assert.equal(c.intervalSchedule(token).effective_seconds, seconds);
  for (const token of ["0m", "-1m", "2w", "32d", "1000001s"])
    assert.throws(() => c.intervalSchedule(token));
});
test("multiline shell text is data", () => {
  const text = "check `date` $(touch /tmp/no)\nthen report";
  assert.equal(c.parseRequest(text).prompt, text);
});
test("numeric cron fields", () => {
  const cron = new c.Cron("1,15-19/2 */2 * * 0,7");
  assert.deepEqual(cron.values[0], new Set([1, 15, 17, 19]));
  assert.deepEqual(cron.values[4], new Set([0]));
});
test("invalid and impossible cron", () => {
  for (const text of [
    "* * * *",
    "60 * * * *",
    "*/0 * * * *",
    "0 0 * * MON",
    "0 0 L * *",
    "0 0 31 2 *",
  ])
    assert.throws(() => new c.Cron(text).next(t, "UTC"));
});
for (const [name, expr, start, zone, end] of [
  [
    "local timezone",
    "0 9 * * *",
    "2026-10-13T00:00:00Z",
    "Asia/Shanghai",
    "2026-10-13T01:00:00Z",
  ],
  [
    "DOM/DOW OR",
    "0 0 20 * 3",
    "2026-10-13T00:00:00Z",
    "UTC",
    "2026-10-14T00:00:00Z",
  ],
  [
    "leap day",
    "0 0 29 2 *",
    "2026-01-01T00:00:00Z",
    "UTC",
    "2028-02-29T00:00:00Z",
  ],
  [
    "DST gap",
    "30 2 * * *",
    "2026-03-08T00:00:00-05:00",
    "America/New_York",
    "2026-03-09T02:30:00-04:00",
  ],
  [
    "DST repeat",
    "30 1 * * *",
    "2026-11-01T01:30:00-04:00",
    "America/New_York",
    "2026-11-01T01:30:00-05:00",
  ],
  [
    "half-hour DST repeat",
    "45 1 * * *",
    "2026-04-05T01:45:00+11:00",
    "Australia/Lord_Howe",
    "2026-04-05T01:45:00+10:30",
  ],
])
  test(name, () =>
    assert.equal(new c.Cron(expr).next(timestamp(start), zone), timestamp(end)),
  );
test("immediate execution both modes", () => {
  for (const request of ["check", "5m check"]) {
    const s = session();
    assert.equal(c.addJob(s, request, t).due_at, t);
    assert.ok(c.claim(s, t));
  }
});
test("dynamic delay is completion relative", () => {
  const s = session(),
    j = c.addJob(s, "check", t),
    owned = c.claim(s, t);
  c.finish(s, j.id, owned.lease, d("continue", 300), t + 100);
  assert.equal(j.due_at, t + 400);
  assert.equal(c.claim(s, t + 399), null);
});
test("exclusive lease and cancellation race", () => {
  const s = session();
  c.addJob(s, "check", t);
  c.addJob(s, "other", t);
  const owned = c.claim(s, t);
  assert.equal(c.claim(s, t), null);
  assert.throws(() => c.finish(s, owned.id, "wrong", d(), t));
  c.cancel(s, owned.id);
  assert.throws(() => c.finish(s, owned.id, owned.lease, d(), t));
  assert.ok(c.claim(s, t));
});
test("decision validation before mutation", () => {
  const s = session(),
    j = c.addJob(s, "check", t),
    owned = c.claim(s, t);
  for (const delay of [0, 59, 3601, 60.5, true, null]) {
    assert.throws(() =>
      c.finish(s, j.id, owned.lease, d("continue", delay), t),
    );
    assert.equal(j.runs, 0);
  }
  for (const decision of [
    null,
    {},
    { ...d(), noop: 1 },
    { ...d(), reason: "" },
  ])
    assert.throws(() => c.validateDecision(decision));
});
test("single fallback and reset", () => {
  const s = session(),
    j = c.addJob(s, "check", t);
  function tick(at, decision) {
    const owned = c.claim(s, at);
    c.finish(s, j.id, owned.lease, decision, at);
  }
  tick(t, d("fallback", null));
  assert.equal(j.due_at, t + 1200);
  tick(t + 1200, d());
  assert.equal(j.fallback_used, false);
  tick(t + 1260, d("fallback", null));
  tick(t + 2460, d("fallback", null));
  assert.equal(j.status, "stopped");
});
test("five-minute cadence and missed periods coalesce", () => {
  const s = session(),
    j = c.addJob(s, "5m check", t);
  let owned = c.claim(s, t);
  c.finish(s, j.id, owned.lease, d(), t + 1800);
  assert.equal(j.due_at, t + 285);
  owned = c.claim(s, t + 1800);
  c.finish(s, j.id, owned.lease, d(), t + 1800);
  assert.equal(j.due_at, t + 2085);
  assert.equal(c.claim(s, t + 1800), null);
});
test("jitter stable and bounded", () => {
  const s = session(),
    j = c.addJob(s, "10m check", t),
    a = c.nextFixed(j, t, "UTC"),
    b = c.nextFixed(j, t + 600, "UTC"),
    nominal = new c.Cron(j.cron).next(t, "UTC");
  assert.equal(b - a, 600);
  assert.ok(a >= nominal && a <= nominal + 300);
});
test("one-shot early and off-hour schedules", () => {
  const s = session(),
    j = c.addJob(s, "remind", t, "0 9 * * *", true),
    nominal = new c.Cron(j.cron).next(t, "UTC");
  assert.ok(j.due_at >= nominal - 90 && j.due_at <= nominal);
  assert.equal(c.claim(s, t), null);
  const owned = c.claim(s, nominal);
  c.finish(s, j.id, owned.lease, d(), nominal);
  assert.equal(j.status, "stopped");
  const other = c.addJob(s, "remind", t, "3 9 * * *", true);
  assert.equal(other.due_at, new c.Cron(other.cron).next(t, "UTC"));
  assert.throws(() => c.addJob(s, "check", t, null, true));
  assert.throws(() => c.addJob(s, "5m check", t, "0 * * * *"));
});
test("expiry final fire and blocked evidence", () => {
  for (const action of ["continue", "blocked"]) {
    const s = session(),
      j = c.addJob(s, "check", t),
      owned = c.claim(s, t + c.TTL);
    assert.equal(owned.final_fire, true);
    c.finish(s, j.id, owned.lease, d(action), t + c.TTL);
    assert.equal(j.status, action === "blocked" ? "blocked" : "stopped");
  }
});
test("restore lifecycle", () => {
  const s = session(),
    dynamic = c.addJob(s, "check", t),
    fixed = c.addJob(s, "5m check", t),
    once = c.addJob(s, "remind", t, "3 9 * * *", true);
  c.reopen(s, t + 86400);
  assert.equal(dynamic.status, "stopped");
  assert.equal(once.status, "stopped");
  assert.equal(fixed.status, "waiting");
  assert.ok(fixed.due_at > t + 86400);
  c.reopen(s, t + c.TTL);
  assert.equal(fixed.status, "stopped");
});
test("interrupted fixed task blocks", () => {
  const s = session(),
    j = c.addJob(s, "5m check", t);
  c.claim(s, t);
  c.reopen(s, t + 1);
  assert.equal(j.status, "blocked");
});
test("event wake and disable switch", () => {
  const s = session(),
    j = c.addJob(s, "check", t),
    owned = c.claim(s, t);
  c.finish(s, j.id, owned.lease, d("continue", 3600), t);
  c.wake(s, j.id, t + 1);
  const previous = process.env.CODEX_LOOP_DISABLE;
  process.env.CODEX_LOOP_DISABLE = "1";
  try {
    assert.equal(c.claim(s, t + 1), null);
  } finally {
    if (previous === undefined) delete process.env.CODEX_LOOP_DISABLE;
    else process.env.CODEX_LOOP_DISABLE = previous;
  }
  assert.ok(c.claim(s, t + 1));
});
test("noop resets and blocked task never reschedules", () => {
  const s = session(),
    j = c.addJob(s, "check", t);
  for (let n = 0; n < 2; n++) {
    const owned = c.claim(s, t + n * 60);
    c.finish(s, j.id, owned.lease, d(), t + n * 60);
  }
  assert.equal(j.noop_count, 2);
  const owned = c.claim(s, t + 120);
  c.finish(s, j.id, owned.lease, { ...d("blocked"), noop: false }, t + 120);
  assert.equal(j.noop_count, 0);
  assert.equal(c.claim(s, t + 10000), null);
});
test("50 active task limit", () => {
  const s = session();
  for (let n = 0; n < 50; n++) c.addJob(s, "check", t);
  assert.throws(() => c.addJob(s, "check", t));
  c.cancel(s, Object.keys(s.tasks)[0]);
  c.addJob(s, "check", t);
});
test("defaults precedence hot reload UTF8 size limit", () => {
  const root = temporary();
  try {
    const project = path.join(root, "project"),
      home = path.join(root, "home");
    fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
    fs.mkdirSync(home);
    const p = path.join(project, ".codex", "loop.md"),
      h = path.join(home, "loop.md"),
      j = { prompt: null };
    fs.writeFileSync(h, "user task");
    assert.equal(c.resolvePrompt(j, project, home)[0], "user task");
    fs.writeFileSync(p, "project task");
    assert.equal(c.resolvePrompt(j, project, home)[0], "project task");
    fs.writeFileSync(p, "changed");
    assert.equal(c.resolvePrompt(j, project, home)[0], "changed");
    assert.equal(
      c.resolvePrompt({ prompt: "explicit" }, project, home)[0],
      "explicit",
    );
    fs.writeFileSync(p, "中".repeat(9000));
    const text = c.resolvePrompt(j, project, home)[0];
    assert.match(text, /truncated/);
    assert.ok(!text.includes("\ufffd"));
    fs.writeFileSync(p, " ");
    assert.equal(c.resolvePrompt(j, project, home)[0], "user task");
    fs.unlinkSync(h);
    assert.equal(c.resolvePrompt(j, project, home)[1], "built-in");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("atomic transaction rollback and project identity", async () => {
  const root = temporary();
  try {
    const store = new c.Store(path.join(root, "state.json"));
    await store.transaction((s) => c.addJob(s, "check", 0), root);
    const before = fs.readFileSync(store.path, "utf8");
    await assert.rejects(
      store.transaction((s) => {
        s.tasks = {};
        throw new Error("abort");
      }),
    );
    assert.equal(fs.readFileSync(store.path, "utf8"), before);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
    await assert.rejects(store.transaction(() => {}, path.dirname(root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("symlink state refused", async (t) => {
  const root = temporary();
  try {
    const target = path.join(root, "target"),
      link = path.join(root, "state");
    fs.writeFileSync(target, "untouched");
    try {
      fs.symlinkSync(target, link);
    } catch (error) {
      if (error.code === "EPERM") {
        t.skip("Windows symlink privilege unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(new c.Store(link).transaction(() => {}, root));
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("lock exclusivity and explicit release", async () => {
  const root = temporary(),
    file = path.join(root, "lock");
  try {
    const unlock = await fileLock(file);
    await assert.rejects(fileLock(file, false));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(file, "owner.json"))).pid,
      process.pid,
    );
    unlock();
    (await fileLock(file, false))();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("minimum Node runtime", () => {
  checkVersion("24.0.0");
  checkVersion("26.0.0");
  assert.throws(() => checkVersion("22.20.0"), />=24/);
});
test("Windows npm shim uses current Node without shell", () => {
  const root = temporary();
  try {
    const shim = path.join(root, "codex.cmd"),
      entry = path.join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");
    fs.writeFileSync(shim, "");
    assert.deepEqual(executablePrefix(shim, "win32"), [
      process.execPath,
      entry,
    ]);
    assert.throws(() =>
      executablePrefix(path.join(root, "untrusted.cmd"), "win32"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows PATH prefers npm cmd over extensionless shell shim", () => {
  const root = temporary(),
    previous = process.env.PATH;
  try {
    const entry = path.join(
      root,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");
    fs.writeFileSync(path.join(root, "codex.cmd"), "");
    fs.writeFileSync(path.join(root, "codex"), "#!/bin/sh");
    process.env.PATH = root;
    assert.deepEqual(executablePrefix("codex", "win32"), [
      process.execPath,
      entry,
    ]);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
