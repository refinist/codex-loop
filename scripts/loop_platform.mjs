import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export function checkVersion(version = process.versions.node) {
  if (Number(version.split(".")[0]) < 24)
    throw new Error(
      `Node.js >=24.0.0 is required; found ${version}. Upgrade Node.js and restart Codex.`,
    );
}
export function rejectLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("State path must not contain symlinks or junctions");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
}
// Atomic directory creation is portable and needs no native addon. Never steal a
// lock on a timer: a paused owner may still be alive. Crashed locks fail closed.
export async function fileLock(file, blocking = true) {
  rejectLinks(file);
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(file, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!blocking || Date.now() - started >= 10000)
        throw new Error(
          `Lock is held or needs inspection: ${file}. After confirming its owner has exited, remove this lock directory.`,
        );
      await sleep(25);
    }
  }
  try {
    fs.writeFileSync(
      path.join(file, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    fs.rmSync(file, { recursive: true, force: true });
    throw error;
  }
  return () => fs.rmSync(file, { recursive: true });
}
export function executablePrefix(executable, platform = process.platform) {
  let resolved = executable;
  const extensions =
    platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  const dirs = /[/\\]/.test(executable)
    ? [""]
    : (process.env.PATH ?? "").split(path.delimiter);
  outer: for (const dir of dirs)
    for (const ext of extensions) {
      const candidate = path.resolve(dir, executable + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          resolved = candidate;
          break outer;
        }
      } catch {}
    }
  if (/\.(mjs|cjs|js)$/i.test(resolved))
    return [process.execPath, path.resolve(resolved)];
  if (platform === "win32" && /\.(cmd|bat|ps1)$/i.test(resolved)) {
    const entry = path.join(
      path.dirname(resolved),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (
      path.basename(resolved, path.extname(resolved)).toLowerCase() ===
        "codex" &&
      fs.existsSync(entry)
    )
      return [process.execPath, entry];
    throw new Error(
      "Use a native codex.exe or the standard npm Codex package; arbitrary shell wrappers are unsupported",
    );
  }
  return [resolved];
}
export async function terminate(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    const tool = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    const result = spawnSync(tool, ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 10000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (
      result.status !== 0 &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      try {
        process.kill(child.pid, 0);
        throw new Error("Could not terminate owned worker tree");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (
    let n = 0;
    n < 60 && child.exitCode === null && child.signalCode === null;
    n++
  )
    await sleep(50);
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    process.platform !== "win32"
  ) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (
    let n = 0;
    n < 60 && child.exitCode === null && child.signalCode === null;
    n++
  )
    await sleep(50);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error("Owned worker did not exit");
}
