// Prevent unrelated tools or missing durable decisions on the real MCP stdio transport.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Inbox } from "../intake.mjs";

test("meeting tools bind reads to shared links and retain every planned decision on the real MCP transport", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "meeting-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deliveryId = "a".repeat(64),
    conversation = "b".repeat(64),
    url = "https://my.feishu.cn/docx/abcdefghijklmnopqrstuvwxyz1";
  const inbox = new Inbox(dir, [conversation]);
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId,
    source: { conversationId: conversation },
    message: { type: "text", text: url, content: {} },
    attachments: [],
  });
  inbox.close();
  const cli = join(dir, "document.mjs");
  writeFileSync(
    cli,
    `console.log(JSON.stringify({ok:true,identity:'bot',data:{document:{content:'# 周会\\n讨论了两个待办'}}}))`,
  );
  const cfg = join(dir, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      stateDir: dir,
      contextRoot: dir,
      allowedConversations: [conversation],
      repo: "example/app",
      multiIssue: true,
      documents: { enabled: true, identity: "bot", profile: "test", command: [process.execPath, cli] },
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "meeting-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../mcp.mjs", import.meta.url).pathname, "--config", cfg],
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.find((t) => t.name === "read_shared_document")?.annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "plan_actions")?.annotations.readOnlyHint, false);
  const denied = await client.callTool({
    name: "read_shared_document",
    arguments: { deliveryId, url: url.replace("abcdefghijklmnopqrstuvwxyz1", "otherdocument") },
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /document_not_shared/);
  const read = await client.callTool({ name: "read_shared_document", arguments: { deliveryId, url } });
  assert.match(read.content[0].text, /两个待办/);
  const planned = await client.callTool({
    name: "plan_actions",
    arguments: {
      deliveryId,
      actions: [
        { key: "one", description: "第一项" },
        { key: "two", description: "第二项" },
      ],
    },
  });
  assert.equal(planned.isError, undefined);
  assert.match(planned.content[0].text, /第一项/);
  for (const actionKey of ["one", "two"]) {
    const result = await client.callTool({
      name: "record_decision",
      arguments: { deliveryId, actionKey, decision: "ignored", reason: "仅需总结" },
    });
    assert.equal(result.isError, undefined);
  }
  const feedback = await client.callTool({ name: "read_feedback", arguments: { deliveryId } });
  const row = JSON.parse(feedback.content[0].text);
  assert.equal(row.decision, "ignored");
  assert.equal(row.actionPlan.length, 2);
});

test("real MCP transport exposes only feedback and Issue tools, never code or Feishu writes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const conversation = "b".repeat(64),
    deliveryId = "a".repeat(64);
  const inbox = new Inbox(dir, [conversation]);
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId,
    source: { conversationId: conversation },
    message: { type: "text", text: "hello", content: {} },
    attachments: [],
  });
  inbox.close();
  const cfg = join(dir, "config.json");
  const context = join(dir, "context.json");
  writeFileSync(
    context,
    JSON.stringify({
      events: [{ detail: JSON.stringify({ deliveryId }) }],
      answers: [],
    }),
  );
  writeFileSync(
    cfg,
    JSON.stringify({
      stateDir: dir,
      contextRoot: dir,
      allowedConversations: [conversation],
      repo: "example/repo",
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "feedback-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../mcp.mjs", import.meta.url).pathname, "--config", cfg],
    env: { AGENT_AUTOLOOP_CONTEXT: context },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
    "create_issue",
    "find_issues",
    "read_context",
    "read_feedback",
    "read_issue",
    "record_decision",
  ]);
  const current = await client.callTool({
    name: "read_context",
    arguments: {},
  });
  assert.equal(JSON.parse(JSON.parse(current.content[0].text).result.events[0].detail).deliveryId, deliveryId);
  const feedback = await client.callTool({
    name: "read_feedback",
    arguments: { deliveryId },
  });
  assert.equal(JSON.parse(feedback.content[0].text).message.text, "hello");
  const decision = await client.callTool({
    name: "record_decision",
    arguments: {
      deliveryId,
      decision: "ignored",
      reason: "ordinary conversation",
    },
  });
  assert.equal(decision.isError, undefined);
});

test("configured PR lookup is read-only and refuses repositories outside the private allowlist", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-pr-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repos = join(dir, "repos.json"),
    cfg = join(dir, "config.json");
  writeFileSync(repos, JSON.stringify(["example/app"]), { mode: 0o600 });
  writeFileSync(
    cfg,
    JSON.stringify({
      stateDir: dir,
      contextRoot: dir,
      allowedConversations: ["b".repeat(64)],
      repo: "example/app",
      prRepositoriesFile: repos,
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "pr-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../mcp.mjs", import.meta.url).pathname, "--config", cfg],
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const query = tools.find((tool) => tool.name === "list_pull_requests");
  assert.ok(query, "the configured read-only PR query must be available");
  assert.equal(query.annotations.readOnlyHint, true);
  const result = await client.callTool({ name: "list_pull_requests", arguments: { repository: "other/private" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unauthorized_repository/);
});
