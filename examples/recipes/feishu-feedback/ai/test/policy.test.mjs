// Prevent feedback Codex from gaining unrelated tools or reporting completion before durable decisions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Inbox } from "../intake.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";

test("feedback Codex preauthorizes only the two approved writes while retaining read-only/no-shell isolation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex"),
    config = join(dir, "config.json");
  writeFileSync(fake, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n", { mode: 0o700 });
  writeFileSync(config, JSON.stringify({ codexProgram: fake, model: "example", effort: "high" }), { mode: 0o600 });
  const result = execFileSync(
    process.execPath,
    [new URL("../codex-wrapper.mjs", import.meta.url).pathname, "exec", "--json", "task"],
    {
      env: { ...process.env, PETWINS_FEEDBACK_AI_CONFIG: config },
      encoding: "utf8",
    },
  );
  const args = JSON.parse(result);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.some((v, i) => v === "--disable" && args[i + 1] === "shell_tool"));
  assert.ok(!args.includes("--trust"));
  assert.ok(args.includes('mcp_servers.feedback.tools.create_issue.approval_mode="approve"'));
  assert.ok(args.includes('mcp_servers.feedback.tools.record_decision.approval_mode="approve"'));
  assert.ok(!args.includes('mcp_servers.feedback.default_tools_approval_mode="approve"'));
  const allow = args.find((v) => v.startsWith("mcp_servers.feedback.enabled_tools="));
  assert.deepEqual(JSON.parse(allow.split("=")[1]).sort(), [
    "create_issue",
    "find_issues",
    "read_context",
    "read_feedback",
    "read_issue",
    "record_decision",
  ]);
  writeFileSync(
    config,
    JSON.stringify({
      codexProgram: fake,
      model: "example",
      effort: "high",
      prRepositoriesFile: join(dir, "private-repos.json"),
    }),
    { mode: 0o600 },
  );
  const configured = JSON.parse(
    execFileSync(
      process.execPath,
      [new URL("../codex-wrapper.mjs", import.meta.url).pathname, "exec", "--json", "task"],
      {
        env: { ...process.env, PETWINS_FEEDBACK_AI_CONFIG: config },
        encoding: "utf8",
      },
    ),
  );
  const enabled = configured.find((v) => v.startsWith("mcp_servers.feedback.enabled_tools="));
  assert.ok(JSON.parse(enabled.split("=")[1]).includes("list_pull_requests"));
  assert.ok(
    !configured.some((v) => v.includes("tools.list_pull_requests.approval_mode")),
    "read-only lookup gets no new write approval",
  );
});

test("a successful model exit is not completion until every feedback has a recorded decision", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-completion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex"),
    config = join(dir, "config.json"),
    context = join(dir, "context.json");
  const id = "a".repeat(64),
    conversation = "b".repeat(64),
    inbox = new Inbox(dir, [conversation]);
  t.after(() => inbox.close());
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId: id,
    source: { conversationId: conversation },
    message: { type: "text", text: "hello", content: {} },
    attachments: [],
  });
  const stream = [
    { type: "thread.started", thread_id: "thread-example" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: {} },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  writeFileSync(fake, "#!/usr/bin/env node\nconsole.log(" + JSON.stringify(stream) + ")\n", {
    mode: 0o700,
  });
  writeFileSync(
    config,
    JSON.stringify({
      codexProgram: fake,
      stateDir: dir,
      contextRoot: dir,
      model: "example",
      effort: "high",
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    context,
    JSON.stringify({
      events: [{ type: "feishu.feedback", detail: JSON.stringify({ deliveryId: id }) }],
    }),
  );
  const run = () =>
    execFileSync(
      process.execPath,
      [new URL("../codex-wrapper.mjs", import.meta.url).pathname, "exec", "--json", "task"],
      {
        env: {
          ...process.env,
          PETWINS_FEEDBACK_AI_CONFIG: config,
          AGENT_AUTOLOOP_CONTEXT: context,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  let failed;
  assert.throws(run, (error) => {
    failed = error;
    return error.status === 1 && String(error.stderr).includes("feedback_decision_missing");
  });
  assert.equal(JSON.parse(String(failed.stdout).trim().split("\n").at(-1)).type, "turn.failed");
  const app = process.env.AGENT_AUTOLOOP_APP || fileURLToPath(new URL("../../../../../", import.meta.url));
  const adapter = (await import(pathToFileURL(join(app, "plugins/codex/agent.ts")))).default;
  const read = adapter.read(String(failed.stdout), 1, String(failed.stderr));
  assert.equal(read.error, "feedback_decision_missing");
  assert.equal(read.session, "thread-example");
  inbox.decide(id, "ignored", "Ordinary conversation");
  const complete = run();
  assert.match(complete, /done/);
  assert.equal(adapter.read(complete, 0, "").error, undefined);
});
