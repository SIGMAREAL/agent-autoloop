import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const MAX_BYTES = 256 * 1024;
function directory(stateDir) {
  if (typeof stateDir !== "string" || !isAbsolute(stateDir)) throw new Error("private_ui_directory_required");
  const dir = join(stateDir, "a2ui");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.platform !== "win32" && stat.mode & 0o077))
    throw new Error("private_ui_directory_required");
  return dir;
}
export function saveView(stateDir, view) {
  const text = JSON.stringify(view);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("ui_artifact_too_large");
  const key = digest(text),
    ref = `a2ui:${key}`;
  try {
    writeFileSync(join(directory(stateDir), `${key}.json`), text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    loadView(stateDir, ref);
  }
  return ref;
}
export function loadView(stateDir, ref) {
  if (typeof ref !== "string" || !/^a2ui:[a-f0-9]{64}$/.test(ref)) throw new Error("invalid_ui_reference");
  const file = join(directory(stateDir), `${ref.slice(5)}.json`),
    stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== "win32" && stat.mode & 0o077))
    throw new Error("private_ui_artifact_required");
  const text = readFileSync(file, "utf8");
  if (digest(text) !== ref.slice(5)) throw new Error("artifact_hash_mismatch");
  return JSON.parse(text);
}
