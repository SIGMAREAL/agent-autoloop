// Failure modes: the production channel posts the opaque reference rather than A2UI; retries lose their stable key.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import channel from "../channel.ts";
import { saveView, pullRequestViews } from "../ui.mjs";
import { Avatars } from "../avatars.mjs";

test("the send-only channel resolves a private A2UI artifact and sends bot navigation with native idempotency", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "a2ui-channel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = {
    queriedAt: "2026-11-20T01:00:00Z",
    complete: true,
    total: 1,
    repositories: [
      {
        repository: "example/app",
        complete: true,
        pullRequests: [
          {
            number: 1,
            title: "PR",
            author: "alice",
            url: "https://github.com/example/app/pull/1",
            avatarUrl: "https://avatars.githubusercontent.com/u/123?s=80&v=4",
          },
        ],
      },
    ],
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const assets = new Avatars({
    stateDir: dir,
    scope: "test",
    profile: "test",
    command: [
      process.execPath,
      "-e",
      "console.log(JSON.stringify({ok:true,identity:'bot',data:{image_key:'img_v3_avatar'}}))",
      "--",
    ],
    signal: new AbortController().signal,
    fetch: async () => new Response(png, { headers: { "content-type": "image/png" } }),
  });
  assert.equal(await assets.resolve(result.repositories[0].pullRequests[0].avatarUrl), "img_v3_avatar");
  const view = pullRequestViews(result)[0],
    ref = saveView(dir, view);
  const cfg = join(dir, "config.json"),
    relay = join(dir, "relay.json"),
    capture = join(dir, "sent.json"),
    cli = join(dir, "cli.mjs");
  writeFileSync(relay, JSON.stringify({ chatIds: ["oc_test"] }));
  writeFileSync(
    cfg,
    JSON.stringify({
      stateDir: dir,
      rule: "feedback",
      cardNotifications: { enabled: true, profile: "test", relayConfig: relay, command: [process.execPath, cli] },
    }),
  );
  writeFileSync(
    cli,
    `import {writeFileSync} from 'node:fs';let s='';for await(const c of process.stdin)s+=c;writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),card:JSON.parse(s)}));console.log(JSON.stringify({ok:true,identity:'bot',data:{message_id:'om_test'}}));`,
  );
  const card = {
    id: 12,
    version: 1,
    ref: null,
    kind: "notice",
    state: "closed",
    rule: "feedback",
    title: view.title,
    text: ref,
  };
  const controller = new AbortController();
  let next = true,
    delivered = 0;
  await channel({
    options: { config: cfg },
    signal: controller.signal,
    log: () => {},
    hub: {
      nextCard: async () => {
        if (next) {
          next = false;
          return { card };
        }
        controller.abort();
        return { card: null };
      },
      delivered: async (id, version, ref) => {
        assert.deepEqual([id, version, ref], [12, 1, "om_test"]);
        delivered++;
      },
      failed: async (_id, _v, error) => assert.fail(error),
    },
  });
  assert.equal(delivered, 1);
  const sent = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(sent.card.schema, "2.0");
  assert.ok(JSON.stringify(sent.card).includes('"img_key":"img_v3_avatar"'));
  assert.ok(sent.args.includes("feedback-reply-12"));
  assert.ok(!JSON.stringify(sent.card).includes(ref));
});
