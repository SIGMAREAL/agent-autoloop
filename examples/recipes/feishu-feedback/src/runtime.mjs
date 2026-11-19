import { readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
export function loadConfig(path, { connectOnly = false } = {}) {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("private_config_required");
  const c = JSON.parse(readFileSync(path, "utf8"));
  if (
    !/^cli_[\w]+$/.test(c.appId || "") ||
    typeof c.appSecret !== "string" ||
    c.appSecret.length < 16 ||
    !isAbsolute(c.stateDir || "")
  )
    throw new Error("invalid_bot_config");
  if (!Array.isArray(c.chatIds) || c.chatIds.some((id) => !/^oc_[\w]+$/.test(id)))
    throw new Error("invalid_chat_allowlist");
  if (!connectOnly && !c.chatIds.length) throw new Error("chat_allowlist_required");
  return c;
}
export function acquireLock(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "worker.lock");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid;
    try {
      pid = Number(readFileSync(join(path, "pid"), "utf8"));
    } catch {
      throw new Error("already_running_or_lock_incomplete");
    }
    if (!Number.isInteger(pid) || pid < 1) throw new Error("invalid_worker_lock");
    try {
      process.kill(pid, 0);
      throw new Error("already_running");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    rmSync(path, { recursive: true });
    mkdirSync(path, { mode: 0o700 });
  }
  writeFileSync(join(path, "pid"), String(process.pid), {
    mode: 0o600,
    flag: "wx",
  });
  return () => rmSync(path, { recursive: true, force: true });
}
