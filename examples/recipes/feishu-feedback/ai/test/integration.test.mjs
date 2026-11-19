// Prevent non-durable intake, lost routing, duplicate Issues and bypassed AI/write boundaries.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Inbox, createIngress, dispatchOne, reconcileRouting } from "../intake.mjs";
import { FeedbackTools } from "../tools.mjs";

const id = "a".repeat(64),
  conversation = "b".repeat(64);
const envelope = (overrides = {}) => ({
  schema: "petwins.feishu.message.v1",
  deliveryId: id,
  source: {
    messageId: "om_example",
    conversationId: conversation,
    createdAt: "1",
    rootId: null,
    threadId: null,
  },
  message: {
    type: "text",
    text: "导出时窗口消失，重启后仍然出现",
    content: {},
  },
  attachments: [],
  ...overrides,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "feedback-ai-"));
  const inbox = new Inbox(dir, [conversation]);
  t.after(() => {
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, inbox };
}
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
function github() {
  const calls = [];
  return {
    calls,
    request: async (method, path, data) => {
      calls.push({ method, path, data });
      if (method === "POST")
        return {
          number: 301,
          html_url: "https://github.com/example/repo/issues/301",
        };
      if (path === "search/issues") return { items: [] };
      if (/\/issues\/\d+$/.test(path))
        return {
          number: Number(path.split("/").at(-1)),
          title: "Existing",
          body: "",
          html_url: "https://github.com/example/repo/issues/12",
        };
      return [];
    },
  };
}

test("authenticated durable intake returns the relay's receipt; replays dispatch once", async (t) => {
  const { inbox } = fixture(t);
  const url = await listen(t, createIngress({ inbox, token: "private-token" }));
  const post = (token) =>
    fetch(url + "/feishu", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": id,
      },
      body: JSON.stringify(envelope()),
    });
  assert.equal((await post("wrong")).status, 401);
  assert.deepEqual(await (await post("private-token")).json(), {
    accepted: true,
    deliveryId: id,
  });
  assert.deepEqual(await (await post("private-token")).json(), {
    accepted: true,
    deliveryId: id,
  });
  assert.equal(inbox.counts().pending, 1);
  let calls = 0;
  const hub = await listen(
    t,
    createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer source-token");
      let body = "";
      for await (const part of req) body += part;
      const event = JSON.parse(body);
      assert.equal(event.id, id);
      assert.equal(JSON.parse(event.detail).deliveryId, id);
      assert.equal(event.subject, conversation);
      assert.equal(event.type, "feishu.feedback");
      calls++;
      res.end(JSON.stringify({ event: 7, duplicate: false, routed: ["triage"] }));
    }),
  );
  const cfg = { hubUrl: hub, sourceToken: "source-token", rule: "triage" };
  await dispatchOne(inbox, cfg);
  await dispatchOne(inbox, cfg);
  assert.equal(calls, 1);
  assert.equal(inbox.get(id).hubEvent, 7);
});

test("intake rejects a revoked group, ID mismatch and changed replay payload", async (t) => {
  const { inbox } = fixture(t);
  assert.throws(
    () => inbox.accept(envelope({ source: { conversationId: "c".repeat(64) } })),
    /unauthorized_conversation/,
  );
  inbox.accept(envelope());
  assert.throws(
    () => inbox.accept(envelope({ message: { type: "text", text: "changed", content: {} } })),
    /delivery_conflict/,
  );
  const url = await listen(t, createIngress({ inbox, token: "private-token" }));
  const response = await fetch(url + "/feishu", {
    method: "POST",
    headers: {
      authorization: "Bearer private-token",
      "idempotency-key": "c".repeat(64),
    },
    body: JSON.stringify(envelope()),
  });
  assert.equal(response.status, 400);
});

test("attachment bytes stay private and opaque; traversal names cannot choose a path", (t) => {
  const { inbox, dir } = fixture(t);
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  inbox.accept(
    envelope({
      attachments: [
        {
          status: "available",
          name: "../../run.sh",
          mimeType: "application/octet-stream",
          base64: bytes.toString("base64"),
        },
      ],
    }),
  );
  const attachment = inbox.get(id).envelope.attachments[0];
  assert.ok(attachment.path.startsWith(dir + "/"));
  assert.deepEqual(readFileSync(attachment.path), bytes);
  assert.equal(attachment.base64, undefined);
  assert.throws(
    () =>
      inbox.accept(
        envelope({
          deliveryId: "c".repeat(64),
          attachments: [{ status: "available", base64: "invalid!", mimeType: "image/png" }],
        }),
      ),
    /invalid_attachment/,
  );
});

