// Failure modes: one meeting drops later tasks, retries recreate completed Issues, one search/marker authorizes
// another task, a partial plan looks complete, or per-task receipts overwrite each other or legacy sent rows.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../intake.mjs";
import { FeedbackTools } from "../tools.mjs";
import { notifyOne } from "../notifications.mjs";
import { verifyDecisions } from "../completion.mjs";

const deliveryId = "a".repeat(64),
  conversation = "b".repeat(64);
const actions = [
  { key: "export", description: "修复导出问题" },
  { key: "onboard", description: "改进入门引导" },
];
function fixture(t, github) {
  const dir = mkdtempSync(join(tmpdir(), "feedback-actions-"));
  const inbox = new Inbox(dir, [conversation]);
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId,
    source: { conversationId: conversation },
    message: { type: "text", text: "会议明确两个独立任务，请逐项处理", content: {} },
    attachments: [],
  });
  t.after(() => {
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const request =
    github ||
    (async (method, path, data) => {
      calls.push({ method, path, data });
      if (method === "POST") return { number: 300 + calls.filter((c) => c.method === "POST").length };
      if (path === "search/issues") return { items: [] };
      if (/\/issues\/\d+$/.test(path)) return { number: Number(path.split("/").at(-1)), title: "已有任务", body: "" };
      return [];
    });
  return {
    dir,
    inbox,
    calls,
    request,
    tools: new FeedbackTools(inbox, { repo: "example/app", github: request, multiIssue: true }),
  };
}
const draft = (actionKey) => ({ deliveryId, actionKey, title: actionKey, body: "会议中的独立、已确认任务。" });

test("a frozen meeting plan creates independent Issues, requires each search and survives reopening", async (t) => {
  const { inbox, dir, tools, calls, request } = fixture(t);
  assert.equal(typeof tools.planActions, "function");
  await tools.planActions({ deliveryId, actions });
  await assert.rejects(tools.createIssue(draft("export")), /duplicate_search_required/);
  await tools.findIssues({ deliveryId, actionKey: "export", query: "导出" });
  assert.equal((await tools.createIssue(draft("export"))).issueNumber, 301);
  assert.equal(inbox.get(deliveryId).decision, null, "a partially processed meeting is unfinished");
  await assert.rejects(tools.createIssue(draft("onboard")), /duplicate_search_required/);
  const reopened = new Inbox(dir, [conversation]);
  t.after(() => reopened.close());
  const next = new FeedbackTools(reopened, { repo: "example/app", github: request, multiIssue: true });
  await next.planActions({ deliveryId, actions });
  await assert.rejects(next.planActions({ deliveryId, actions: actions.slice(0, 1) }), /action_plan_conflict/);
  assert.equal((await next.createIssue(draft("export"))).issueNumber, 301);
  await next.findIssues({ deliveryId, actionKey: "onboard", query: "引导" });
  assert.equal((await next.createIssue(draft("onboard"))).issueNumber, 302);
  assert.equal(reopened.get(deliveryId).decision, "created");
  assert.deepEqual(reopened.get(deliveryId).issueNumbers, [301, 302]);
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  assert.equal(inbox.db.prepare("SELECT COUNT(*) AS n FROM issue_cards").get().n, 0, "no extra parent receipt");
});

test("each planned task can be new, a verified duplicate or ignored without dropping the other outcomes", async (t) => {
  const { inbox, tools, calls } = fixture(t);
  await tools.planActions({ deliveryId, actions: [...actions, { key: "chat", description: "会议闲聊" }] });
  await tools.findIssues({ deliveryId, actionKey: "export", query: "导出" });
  await tools.createIssue(draft("export"));
  await assert.rejects(
    tools.decide({ deliveryId, actionKey: "onboard", decision: "duplicate", reason: "已记录", issueNumber: 12 }),
    /duplicate_search_required/,
  );
  await tools.findIssues({ deliveryId, actionKey: "onboard", query: "引导" });
  await tools.decide({
    deliveryId,
    actionKey: "onboard",
    decision: "duplicate",
    reason: "已核实已有任务",
    issueNumber: 12,
  });
  await tools.decide({ deliveryId, actionKey: "chat", decision: "ignored", reason: "无需建单" });
  const result = inbox.get(deliveryId);
  assert.equal(result.decision, "created");
  assert.deepEqual(result.issueNumbers, [301, 12]);
  assert.deepEqual(
    result.actionPlan.map((a) => a.decision),
    ["created", "duplicate", "ignored"],
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("uncertain writes reconcile only their own action marker and never repeat either POST", async (t) => {
  const writes = [],
    landed = [];
  const { inbox, tools } = fixture(t, async (method, path, data) => {
    if (method === "POST") {
      writes.push(data);
      throw Error("lost_response");
    }
    if (path === "search/issues") return { items: [] };
    return landed;
  });
  await tools.planActions({ deliveryId, actions });
  for (const a of actions) {
    await tools.findIssues({ deliveryId, actionKey: a.key, query: a.key });
    await assert.rejects(tools.createIssue(draft(a.key)), /issue_write_uncertain/);
  }
  assert.notEqual(writes[0].body, writes[1].body);
  landed.push({ number: 301, body: writes[0].body });
  assert.equal((await tools.createIssue(draft("export"))).issueNumber, 301);
  await assert.rejects(tools.createIssue(draft("onboard")), /issue_write_uncertain/);
  assert.equal(inbox.get(deliveryId).decision, null);
  landed.push({ number: 302, body: writes[1].body });
  assert.equal((await tools.createIssue(draft("onboard"))).issueNumber, 302);
  assert.equal(writes.length, 2);
  assert.deepEqual(inbox.get(deliveryId).issueNumbers, [301, 302]);
});

test("concurrent creates of the same planned action have one durable claim", async (t) => {
  let writes = 0;
  const { tools } = fixture(t, async (method, path) => {
    if (method === "POST") {
      writes++;
      await new Promise((r) => setTimeout(r, 30));
      return { number: 301 };
    }
    return path === "search/issues" ? { items: [] } : [];
  });
  await tools.planActions({ deliveryId, actions: actions.slice(0, 1) });
  await tools.findIssues({ deliveryId, actionKey: "export", query: "导出" });
  await Promise.allSettled([tools.createIssue(draft("export")), tools.createIssue(draft("export"))]);
  assert.equal(writes, 1);
  assert.equal((await tools.createIssue(draft("export"))).issueNumber, 301);
});

test("unfinished plans cannot be skipped by a parent decision or successful model exit", async (t) => {
  const { inbox, tools, dir } = fixture(t);
  await tools.planActions({ deliveryId, actions });
  await assert.rejects(tools.decide({ deliveryId, decision: "ignored", reason: "done" }), /action_key_required/);
  const context = join(dir, "context.json");
  writeFileSync(
    context,
    JSON.stringify({ events: [{ type: "feishu.feedback", detail: JSON.stringify({ deliveryId }) }] }),
  );
  const config = { contextRoot: dir, stateDir: dir, multiIssue: true };
  assert.throws(() => verifyDecisions(config, context), /feedback_decision_missing/);
  inbox.db.prepare("UPDATE feedback SET decision='ignored' WHERE id=?").run(deliveryId);
  assert.throws(() => verifyDecisions(config, context), /feedback_action_incomplete/);
});

test("created actions get separate frozen A2UI receipts and stable send keys", async (t) => {
  const { inbox, tools } = fixture(t);
  await tools.planActions({ deliveryId, actions });
  for (const a of actions) {
    await tools.findIssues({ deliveryId, actionKey: a.key, query: a.key });
    await tools.createIssue(draft(a.key));
  }
  const sent = [];
  const options = {
    repo: "example/app",
    getIssue: async (number) => ({ number, title: "真实任务", user: { login: "alice" } }),
    sendCard: async (value) => {
      sent.push(value);
      return "om_" + sent.length;
    },
  };
  await notifyOne(inbox, options);
  await notifyOne(inbox, options);
  await notifyOne(inbox, options);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].key, sent[1].key);
  assert.ok(sent.every((s) => JSON.parse(s.payload).schema === "2.0"));
  assert.deepEqual(inbox.cardCounts(), { sent: 2 });
});
