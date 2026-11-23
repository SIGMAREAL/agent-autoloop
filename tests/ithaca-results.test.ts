// Failure modes: intermediate work spams the group, a planned action looks completed, retries duplicate cards,
// updates create another message, or a snapshot leaks raw feedback and changes the execution database.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
const load = () => import(new URL("../plugins/ithaca-results/core.ts", import.meta.url).href);
const issue = (state = "enriched") => ({
  id: "item-24",
  repo: "example/app",
  number: 24,
  title: "An actual Issue",
  state,
  author: "alice",
  createdAt: "2026-11-22T05:00:00Z",
  updatedAt: "2026-11-22T05:00:00Z",
  summary: "Requires an owner decision",
  reason: "Missing acceptance",
  taskIds: [] as string[],
  ...(state === "enriched" ? { comment: { html_url: "https://github.com/example/app/issues/24#issuecomment-1" } } : {}),
});
const snapshot = (item = issue()) => ({
  project: "petwins",
  items: [item],
  tasks: [] as any[],
  run: { state: "running" },
});
const config = {
  source: "mini-petwins",
  project: "petwins",
  repositories: ["example/app"],
  timeZone: "America/Los_Angeles",
};

test("only completed Issue results are selected, with confirmed mutations and actual PR receipts", async () => {
  const { selectResults } = await load();
  for (const state of [
    "triaging",
    "triaged",
    "queued",
    "writing",
    "commented",
    "uncertain",
    "triage-failed",
    "dependency-wait",
  ])
    assert.deepEqual(selectResults(snapshot(issue(state)), config), [], state);
  assert.deepEqual(selectResults(snapshot(issue("needs-human")), config), []);
  assert.deepEqual(selectResults(snapshot(issue("closed")), config), []);
  const closed = {
    ...issue("closed"),
    comment: { html_url: "https://github.com/example/app/issues/24#issuecomment-1" },
  };
  assert.equal(selectResults(snapshot(closed), config)[0].outcome, "closed");
  const enriched = { ...closed, state: "enriched" };
  assert.equal(selectResults(snapshot(enriched), config)[0].outcome, "enriched");
  const pr = snapshot({ ...issue("pr-pending"), taskIds: ["task-1"] });
  (pr.tasks as any[]) = [
    {
      id: "task-1",
      state: "review",
      prUrl: "https://github.com/example/app/pull/9",
      result: { summary: "Implemented" },
    },
  ];
  assert.equal(selectResults(pr, config)[0].outcome, "pr");
  assert.equal(selectResults(pr, config)[0].prUrl, "https://github.com/example/app/pull/9");
  pr.items[0].repo = "other/private";
  assert.deepEqual(selectResults(pr, config), []);
});

test("result backfill, durable deduplication and message patching survive a failed update", async (t) => {
  const { poll } = await load();
  const root = mkdtempSync(join(tmpdir(), "ithaca-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls: any[] = [];
  let failPatch = false;
  const c = {
    ...config,
    enabled: true,
    stateDir: root,
    profile: "existing",
    chatId: "oc_group",
    larkCommand: ["fake"],
  };
  let current = snapshot();
  const run = async (_command: string[], args: string[], input?: string) => {
    calls.push({ args, input: input && JSON.parse(input) });
    if (args.includes("patch") && failPatch) {
      failPatch = false;
      throw Error("network interrupted");
    }
    return JSON.stringify({
      ok: true,
      identity: "bot",
      data: args.includes("+messages-send") ? { message_id: "om_result" } : {},
    });
  };
  const ports = { snapshot: async () => current, run, image: async () => null };
  await poll(c, ports);
  assert.equal(calls.filter((x) => x.args.includes("+messages-send")).length, 1);
  assert.equal(calls.filter((x) => x.args.includes("patch")).length, 1);
  await poll(c, ports);
  assert.equal(calls.length, 2, "unchanged outcomes are silent across database reopen");
  current = snapshot({ ...issue(), reason: "A changed decision" });
  failPatch = true;
  assert.equal((await poll(c, ports)).errors.length, 1);
  await poll(c, ports);
  assert.equal(
    calls.filter((x) => x.args.includes("+messages-send")).length,
    1,
    "update failure never posts a new message",
  );
  assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf("--message-id") + 1], "om_result");
  assert.match(calls.at(-1).input.content, /A changed decision/);
  const send = calls.find((x) => x.args.includes("+messages-send"));
  assert.equal(send.args[send.args.indexOf("--chat-id") + 1], "oc_group");
  assert.ok(send.args[send.args.indexOf("--idempotency-key") + 1].length <= 50);
  assert.equal(send.input.schema, "2.0");
});

