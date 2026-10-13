import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const CLI = fileURLToPath(
  new URL("../scripts/codex_loop.mjs", import.meta.url),
);
const fake = `import fs from 'node:fs';
const args=process.argv.slice(2);let prompt='';for await(const data of process.stdin)prompt+=data;
fs.appendFileSync('calls.jsonl',JSON.stringify({args,prompt})+'\\n');
const count=fs.readFileSync('calls.jsonl','utf8').trim().split('\\n').length;
console.log(JSON.stringify({type:'thread.started',thread_id:'owned-worker'}));
if(fs.existsSync('slow')){fs.writeFileSync('worker.pid',String(process.pid));await new Promise(r=>setTimeout(r,30000));}
if(fs.existsSync('fail'))process.exit(2);
const action=fs.existsSync('repeat') && count===1?'continue':'stop';
const result={action,delay_seconds:action==='continue'?60:null,reason:'fixture result',noop:true,summary:'checked'};
if(!fs.existsSync('missing'))fs.writeFileSync(args[args.indexOf('--output-last-message')+1],fs.existsSync('invalid')?'not json':JSON.stringify(result));
console.log(JSON.stringify({type:'turn.completed'}));`;
function childResult(child) {
  let out = "",
    err = "";
  child.stdout.on("data", (data) => (out += data));
  child.stderr.on("data", (data) => (err += data));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}
