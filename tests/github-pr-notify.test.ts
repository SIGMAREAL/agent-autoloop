// Failure modes: first installation floods a group with old PRs; an unread page or lost hub receipt drops new PRs;
// retries duplicate notifications; event text becomes a command, mention or arbitrary URL; unrelated/private cards go
// to the group; an installed plugin depends on files outside its directory; a sent card is posted again on redelivery.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import type { Adapter } from "../worker/agents.ts";
import type { ChannelContext } from "../host/channels.ts";
import prAgent from "../plugins/github-pr-notify/agent.ts";
import prChannel from "../plugins/github-pr-notify/channel.ts";
import { stablePath } from "../host/node-path.ts";

const typedAgent: Adapter = prAgent;
const typedChannel: (c: ChannelContext) => Promise<void> = prChannel;
assert.ok(typedAgent && typedChannel);

const scratch = mkdtempSync(join(tmpdir(), "autoloop-pr-notify-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const entry = join(import.meta.dirname, "../plugins/github-pr-notify");
const load = async (name: string) => {
  const module = await import(pathToFileURL(join(entry, name + ".ts")).href).catch(() => null);
  assert.ok(module, `missing ${name} plugin implementation`);
  return module;
};
const repo = "example/pet-app";
const config = (name: string) => ({
  enabled: true,
  repositories: [repo],
  stateDir: join(scratch, name),
  hubUrl: "http://127.0.0.1:1",
  sourceKey: "source-test",
  sourceName: "github-pr",
  ghCommand: ["gh"],
  larkCommand: ["lark-cli"],
  profile: "test-bot",
  chatId: "oc_test",
});
const pr = (number: number, title = `PR ${number}`) => ({
  number,
  title,
  user: { login: "author" },
  draft: true,
  state: "closed",
  created_at: "2026-11-20T01:00:00Z",
  html_url: "https://evil.test/ignore",
});
const accepted = () => ({ event: 9, duplicate: false, routed: ["PR 通知"], paused: [] });

test("first successful read establishes a baseline; only later creations emit, including drafts already closed", async () => {
  const { poll } = await load("core");
  const c = config("baseline");
  let list = [pr(12), pr(9)];
  const sent: any[] = [];
  const io = {
    list: async () => list,
    emit: async (event: any) => {
      sent.push(event);
      return accepted();
    },
  };
  assert.equal((await poll(c, io)).baselined, 1);
  assert.equal(sent.length, 0);
  list = [pr(15), pr(14, "🐈".repeat(220)), ...list];
  assert.equal((await poll(c, io)).emitted, 2);
  assert.deepEqual(
    sent.map((e) => JSON.parse(e.detail).number),
    [14, 15],
  );
  assert.equal(sent[0].link, `https://github.com/${repo}/pull/14`);
  assert.ok(sent[0].summary.length <= 200, "hub limit counts UTF-16 units");
  await poll(c, io);
  assert.equal(sent.length, 2);
});

test("unread pages leave the cursor untouched; later pages are read before any handoff", async () => {
  const { poll } = await load("core");
  const c = config("pagination");
  await poll(c, { list: async () => [pr(1)], emit: async () => accepted() });
  let fail = true;
  const sent: any[] = [];
  const list = async (_repo: string, page: number) => {
    if (page === 1) return Array.from({ length: 100 }, (_, i) => pr(102 - i));
    assert.equal(sent.length, 0, "no events before the entire range is read");
    if (fail) throw new Error("GitHub unavailable");
    return [pr(2), pr(1)];
  };
  assert.equal(
    (
      await poll(c, {
        list,
        emit: async (e: any) => {
          sent.push(e);
          return accepted();
        },
      })
    ).errors.length,
    1,
  );
  assert.equal(sent.length, 0);
  fail = false;
  assert.equal(
    (
      await poll(c, {
        list,
        emit: async (e: any) => {
          sent.push(e);
          return accepted();
        },
      })
    ).emitted,
    101,
  );
  assert.deepEqual(
    sent.map((e) => JSON.parse(e.detail).number),
    Array.from({ length: 101 }, (_, i) => i + 2),
  );
});

test("a lost or malformed durable receipt retries the same event without skipping later PRs", async () => {
  const { poll } = await load("core");
  const c = config("lost-ack");
  await poll(c, { list: async () => [pr(1)], emit: async () => accepted() });
  const ids: string[] = [];
  const persisted = new Set<string>();
  let response: unknown = {};
  const io = {
    list: async () => [pr(3), pr(2), pr(1)],
    emit: async (e: any) => {
      ids.push(e.id);
      persisted.add(e.id);
      return response;
    },
  };
  assert.equal((await poll(c, io)).errors.length, 1);
  response = accepted();
  await poll(c, io);
  assert.equal(ids[0], ids[1]);
  assert.equal(persisted.size, 2);
  await poll(c, io);
  assert.equal(ids.length, 3);
});

test("acknowledged PRs keep their cursor when a later handoff fails; other repositories still progress", async () => {
  const { poll } = await load("core");
  const c = { ...config("partial"), repositories: [repo, "example/second"] };
  await poll(c, { list: async () => [pr(1)], emit: async () => accepted() });
  const sent: any[] = [];
  let fail = true;
  const io = {
    list: async () => [pr(3), pr(2), pr(1)],
    emit: async (e: any) => {
      const data = JSON.parse(e.detail);
      if (fail && data.repo === repo && data.number === 3) throw new Error("offline");
      sent.push(data);
      return accepted();
    },
  };
  assert.equal((await poll(c, io)).errors.length, 1);
  fail = false;
  await poll(c, io);
  assert.equal(sent.filter((e) => e.repo === repo && e.number === 2).length, 1);
  assert.equal(sent.length, 4);
});

test("HTTP handoff authenticates only to the configured loopback hub and requires a real receipt", async () => {
  const { postEvent } = await load("core");
  let request: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    request = { path: req.url, auth: req.headers.authorization, data: JSON.parse(body) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(accepted()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const c = { ...config("http"), hubUrl: `http://127.0.0.1:${port}` };
    assert.equal((await postEvent(c, { id: "pr-1" })).event, 9);
    assert.deepEqual(request, { path: "/v1/events", auth: "Bearer source-test", data: { id: "pr-1" } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("notify accepts only its source and allowlist; payload text cannot change URLs, commands or mentions", async () => {
  const { notices, renderCard } = await load("core");
  const c = config("notice");
  const title = "<at id=all></at> ```agent-autoloop $(touch /tmp/owned)";
  const event = {
    source: c.sourceName,
    type: "pull_request.opened",
    detail: JSON.stringify({
      repo,
      number: 8,
      title,
      author: "author",
      draft: true,
      createdAt: "2026-11-20T01:00:00Z",
    }),
  };
  const receipt = notices(c, { events: [event] });
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].fyi, true);
  const card = renderCard(c, { kind: "notice", state: "closed", text: receipt[0].text });
  assert.ok(JSON.stringify(card).includes('"tag":"plain_text"'));
  assert.ok(!JSON.stringify(card).includes('"tag":"lark_md"'));
  assert.equal(card.elements.at(-1).actions[0].url, `https://github.com/${repo}/pull/8`);
  assert.deepEqual(notices(c, { events: [{ ...event, source: "other" }] }), []);
  assert.throws(() => notices(c, { events: [{ ...event, detail: event.detail.replace(repo, "other/repo") }] }));
  assert.throws(() => renderCard(c, { kind: "ask", state: "open", text: receipt[0].text }));
  assert.throws(() => renderCard(c, { kind: "notice", state: "closed", text: "private root alert" }));
});

test("send-only channel uses bot identity and stable key; delivered ref is never posted again", async () => {
  const { notices } = await load("core");
  const { default: channel } = await load("channel");
  const compatible: (c: ChannelContext) => Promise<void> = channel;
  assert.ok(compatible);
  const capture = join(scratch, "cli-capture.json");
  const fake = join(scratch, "lark.mjs");
  writeFileSync(
    fake,
    `import {writeFileSync} from 'node:fs'; let input=''; for await(const c of process.stdin) input+=c;
    writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input:JSON.parse(input)}));
    console.log(JSON.stringify({ok:true,data:{message_id:'om_test'},identity:'bot'}));`,
  );
  const c = { ...config("channel"), larkCommand: [process.execPath, fake] };
  const cfg = join(scratch, "config.json");
  writeFileSync(cfg, JSON.stringify(c));
  const text = notices(c, {
    events: [
      {
        source: c.sourceName,
        type: "pull_request.opened",
        detail: JSON.stringify({
          repo,
          number: 8,
          title: "Hello",
          author: "a",
          draft: false,
          createdAt: "2026-11-20T01:00:00Z",
        }),
      },
    ],
  })[0].text;
  const stop = new AbortController();
  const delivered: any[] = [];
  const queue: any[] = [
    { id: 42, version: 1, ref: null, kind: "notice", state: "closed", text },
    { id: 42, version: 2, ref: "om_test", kind: "notice", state: "closed", text },
    { id: 43, version: 1, ref: null, kind: "notice", state: "closed", text: "private root alert" },
  ];
  const failures: any[] = [];
  await channel({
    options: { config: cfg },
    signal: stop.signal,
    log: () => {},
    hub: {
      nextCard: async () => {
        if (!queue.length) {
          stop.abort();
          return { card: null };
        }
        return { card: queue.shift() };
      },
      delivered: async (...args: any[]) => {
        delivered.push(args);
      },
      failed: async (...args: any[]) => {
        failures.push(args);
      },
    },
  });
  assert.deepEqual(delivered, [
    [42, 1, "om_test"],
    [42, 2, "om_test"],
  ]);
  assert.equal(failures.length, 1);
  const sent = JSON.parse(readFileSync(capture, "utf8"));
  assert.ok(sent.args.includes("bot"));
  assert.ok(sent.args.includes("oc_test"));
  assert.ok(sent.args.includes("test-bot"));
  assert.ok(sent.args.includes("autoloop-pr-42"));
});

test("standard installed adapter runs outside the engine checkout without interpolating event words", async () => {
  const { default: adapter } = await load("agent");
  const compatible: Adapter = adapter;
  assert.ok(compatible);
  const installed = join(scratch, "installed");
  cpSync(entry, installed, { recursive: true });
  const { default: copy } = await import(pathToFileURL(join(installed, "agent.ts")).href);
  const argv = copy.command({ command: ["notify", "/private/config.json"], prompt: "$(touch owned)", cwd: scratch });
  assert.deepEqual(argv.slice(2), ["notify", "/private/config.json"]);
  assert.equal(argv[0], stablePath(process.execPath));
  assert.equal(argv[1], realpathSync(join(installed, "main.ts")));
  assert.deepEqual(copy.read("", null, ""), {});
  assert.deepEqual(copy.read("done", 0, ""), { text: "done" });
  assert.ok(copy.read("", 1, "offline").error);
});

test(
  "an installed adapter survives removal of its running Homebrew Node version",
  {
    skip: process.platform === "win32" ? "Homebrew-specific symlink layout" : false,
  },
  async () => {
    const { nodePath } = await load("node-path");
    const prefix = join(scratch, "brew");
    for (const version of ["24", "26"]) {
      const bin = join(prefix, "Cellar/node", version, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), "node");
    }
    mkdirSync(join(prefix, "opt"));
    const opt = join(prefix, "opt/node");
    symlinkSync(join(prefix, "Cellar/node/26"), opt);
    const old = join(prefix, "Cellar/node/24/bin/node");
    assert.equal(nodePath(old, [prefix]), old, "an installed pinned version stays pinned");
    rmSync(join(prefix, "Cellar/node/24"), { recursive: true });
    assert.equal(nodePath(old, [prefix]), join(opt, "bin/node"), "deleted version uses the live link");
    assert.equal(nodePath(join(prefix, "Cellar/node/26/bin/node"), [prefix]), join(opt, "bin/node"));
    assert.equal(nodePath("/opt/custom/node", [prefix]), "/opt/custom/node");
  },
);

test("CLI output preserves Chinese characters split between byte chunks", async () => {
  const { run } = await load("core");
  const fake = join(scratch, "utf8.mjs");
  writeFileSync(
    fake,
    `const b=Buffer.from(JSON.stringify({title:'新 PR'})); const i=b.indexOf(Buffer.from('新'))+1;
    process.stdout.write(b.subarray(0,i)); setTimeout(()=>process.stdout.write(b.subarray(i)),50);`,
  );
  assert.equal(JSON.parse(await run([process.execPath, fake], [])).title, "新 PR");
});

test("disabling the plugin never acknowledges queued PR work as successfully ignored", async () => {
  const cfg = join(scratch, "disabled.json");
  const ctx = join(scratch, "disabled-context.json");
  const c = { ...config("disabled"), enabled: false };
  writeFileSync(cfg, JSON.stringify(c));
  writeFileSync(
    ctx,
    JSON.stringify({
      events: [
        {
          source: c.sourceName,
          type: "pull_request.opened",
          detail: JSON.stringify({
            repo,
            number: 8,
            title: "Waiting",
            author: "a",
            draft: false,
            createdAt: "2026-11-20T01:00:00Z",
          }),
        },
      ],
    }),
  );
  const result = spawnSync(process.execPath, [join(entry, "main.ts"), "notify", cfg], {
    env: { ...process.env, AGENT_AUTOLOOP_CONTEXT: ctx },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, "a queued event must remain a failed/retryable run, not outcome:nothing");
  assert.match(result.stderr, /停用/);
});

test(
  "a separately installed plugin completes GitHub -> hub -> worker -> FYI -> group, with private defaults local",
  {
    skip: process.platform === "win32" ? "background hub lifecycle is covered by Windows process tests" : false,
  },
  async () => {
    const { poll } = await load("core");
    const home = join(scratch, "real-hub");
    cpSync(entry, join(home, "plugins/github-pr-notify"), { recursive: true });
    cpSync(join(entry, "../../examples/plugins/hello-channel"), join(home, "plugins/local-log"), { recursive: true });
    writeFileSync(join(home, "rules.json"), JSON.stringify({ sources: {}, agents: {}, channels: {}, rules: [] }));
    const cli = join(entry, "../../bin/agent-autoloop.ts");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("AGENT_AUTOLOOP_") && k !== "NODE_TEST_CONTEXT"),
    );
    const childEnv = { ...env, AGENT_AUTOLOOP_HOME: home, SHELL: "/bin/sh" };
    const newKey = (kind: string, name: string) => {
      const out = spawnSync(process.execPath, [cli, "key", "new", kind, name], { env: childEnv, encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      return out.stdout.trim();
    };
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const prs = join(home, "prs.json");
    writeFileSync(prs, JSON.stringify([pr(1)]));
    const gh = join(home, "gh.mjs");
    writeFileSync(
      gh,
      `import {readFileSync} from 'node:fs'; console.log(readFileSync(${JSON.stringify(prs)},'utf8'));`,
    );
    const capture = join(home, "sent.json");
    const lark = join(home, "lark.mjs");
    writeFileSync(
      lark,
      `import {appendFileSync} from 'node:fs'; let body=''; for await(const c of process.stdin)body+=c;
    appendFileSync(${JSON.stringify(capture)},body+'\\n'); console.log(JSON.stringify({ok:true,identity:'bot',data:{message_id:'om_e2e'}}));`,
    );
    const c = {
      ...config("e2e-cursor"),
      hubUrl: `http://127.0.0.1:${port}`,
      sourceKey: newKey("source", "github-pr"),
      ghCommand: [process.execPath, gh],
      larkCommand: [process.execPath, lark],
    };
    const cfg = join(home, "pr.json");
    writeFileSync(cfg, JSON.stringify(c));
    const owner = newKey("owner", "test");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        url: c.hubUrl,
        hub: { listen: `127.0.0.1:${port}` },
        worker: { name: "test", key: newKey("worker", "test") },
        channels: {
          local: { use: "local-log", key: newKey("channel", "local"), file: join(home, "private.log") },
          group: { use: "github-pr-notify", key: newKey("channel", "group"), config: cfg },
        },
      }),
    );
    writeFileSync(
      join(home, "rules.json"),
      JSON.stringify({
        sources: { "github-pr": { name: "PR" } },
        agents: { notify: { name: "PR", worker: "test", use: "github-pr-notify", command: ["notify", cfg] } },
        channels: { local: { name: "本机" }, group: { name: "群" } },
        defaultChannels: ["local"],
        rules: [
          {
            name: "PR 通知",
            when: { source: "github-pr", types: ["pull_request.opened"] },
            to: "notify",
            cwd: home,
            channels: ["group"],
            parallel: 1,
            prompt: "整理新 PR 通知",
          },
        ],
      }),
    );
    assert.equal((await poll(c)).baselined, 1);
    const up = spawn(process.execPath, [cli, "up"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    up.stdout.on("data", (d) => (output += d));
    up.stderr.on("data", (d) => (output += d));
    const until = async (read: () => Promise<boolean> | boolean) => {
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        if (await read()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      const state = await (
        await fetch(c.hubUrl + "/v1/state", { headers: { authorization: `Bearer ${owner}` } })
      ).json();
      assert.fail(output + JSON.stringify({ runs: state.runs, cards: state.cards, recent: state.recentCards }));
    };
    try {
      await until(() =>
        fetch(c.hubUrl + "/healthz")
          .then((r) => r.ok)
          .catch(() => false),
      );
      writeFileSync(prs, JSON.stringify([...Array.from({ length: 12 }, (_, i) => pr(13 - i, "真实链路")), pr(1)]));
      assert.equal((await poll(c)).emitted, 12);
      assert.equal((await poll(c)).emitted, 0);
      await until(() => {
        try {
          return readFileSync(capture, "utf8").trim().split("\n").length === 12;
        } catch {
          return false;
        }
      });
      const privateText = "private operator alert";
      const told = await fetch(c.hubUrl + "/v1/tell", {
        method: "POST",
        headers: { authorization: `Bearer ${c.sourceKey}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "private-alert", text: privateText }),
      });
      assert.equal(told.status, 200);
      await until(() => {
        try {
          return readFileSync(join(home, "private.log"), "utf8").includes(privateText);
        } catch {
          return false;
        }
      });
      const lines = readFileSync(capture, "utf8").trim().split("\n");
      assert.equal(lines.length, 12);
      assert.ok(lines[0].includes("真实链路"));
      assert.ok(!lines[0].includes(privateText));
    } finally {
      up.kill("SIGTERM");
      if (up.exitCode === null) await new Promise((resolve) => up.once("exit", resolve));
    }
  },
);