test("the full 5 MiB attachment limit is accepted and larger resources are rejected", (t) => {
  const { inbox } = fixture(t),
    bytes = Buffer.alloc(5 * 1024 * 1024, 42);
  const media = (value) => [
    {
      status: "available",
      name: "limit.bin",
      mimeType: "application/octet-stream",
      base64: value.toString("base64"),
    },
  ];
  inbox.accept(envelope({ attachments: media(bytes) }));
  assert.deepEqual(inbox.readAttachment(id, 0), bytes);
  assert.throws(
    () =>
      inbox.accept(
        envelope({
          deliveryId: "c".repeat(64),
          attachments: media(Buffer.alloc(bytes.length + 1)),
        }),
      ),
    /invalid_attachment/,
  );
});

test("a lost Autoloop receipt retries the stable event ID after reopening", async (t) => {
  const { inbox, dir } = fixture(t);
  inbox.accept(envelope());
  await assert.rejects(
    dispatchOne(inbox, {
      hubUrl: "http://127.0.0.1:1",
      sourceToken: "x",
      rule: "triage",
    }),
  );
  const reopened = new Inbox(dir, [conversation]);
  t.after(() => reopened.close());
  assert.equal(reopened.get(id).state, "pending");
});

test("an accepted paused event is held without blocking later feedback; reconciliation verifies a real run", async (t) => {
  const { inbox } = fixture(t);
  inbox.accept(envelope());
  const next = "c".repeat(64);
  inbox.accept(envelope({ deliveryId: next }));
  const sent = [];
  let correctRule = false;
  const config = {
    hubUrl: "http://127.0.0.1:3350",
    sourceToken: "source",
    rule: "triage",
  };
  const hub = async (url, init) => {
    if (init.method === "GET")
      return Response.json({
        event: 7,
        runs: [{ run: 42, rule: correctRule ? "triage" : "other" }],
      });
    const e = JSON.parse(init.body);
    sent.push(e.id);
    return Response.json(e.id === id ? { event: 7, routed: [], paused: ["triage"] } : { event: 8, routed: ["triage"] });
  };
  await dispatchOne(inbox, config, hub);
  await dispatchOne(inbox, config, hub);
  assert.deepEqual(sent, [id, next]);
  assert.equal(inbox.get(id).state, "routing_held");
  assert.equal(inbox.get(next).state, "dispatched");
  await reconcileRouting(inbox, config, hub);
  assert.equal(inbox.get(id).state, "routing_held");
  correctRule = true;
  await reconcileRouting(inbox, config, hub);
  assert.equal(inbox.get(id).state, "dispatched");
});

test("durably accepted attachment bytes survive missing or corrupted materialized files", (t) => {
  const { inbox, dir } = fixture(t),
    bytes = Buffer.from([0, 255, 1, 2, 3]);
  inbox.accept(
    envelope({
      attachments: [
        {
          status: "available",
          name: "data.bin",
          mimeType: "application/octet-stream",
          base64: bytes.toString("base64"),
        },
      ],
    }),
  );
  const path = inbox.get(id).envelope.attachments[0].path;
  rmSync(path);
  const reopened = new Inbox(dir, [conversation]);
  t.after(() => reopened.close());
  const tools = new FeedbackTools(reopened, {
    repo: "example/repo",
    github: github().request,
  });
  tools.readFeedback({ deliveryId: id });
  assert.deepEqual(readFileSync(path), bytes);
  writeFileSync(path, "corrupt");
  tools.readFeedback({ deliveryId: id });
  assert.deepEqual(readFileSync(path), bytes);
});

test("GitHub tools enforce duplicate search, a fixed repository and one create per feedback", async (t) => {
  const { inbox } = fixture(t);
  inbox.accept(envelope());
  const gh = github(),
    tools = new FeedbackTools(inbox, {
      repo: "example/repo",
      github: gh.request,
    });
  await assert.rejects(
    tools.createIssue({
      deliveryId: id,
      title: "Export closes window",
      body: "Observed on export.",
    }),
    /duplicate_search_required/,
  );
  await tools.findIssues({ deliveryId: id, query: "export" });
  await assert.rejects(tools.findIssues({ deliveryId: id, query: "repo:other/project" }), /invalid_search/);
  const first = await tools.createIssue({
    deliveryId: id,
    title: "Export closes window",
    body: "Observed on export.",
  });
  const second = await tools.createIssue({
    deliveryId: id,
    title: "Export closes window",
    body: "Observed on export.",
  });
  assert.equal(first.issueNumber, 301);
  assert.equal(second.issueNumber, 301);
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(gh.calls.find((c) => c.method === "POST").path, "repos/example/repo/issues");
  assert.match(gh.calls.find((c) => c.method === "POST").data.body, new RegExp(id));
});