test("the read-only snapshot omits raw bodies and comments while retaining result and delivery receipts", async (t) => {
  const { snapshotScript } = await import(new URL("../plugins/ithaca-results/source.ts", import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(), "ithaca-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "pool.sqlite");
  const db = new DatabaseSync(file);
  for (const table of ["loop_runs", "loop_items", "tasks", "runs"])
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY,entity TEXT,type TEXT,payload TEXT,at TEXT)");
  db.prepare("INSERT INTO loop_runs VALUES(?,?)").run(
    "run",
    JSON.stringify({ id: "run", project: "petwins", state: "running" }),
  );
  db.prepare("INSERT INTO loop_items VALUES(?,?)").run(
    "item",
    JSON.stringify({
      ...issue(),
      input: {
        title: "Actual",
        body: "PRIVATE_RAW_BODY",
        comments: [{ body: "PRIVATE_COMMENT" }],
        user: { login: "alice" },
      },
      decision: { summary: "Summary", reason: "Reason" },
      error: "PR head changed outside verified Owner PRIVATE_ERROR_DETAIL",
    }),
  );
  db.close();
  const before = readFileSync(file);
  const stdout = execFileSync(process.execPath, ["--input-type=module"], {
    input: snapshotScript(file, "petwins"),
    encoding: "utf8",
  });
  assert.ok(!stdout.includes("PRIVATE_RAW_BODY") && !stdout.includes("PRIVATE_COMMENT"));
  assert.equal(JSON.parse(stdout).items[0].summary, "Summary");
  assert.equal(JSON.parse(stdout).items[0].blocker, "pr-head-changed");
  assert.ok(!stdout.includes("PRIVATE_ERROR_DETAIL"));
  assert.deepEqual(readFileSync(file), before);
  assert.throws(() =>
    execFileSync(process.execPath, ["--input-type=module"], {
      input: snapshotScript(file, "other"),
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
});

test("current blockers and GitHub terminal states replace historical PR success", async () => {
  const { selectResults } = await load();
  const s = snapshot({ ...issue("needs-human"), taskIds: ["task-1"], blocker: "pr-head-changed" } as any);
  s.tasks = [
    {
      id: "task-1",
      state: "review",
      prUrl: "https://github.com/example/app/pull/9",
      result: { summary: "Old implementation" },
    },
  ];
  let result = selectResults(s, config)[0];
  assert.equal(result.outcome, "human");
  assert.match(result.reason, /提交.*改变/);
  assert.ok(result.prUrl);
  s.items[0].state = "merged";
  result = selectResults(s, config)[0];
  assert.equal(result.status, "PR 已合并");
  assert.ok(!result.reason.includes("尚未合并"));
  s.items[0].state = "pr-closed";
  assert.equal(selectResults(s, config)[0].status, "PR 已关闭（未合并）");
  s.items[0].state = "handoff";
  s.tasks[0].state = "merged";
  assert.equal(selectResults(s, config)[0].status, "PR 已合并");
  s.tasks[0].state = "blocked";
  s.tasks[0].blocker = "pr-closed";
  assert.equal(selectResults(s, config)[0].status, "PR 已关闭（未合并）");
});

test("an unknown send receipt is held beyond native UUID validity instead of creating another card", async (t) => {
  const { poll } = await load();
  const root = mkdtempSync(join(tmpdir(), "ithaca-uncertain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const c = {
    ...config,
    enabled: true,
    stateDir: root,
    profile: "existing",
    chatId: "oc_group",
    larkCommand: ["fake"],
  };
  let now = Date.parse("2026-11-22T05:00:00Z"),
    sends = 0;
  const ports = {
    snapshot: async () => snapshot(),
    now: () => now,
    image: async () => null,
    run: async () => {
      sends++;
      throw Error("receipt lost after remote accepted");
    },
  };
  await poll(c, ports);
  assert.equal(sends, 1);
  now += 65 * 60_000;
  const held = await poll(c, ports);
  assert.equal(sends, 1, "expired idempotency must not issue a second POST");
  assert.match(held.errors.join("\n"), /回执.*未知/);
});
