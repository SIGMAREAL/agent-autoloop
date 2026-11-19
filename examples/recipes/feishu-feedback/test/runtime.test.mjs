// Prevent insecure configuration, duplicate workers and unsafe recovery commands.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, acquireLock } from "../src/runtime.mjs";
test("runtime fails closed on empty chat whitelist or readable secret configuration", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      appId: "cli_fixture",
      appSecret: "fictional-app-secret-1234",
      repo: "example/repo",
      chatIds: [],
      stateDir: join(dir, "state"),
    }),
    { mode: 0o600 },
  );
  assert.throws(() => loadConfig(path), /chat_allowlist_required/);
  assert.equal(loadConfig(path, { connectOnly: true }).repo, "example/repo");
  chmodSync(path, 0o644);
  assert.throws(() => loadConfig(path, { connectOnly: true }), /private_config_required/);
});
test("single process lock refuses a second active worker and can be released", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /already_running/);
  release();
  const again = acquireLock(dir);
  again();
});
