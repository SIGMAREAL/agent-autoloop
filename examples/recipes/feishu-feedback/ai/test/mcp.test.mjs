// Prevent unrelated tools or missing durable decisions on the real MCP stdio transport.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Inbox } from "../intake.mjs";

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
