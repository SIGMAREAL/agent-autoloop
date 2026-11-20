// Prevent arbitrary repository/API access, omitted pages, false all-clear on partial failures, and UTF-8 damage in PR answers.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PullRequests } from "../pull-requests.mjs";
import { ghRequest } from "../tools.mjs";

function fixture(t, github) {
  const dir = mkdtempSync(join(tmpdir(), "feedback-pr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "repos.json");
  writeFileSync(file, JSON.stringify(["example/app", "example/backend"]), { mode: 0o600 });
  return { dir, queries: new PullRequests({ repositoriesFile: file, github }) };
}
const pr = (number) => ({
  number,
  title: "中文 PR",
  user: { login: "author" },
  draft: true,
  html_url: "https://untrusted.test",
  created_at: "2026-11-19T02:03:00Z",
  updated_at: "2026-11-20T00:05:00Z",
});

test("only whitelisted repositories and GET open-PR endpoints are exposed, with complete pagination", async (t) => {
  const calls = [];
  const { queries } = fixture(t, async (method, path, params, options) => {
    calls.push({ method, path, params });
    assert.equal(params.state, "open");
    assert.ok(options.signal);
    if (path.includes("backend")) return [];
    return params.page === "1" ? Array.from({ length: 100 }, (_, i) => pr(101 - i)) : [pr(1)];
  });
  await assert.rejects(queries.list({ repository: "other/private" }), /unauthorized_repository/);
  assert.equal(calls.length, 0);
  const result = await queries.list({});
  assert.equal(result.complete, true);
  assert.equal(result.total, 101);
  assert.ok(calls.every((c) => c.method === "GET" && /^repos\/example\/(app|backend)\/pulls$/.test(c.path)));
  assert.equal(result.repositories[0].pullRequests[0].url, "https://github.com/example/app/pull/101");
  assert.equal(result.repositories[0].pullRequests[0].draft, true);
  assert.equal(result.repositories[0].pullRequests[0].createdAt, "2026-11-19T02:03:00.000Z");
  assert.equal(result.repositories[0].pullRequests[0].updatedAt, "2026-11-20T00:05:00.000Z");
});

test("one unavailable repository is explicit partial coverage, not an empty all-clear", async (t) => {
  const { queries } = fixture(t, async (_m, path) => {
    if (path.includes("backend")) throw new Error("offline");
    return [pr(3)];
  });
  const result = await queries.list({});
  assert.equal(result.complete, false);
  assert.equal(result.total, 1);
  assert.equal(result.repositories[1].error, "github_request_failed");
  assert.equal(result.repositories[1].complete, false);
});

test("cancellation reaches active GitHub requests and remaining coverage stays incomplete", async (t) => {
  const { queries } = fixture(t, async (_m, _p, _v, { signal }) => {
    if (signal.aborted) throw new Error("aborted");
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  const controller = new AbortController();
  const pending = queries.list({}, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.complete, false);
  assert.ok(result.repositories.every((r) => !r.complete));
});

test("the real CLI reader preserves Chinese split across stdout chunks", async (t) => {
  const { dir } = fixture(t, async () => []);
  const program = join(dir, "fake-gh");
  writeFileSync(
    program,
    `#!/usr/bin/env node\nconst b=Buffer.from(JSON.stringify([{number:1,title:'新 PR'}]));const i=b.indexOf(Buffer.from('新'))+1;
process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.write(b.subarray(i)),50);\n`,
    { mode: 0o700 },
  );
  const result = await ghRequest("GET", "repos/example/app/pulls", {}, { program, timeoutMs: 5000 });
  assert.equal(result[0].title, "新 PR");
});
