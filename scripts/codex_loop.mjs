#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { checkVersion } from "./loop_platform.mjs";
import {
  Store,
  addJob,
  cancel,
  claim,
  disabled,
  finish,
  now,
  parseRequest,
  reopen,
  resolvePrompt,
  wake,
} from "./loop_core.mjs";
import { run } from "./loop_runner.mjs";
const commands = {
  plan: [],
  create: ["request-file", "project", "timezone", "cron", "once", "driver"],
  list: [],
  claim: [],
  complete: ["decision-file"],
  cancel: [],
  wake: [],
  close: [],
  restore: [],
  run: ["resume", "sandbox", "timeout", "max-runs", "codex"],
};
const booleanOptions = new Set(["help", "once", "resume"]);
const options = Object.fromEntries(
  ["state", "help", ...new Set(Object.values(commands).flat())].map((name) => [
    name,
    { type: booleanOptions.has(name) ? "boolean" : "string" },
  ]),
);
async function main() {
  checkVersion();
  const { values: v, positionals } = parseArgs({
    options,
    allowPositionals: true,
  });
  const [command, ...args] = positionals;
  if (v.help) {
    console.log(
      "Usage: node scripts/codex_loop.mjs [--state FILE] COMMAND [options]\nCommands: plan [REQUEST], create [REQUEST], list, claim, complete ID LEASE --decision-file FILE, cancel ID|all, wake ID, close, restore, run\ncreate: --request-file FILE --project DIR --timezone IANA --cron EXPR --once --driver session|cli\nrun: --resume --sandbox read-only|workspace-write --timeout SECONDS --max-runs N --codex PATH\nNode.js >=24.0.0. State files are private; use a distinct file per session.",
    );
    return;
  }
  if (!Object.hasOwn(commands, command ?? ""))
    throw new Error("Expected a command; use --help");
  for (const key of Object.keys(v))
    if (!["state", "help", ...commands[command]].includes(key))
      throw new Error(`Unexpected option --${key} for ${command}`);
  const count = {
    plan: [0, 1],
    create: [0, 1],
    complete: [2, 2],
    cancel: [1, 1],
    wake: [1, 1],
  }[command] ?? [0, 0];
  if (args.length < count[0] || args.length > count[1])
    throw new Error(`Wrong number of arguments for ${command}`);
  if (command === "plan")
    return console.log(JSON.stringify(parseRequest(args[0] ?? ""), null, 2));
  if (!v.state) throw new Error("--state is required for this command");
  const store = new Store(v.state);
  if (command === "run") {
    process.exitCode = await run(store, {
      codex: v.codex,
      sandbox: v.sandbox,
      timeout: v.timeout === undefined ? 1800 : Number(v.timeout),
      maxRuns: v["max-runs"] === undefined ? null : Number(v["max-runs"]),
      resume: !!v.resume,
    });
    return;
  }
  const result = await store.transaction(
    (state) => {
      switch (command) {
        case "create": {
          if (disabled()) throw new Error("CODEX_LOOP_DISABLE is set");
          if (state.closed)
            throw new Error(
              "Session is closed; restore it or use a new state file",
            );
          const driver = v.driver ?? "session";
          if (!["session", "cli"].includes(driver))
            throw new Error("driver must be session or cli");
          if (state.driver && state.driver !== driver)
            throw new Error("Cannot mix session and CLI drivers");
          const request = v["request-file"]
            ? fs.readFileSync(v["request-file"], "utf8")
            : (args[0] ?? "");
          const job = addJob(state, request, now(), v.cron, !!v.once);
          state.driver = driver;
          return job;
        }
        case "list":
          return {
            session: state.id,
            project: state.project,
            timezone: state.timezone,
            closed: !!state.closed,
            worker_thread: state.worker_thread,
            tasks: Object.values(state.tasks),
          };
        case "claim": {
          if (state.driver === "cli")
            throw new Error("CLI driver owns this state; use run");
          const job = state.closed ? null : claim(state, now());
          if (job) {
            const [prompt, source] = resolvePrompt(job, state.project);
            return { task: job, prompt, source };
          }
          const waiting = Object.values(state.tasks)
            .filter((j) => j.status === "waiting")
            .map((j) => j.due_at);
          return {
            task: null,
            next_at:
              waiting.length && !state.closed && !disabled()
                ? Math.min(...waiting)
                : null,
            disabled: disabled(),
          };
        }
        case "complete":
          if (!v["decision-file"])
            throw new Error("--decision-file is required");
          return finish(
            state,
            args[0],
            args[1],
            JSON.parse(fs.readFileSync(v["decision-file"], "utf8")),
            now(),
          );
        case "cancel":
          return (args[0] === "all" ? Object.keys(state.tasks) : [args[0]]).map(
            (id) => cancel(state, id),
          );
        case "wake":
          if (disabled() || state.closed)
            throw new Error("Session is disabled or closed");
          return wake(state, args[0], now());
        case "close":
          state.closed = true;
          for (const job of Object.values(state.tasks))
            if (
              job.mode === "dynamic" &&
              ["waiting", "running"].includes(job.status)
            )
              cancel(state, job.id, "Session closed");
          return { closed: true };
        case "restore":
          if (state.driver === "cli")
            throw new Error("For CLI state use run --resume");
          reopen(state, now());
          state.closed = false;
          return { restored: true, tasks: Object.values(state.tasks) };
      }
    },
    command === "create" ? (v.project ?? process.cwd()) : null,
    v.timezone ?? "UTC",
  );
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
});