test("unknown GitHub write result is held and reconciled, never blindly created again", async (t) => {
  const { inbox } = fixture(t);
  inbox.accept(envelope());
  let writes = 0,
    landed = false;
  const tools = new FeedbackTools(inbox, {
    repo: "example/repo",
    github: async (method, path) => {
      if (method === "POST") {
        writes++;
        throw new Error("connection_lost");
      }
      if (path === "search/issues") return { items: [] };
      return landed
        ? [
            {
              number: 302,
              html_url: "https://github.com/example/repo/issues/302",
              body: `<!-- petwins-feedback:${id} -->`,
            },
          ]
        : [];
    },
  });
  await tools.findIssues({ deliveryId: id, query: "export" });
  const draft = {
    deliveryId: id,
    title: "Export closes window",
    body: "Observed on export.",
  };
  await assert.rejects(tools.createIssue(draft), /issue_write_uncertain/);
  await assert.rejects(tools.createIssue(draft), /issue_write_uncertain/);
  assert.equal(writes, 1);
  landed = true;
  assert.equal((await tools.createIssue(draft)).issueNumber, 302);
  assert.equal(writes, 1);
});

test("an explicit no-Issue decision and known private data cannot create public Issues", async (t) => {
  const { inbox } = fixture(t),
    gh = github();
  const tools = new FeedbackTools(inbox, {
    repo: "example/repo",
    github: gh.request,
  });
  inbox.accept(
    envelope({
      message: {
        type: "text",
        text: "ISSUE258_TEST 测试不创建 Issue",
        content: {},
      },
    }),
  );
  await tools.findIssues({ deliveryId: id, query: "test" });
  inbox.decide(id, "ignored", "Owner explicitly requested no Issue for this item");
  await assert.rejects(tools.createIssue({ deliveryId: id, title: "Test", body: "Test" }), /feedback_already_decided/);
  const real = "c".repeat(64);
  inbox.accept(envelope({ deliveryId: real }));
  await tools.findIssues({ deliveryId: real, query: "export" });
  await assert.rejects(
    tools.createIssue({
      deliveryId: real,
      title: "Export",
      body: "Email user@example.com or 13800138000",
    }),
    /private_data/,
  );
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 0);
});

test("keywords and topic labels do not gate the AI's Issue decision", async (t) => {
  const { inbox } = fixture(t),
    gh = github();
  inbox.accept(
    envelope({
      message: {
        type: "text",
        text: "ISSUE258_TEST 是模块名，帮我创建清理无用助手的任务",
        content: {},
      },
    }),
  );
  const tools = new FeedbackTools(inbox, {
    repo: "example/repo",
    github: gh.request,
  });
  await tools.findIssues({ deliveryId: id, query: "助手" });
  const result = await tools.createIssue({
    deliveryId: id,
    title: "清理无用助手",
    body: "记录用户要求整理助手身份与用途的维护任务。",
  });
  assert.equal(result.issueNumber, 301);
});

test("ignored and duplicate decisions persist without writing GitHub", async (t) => {
  const { inbox } = fixture(t),
    gh = github();
  inbox.accept(envelope());
  const tools = new FeedbackTools(inbox, {
    repo: "example/repo",
    github: gh.request,
  });
  await tools.decide({
    deliveryId: id,
    decision: "ignored",
    reason: "Ordinary conversation",
  });
  assert.equal(inbox.get(id).decision, "ignored");
  await assert.rejects(
    tools.createIssue({ deliveryId: id, title: "Export", body: "Observed" }),
    /feedback_already_decided/,
  );
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 0);
});

test("duplicate feedback links a verified Issue; insufficient evidence stays local", async (t) => {
  const { inbox } = fixture(t),
    gh = github();
  inbox.accept(envelope());
  const tools = new FeedbackTools(inbox, {
    repo: "example/repo",
    github: gh.request,
  });
  await tools.findIssues({ deliveryId: id, query: "export" });
  await tools.decide({
    deliveryId: id,
    decision: "duplicate",
    reason: "Same observed behavior",
    issueNumber: 12,
  });
  assert.equal(inbox.get(id).issueNumber, 12);
  assert.equal(inbox.get(id).decision, "duplicate");
  const another = "c".repeat(64);
  inbox.accept(envelope({ deliveryId: another }));
  await tools.decide({
    deliveryId: another,
    decision: "needs_info",
    reason: "Missing actual behavior",
  });
  assert.equal(inbox.get(another).decision, "needs_info");
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 0);
});

test("concurrent create calls cannot race into two GitHub writes", async (t) => {
  const { inbox } = fixture(t);
  inbox.accept(envelope());
  let release,
    writes = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tools = new FeedbackTools(inbox, {
    repo: "example/repo",
    github: async (method, path) => {
      if (method === "POST") {
        writes++;
        await gate;
        return { number: 303 };
      }
      return path === "search/issues" ? { items: [] } : [];
    },
  });
  await tools.findIssues({ deliveryId: id, query: "export" });
  const draft = { deliveryId: id, title: "Export", body: "Observed behavior" };
  const first = tools.createIssue(draft);
  await assert.rejects(tools.createIssue(draft), /issue_write_uncertain/);
  release();
  await first;
  assert.equal(writes, 1);
  assert.equal(inbox.get(id).issueNumber, 303);
});