async function waitFor(predicate, diagnostics = () => "") {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (predicate()) return;
    await sleep(30);
  }
  throw new Error("Timed out waiting for fixture: " + diagnostics());
}
function fixture(t) {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "loop 任务 ")),
    ),
    state = path.join(root, "state.json"),
    worker = path.join(root, "fake-codex.mjs");
  fs.writeFileSync(worker, fake);
  const children = [];
  const cli = (...args) => {
    const result = spawnSync(
      process.execPath,
      [CLI, "--state", state, ...args],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(
      result.status,
      0,
      result.stderr +
        (fs.existsSync(state) ? fs.readFileSync(state, "utf8") : ""),
    );
    return JSON.parse(result.stdout);
  };
  const start = (...args) => {
    const child = spawn(
      process.execPath,
      [CLI, "--state", state, "run", "--codex", worker, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = childResult(child);
    children.push({ child, result });
    result.then((r) => {
      if (r.code !== 0)
        console.error("Worker exit diagnostics:", JSON.stringify(r));
    });
    return result;
  };
  t.after(async () => {
    for (const { child, result } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          cli("cancel", "all");
        } catch {}
        await Promise.race([result, sleep(5000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await result;
      }
    }
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  return {
    root,
    state,
    worker,
    cli,
    start,
    snapshot: () => JSON.parse(fs.readFileSync(state, "utf8")),
    create: (request = "check", driver = "session") =>
      cli("create", "--project", root, "--driver", driver, request),
    touch: (name) => fs.writeFileSync(path.join(root, name), ""),
    calls: () =>
      fs
        .readFileSync(path.join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse),
  };
}
test("session complete roundtrip", async (t) => {
  const f = fixture(t),
    j = f.create(),
    owned = f.cli("claim"),
    result = path.join(f.root, "decision.json");
  fs.writeFileSync(
    result,
    JSON.stringify({
      action: "stop",
      delay_seconds: null,
      reason: "done",
      noop: false,
    }),
  );
  f.cli("complete", j.id, owned.task.lease, "--decision-file", result);
  assert.equal(f.cli("claim").task, null);
});
test("six processes claim exclusively", async (t) => {
  const f = fixture(t);
  f.create();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      childResult(spawn(process.execPath, [CLI, "--state", f.state, "claim"])),
    ),
  );
  for (const result of results) assert.equal(result.code, 0, result.err);
  assert.equal(results.filter((r) => JSON.parse(r.out).task).length, 1);
});
test("close and restore", (t) => {
  const f = fixture(t),
    dynamic = f.create(),
    fixed = f.create("5m check");
  f.cli("close");
  assert.equal(f.cli("claim").next_at, null);
  f.cli("restore");
  assert.equal(f.snapshot().tasks[dynamic.id].status, "stopped");
  assert.equal(f.snapshot().tasks[fixed.id].status, "waiting");
});
test("worker completes with permission boundaries", async (t) => {
  const f = fixture(t),
    j = f.create("check", "cli"),
    result = await f.start();
  assert.equal(result.code, 0, result.err);
  assert.equal(f.snapshot().tasks[j.id].status, "stopped");
  const call = f.calls()[0];
  assert.ok(call.args.includes('sandbox_mode="read-only"'));
  assert.ok(call.args.includes('approval_policy="never"'));
  assert.ok(!call.args.some((a) => a.includes("dangerously")));
  assert.match(call.prompt, /ONE iteration/);
});
for (let attempt = 1; attempt <= 10; attempt++) {
  test(`event wake resumes only owned worker (${attempt})`, async (t) => {
    const f = fixture(t);
    f.touch("repeat");
    const j = f.create("check", "cli"),
      result = f.start();
    await waitFor(
      () => f.snapshot().tasks[j.id].runs === 1,
      () => JSON.stringify(f.snapshot()),
    );
    f.cli("wake", j.id);
    assert.equal((await result).code, 0);
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes("resume"));
    assert.ok(calls[1].args.includes("owned-worker"));
    assert.ok(!calls[1].args.includes("--last"));
  });
}

test("cancel terminates owned worker", async (t) => {
  const f = fixture(t);
  f.touch("slow");
  const j = f.create("check", "cli"),
    result = f.start();
  await waitFor(() => fs.existsSync(path.join(f.root, "worker.pid")));
  const pid = Number(fs.readFileSync(path.join(f.root, "worker.pid")));
  f.cli("cancel", j.id);
  assert.equal((await result).code, 0);
  assert.equal(f.snapshot().tasks[j.id].status, "stopped");
  assert.throws(() => process.kill(pid, 0));
});
test("timeout blocks", async (t) => {
  const f = fixture(t);
  f.touch("slow");
  const j = f.create("check", "cli"),
    result = await f.start("--timeout", "0.3");
  assert.equal(result.code, 2);
  assert.match(f.snapshot().tasks[j.id].reason, /timed out/);
});
for (const flag of ["fail", "invalid"])
  test(`${flag} blocks without retry`, async (t) => {
    const f = fixture(t);
    f.touch(flag);
    const j = f.create("check", "cli"),
      result = await f.start();
    assert.equal(result.code, 2);
    assert.equal(f.snapshot().tasks[j.id].status, "blocked");
    assert.equal(f.calls().length, 1);
  });
test("one driver per session", async (t) => {
  const f = fixture(t);
  f.touch("slow");
  f.create("check", "cli");
  const first = f.start();
  await waitFor(() => fs.existsSync(path.join(f.root, "worker.pid")));
  const second = await f.start();
  assert.notEqual(second.code, 0);
  assert.match(second.err, /already has a running driver/);
  f.cli("cancel", "all");
  await first;
});
test("close stops executing fixed driver", async (t) => {
  const f = fixture(t);
  f.touch("slow");
  const j = f.create("5m check", "cli"),
    result = f.start();
  await waitFor(() => fs.existsSync(path.join(f.root, "worker.pid")));
  f.cli("close");
  assert.equal((await result).code, 2);
  assert.equal(f.snapshot().tasks[j.id].status, "blocked");
  assert.equal(f.snapshot().closed, true);
});
test("missing decision single fallback", async (t) => {
  const f = fixture(t);
  f.touch("missing");
  const j = f.create("check", "cli"),
    result = f.start();
  await waitFor(
    () => f.snapshot().tasks[j.id].runs === 1,
    () => JSON.stringify(f.snapshot()),
  );
  const first = f.snapshot().tasks[j.id];
  assert.equal(first.due_at - first.finished_at, 1200);
  f.cli("wake", j.id);
  assert.equal((await result).code, 0);
  assert.equal(f.snapshot().tasks[j.id].runs, 2);
  assert.equal(f.snapshot().tasks[j.id].status, "stopped");
});
test("resume restores only fixed schedules", async (t) => {
  const f = fixture(t),
    dynamic = f.create("check", "cli"),
    fixed = f.create("5m check", "cli"),
    result = f.start("--resume");
  await waitFor(() => f.snapshot().tasks[dynamic.id].status === "stopped");
  assert.equal(f.snapshot().tasks[fixed.id].status, "waiting");
  assert.ok(f.snapshot().tasks[fixed.id].due_at > Date.now() / 1000);
  f.cli("cancel", "all");
  await result;
  assert.ok(!fs.existsSync(path.join(f.root, "calls.jsonl")));
});
test("unicode request file and spaced paths", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "任务 with spaces.txt"),
    text = "检查部署状态：完成后停止。";
  fs.writeFileSync(file, text);
  assert.equal(
    f.cli("create", "--project", f.root, "--request-file", file).prompt,
    text,
  );
  assert.equal(f.cli("claim").prompt, text);
});
test("driver separation and argument validation", (t) => {
  const f = fixture(t);
  f.create();
  for (const args of [
    ["run", "--codex", f.worker],
    ["run", "--timeout", "NaN"],
    ["run", "--max-runs", "1.5"],
    ["claim", "--once"],
    ["cancel", "__proto__"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [CLI, "--state", f.state, ...args],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
  }
  assert.ok(!fs.existsSync(path.join(f.root, "calls.jsonl")));
});
test("disable registration", (t) => {
  const f = fixture(t),
    result = spawnSync(
      process.execPath,
      [CLI, "--state", f.state, "create", "check"],
      { env: { ...process.env, CODEX_LOOP_DISABLE: "1" }, encoding: "utf8" },
    );
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(f.state));
});
test("max-runs stops dynamic driver", async (t) => {
  const f = fixture(t);
  f.touch("repeat");
  const j = f.create("check", "cli"),
    result = await f.start("--max-runs", "1");
  assert.equal(result.code, 0);
  assert.equal(f.snapshot().tasks[j.id].runs, 1);
  assert.equal(f.snapshot().tasks[j.id].status, "stopped");
});
test("missing executable blocks cleanly", async (t) => {
  const f = fixture(t),
    j = f.create("check", "cli");
  fs.unlinkSync(f.worker);
  const result = await f.start();
  assert.equal(result.code, 2);
  assert.equal(f.snapshot().tasks[j.id].status, "blocked");
});
