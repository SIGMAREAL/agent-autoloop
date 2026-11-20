// Failure modes: answers remain only in the worker log; a reply goes to another group; an unrelated/interactive card
// leaks through this send-only channel; delivery retries post twice; untrusted words become formatting or CLI arguments.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import type { ChannelContext } from "../host/channels.ts";
import replies from "../plugins/feishu-replies/channel.ts";

const compatible: (context: ChannelContext) => Promise<void> = replies;
assert.ok(compatible);

const root = join(import.meta.dirname, "..");
const entry = join(root, "plugins/feishu-replies");
const scratch = mkdtempSync(join(tmpdir(), "feishu-replies-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const load = async () => {
  const module = await import(pathToFileURL(join(entry, "channel.ts")).href).catch(() => null);
  assert.ok(module, "missing native FYI reply channel");
  return module;
};
const rule = "群消息处理";
const card = {
  id: 7,
  version: 1,
  ref: null,
  kind: "notice",
  state: "closed",
  rule,
  title: "回复",
  text: "答案是 42。\n<at id=all></at> $(touch owned)",
  options: [],
};

function settings(dir: string, command: string[], chats = ["oc_test"]) {
  mkdirSync(dir, { recursive: true });
  const relay = join(dir, "relay.json"),
    config = join(dir, "ai.json");
  writeFileSync(relay, JSON.stringify({ chatIds: chats }), { mode: 0o600 });
  writeFileSync(
    config,
    JSON.stringify({
      rule,
      cardNotifications: {
        enabled: true,
        command,
        profile: "existing-bot",
        relayConfig: relay,
      },
    }),
    { mode: 0o600 },
  );
  return config;
}

test("answers render as plain text and only the configured rule's closed FYI is eligible", async () => {
  const { renderReply } = await load();
  const payload = renderReply(card, rule);
  assert.equal(payload.elements[0].text.tag, "plain_text");
  assert.equal(payload.elements[0].text.content, card.text);
  assert.throws(() => renderReply({ ...card, rule: "other" }, rule));
  assert.throws(() => renderReply({ ...card, kind: "ask", state: "open" }, rule));
  assert.throws(() => renderReply({ ...card, state: "open" }, rule));
});

test("native redelivery keeps one bot message in the existing group using the same idempotency key", async () => {
  const { default: channel } = await load();
  const dir = join(scratch, "delivery");
  mkdirSync(dir);
  const capture = join(dir, "sent.jsonl"),
    fake = join(dir, "lark.mjs");
  writeFileSync(
    fake,
    `import {appendFileSync} from 'node:fs'; let body=''; for await(const c of process.stdin)body+=c;
    appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),body:JSON.parse(body)})+'\\n');
    console.log(JSON.stringify({ok:true,identity:'bot',data:{message_id:'om_reply'}}));`,
  );
  const cfg = settings(dir, [process.execPath, fake]);
  const queue = [card, { ...card, version: 2, ref: "om_reply" }, { ...card, id: 8, rule: "other" }];
  const stop = new AbortController(),
    delivered: any[] = [],
    failed: any[] = [];
  await channel({
    options: { config: cfg },
    log: () => {},
    signal: stop.signal,
    hub: {
      nextCard: async () => {
        if (!queue.length) stop.abort();
        return { card: queue.shift() ?? null };
      },
      delivered: async (...args: any[]) => {
        delivered.push(args);
      },
      failed: async (...args: any[]) => {
        failed.push(args);
      },
    },
  });
  assert.deepEqual(delivered, [
    [7, 1, "om_reply"],
    [7, 2, "om_reply"],
  ]);
  assert.equal(failed.length, 1);
  const lines = readFileSync(capture, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const { args, body } = JSON.parse(lines[0]);
  assert.ok(args.includes("bot"));
  assert.ok(args.includes("oc_test"));
  assert.ok(args.includes("existing-bot"));
  assert.ok(args.includes("feedback-reply-7"));
  assert.ok(!args.some((arg: string) => arg.includes("touch owned")));
  assert.equal(body.elements[0].text.content, card.text);
});

test("multiple authorized groups fail closed until a per-conversation route is configured", async () => {
  const { default: channel } = await load();
  const cfg = settings(join(scratch, "multi"), [process.execPath], ["oc_first", "oc_second"]);
  const stop = new AbortController();
  const failed: any[] = [];
  let first = true;
  await channel({
    options: { config: cfg },
    log: () => {},
    signal: stop.signal,
    hub: {
      nextCard: async () => {
        if (first) {
          first = false;
          return { card };
        }
        stop.abort();
        return { card: null };
      },
      delivered: async () => assert.fail("must not send a reply to a guessed group"),
      failed: async (...args: any[]) => {
        failed.push(args);
      },
    },
  });
  assert.equal(failed.length, 1);
  assert.match(failed[0][2], /single_authorized_chat_required/);
});

test(
  "an installed channel receives an Agent's native notice through a real temporary hub",
  {
    skip: process.platform === "win32" ? "background hub lifecycle has separate native Windows coverage" : false,
  },
  async () => {
    await load();
    const home = join(scratch, "hub");
    cpSync(entry, join(home, "plugins/feishu-replies"), { recursive: true });
    const relayCfg = settings(home, [process.execPath, join(home, "lark.mjs")]);
    const capture = join(home, "answer.jsonl");
    writeFileSync(
      join(home, "lark.mjs"),
      `import {appendFileSync} from 'node:fs'; let body=''; for await(const c of process.stdin)body+=c;
    appendFileSync(${JSON.stringify(capture)},body+'\\n');console.log(JSON.stringify({ok:true,identity:'bot',data:{message_id:'om_e2e'}}));`,
    );
    const reply =
      "回答完成。\n```agent-autoloop\n" +
      JSON.stringify({ notice: [{ title: "回复", text: "四十二。", key: "question-1", fyi: true }] }) +
      "\n```";
    const agent = join(home, "agent.mjs");
    writeFileSync(agent, `console.log(${JSON.stringify(reply)});`);
    writeFileSync(
      join(home, "rules.json"),
      JSON.stringify({
        sources: { local: { name: "群消息" } },
        agents: { a: { name: "测试 Agent", worker: "test", use: "command", command: [process.execPath, agent] } },
        channels: { replies: { name: "回复" } },
        rules: [
          {
            name: rule,
            when: { source: "local", types: ["question"] },
            to: "a",
            cwd: home,
            prompt: "回答问题",
            tell: "needed",
            channels: ["replies"],
          },
        ],
      }),
    );
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("AGENT_AUTOLOOP_") && k !== "NODE_TEST_CONTEXT"),
      ),
      AGENT_AUTOLOOP_HOME: home,
      SHELL: "/bin/sh",
    };
    const cli = join(root, "bin/agent-autoloop.ts");
    const key = (kind: string, name: string) => {
      const r = spawnSync(process.execPath, [cli, "key", "new", kind, name], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const sourceKey = key("source", "local");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    const url = `http://127.0.0.1:${port}`;
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        url,
        hub: { listen: `127.0.0.1:${port}` },
        worker: { name: "test", key: key("worker", "test") },
        channels: {
          replies: {
            use: "feishu-replies",
            key: key("channel", "replies"),
            config: relayCfg,
          },
        },
      }),
    );
    const up = spawn(process.execPath, [cli, "up"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    up.stdout.on("data", (b) => (logs += b));
    up.stderr.on("data", (b) => (logs += b));
    const until = async (read: () => Promise<boolean> | boolean) => {
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        if (await read()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(logs || "temporary hub timed out");
    };
    try {
      await until(() =>
        fetch(url + "/healthz")
          .then((r) => r.ok)
          .catch(() => false),
      );
      const post = () =>
        fetch(url + "/v1/events", {
          method: "POST",
          headers: { authorization: `Bearer ${sourceKey}`, "content-type": "application/json" },
          body: JSON.stringify({ id: "q1", type: "question", subject: "chat", summary: "提问" }),
        });
      assert.equal((await post()).status, 200);
      await until(() => {
        try {
          return readFileSync(capture, "utf8").includes("四十二");
        } catch {
          return false;
        }
      });
      assert.equal((await (await post()).json()).duplicate, true);
      assert.equal(readFileSync(capture, "utf8").trim().split("\n").length, 1);
    } finally {
      up.kill("SIGTERM");
      if (up.exitCode === null) await new Promise((r) => up.once("exit", r));
    }
  },
);
