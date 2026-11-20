// Prevent wrong-recipient cards, repeated sends and loss of unknown delivery outcomes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Inbox } from "../intake.mjs";
import { notifyOne, createCardSender } from "../notifications.mjs";
import { renderA2ui } from "@agent-autoloop/feishu-a2ui";

const id = "a".repeat(64),
  chat = "oc_example";
const conversation = createHash("sha256").update(chat).digest("hex");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "feedback-cards-"));
  const inbox = new Inbox(dir, [conversation]);
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId: id,
    source: { conversationId: conversation },
    message: { type: "text", text: "请记录清理无用助手的任务", content: {} },
    attachments: [],
  });
  t.after(() => {
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return inbox;
}
const issue = async () => ({
  number: 301,
  title: "清理重复助手 @all",
  html_url: "https://evil.invalid",
  user: { login: "alice", avatar_url: "https://avatars.githubusercontent.com/u/123?v=4" },
  state: "open",
  created_at: "2026-11-19T02:03:00Z",
  updated_at: "2026-11-20T00:05:00Z",
});

test("a committed new Issue queues exactly one fixed original-group card", async (t) => {
  const inbox = fixture(t);
  inbox.decide(id, "created", "New maintenance task", 301);
  const sent = [];
  const options = {
    repo: "example/repo",
    getIssue: issue,
    renderView: (view) => renderA2ui(view, { image: async () => "img_issue_author" }),
    sendCard: async (value) => {
      sent.push(value);
      return "om_receipt";
    },
  };
  await notifyOne(inbox, options);
  await notifyOne(inbox, options);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, conversation);
  assert.ok(sent[0].key.length <= 50);
  const card = JSON.parse(sent[0].payload);
  assert.equal(card.schema, "2.0", "the real Issue outbox must use the shared A2UI adapter");
  assert.equal(card.header.title.tag, "plain_text");
  assert.equal(card.body.elements[0].text.tag, "plain_text");
  assert.equal(card.body.elements[1].behaviors[0].default_url, "https://github.com/example/repo/issues/301");
  for (const field of ["作者：alice", "img_issue_author", "创建：2026-11-19 10:03", "更新：2026-11-20 08:05"])
    assert.ok(JSON.stringify(card).includes(field), field);
  assert.deepEqual(inbox.cardCounts(), { sent: 1 });
  inbox.queueCard(id);
  assert.deepEqual(inbox.cardCounts(), { sent: 1 });
});

test("unknown card send outcome and interrupted sends are held, not repeated", async (t) => {
  const inbox = fixture(t);
  inbox.decide(id, "created", "New task", 301);
  let calls = 0;
  const options = {
    repo: "example/repo",
    getIssue: issue,
    sendCard: async () => {
      calls++;
      throw new Error("network_lost");
    },
  };
  await notifyOne(inbox, options);
  await notifyOne(inbox, options);
  assert.equal(calls, 1);
  assert.deepEqual(inbox.cardCounts(), { uncertain: 1 });
  inbox.db.prepare("UPDATE issue_cards SET state='sending'").run();
  inbox.recoverCards();
  assert.deepEqual(inbox.cardCounts(), { uncertain: 1 });
});

test("ordinary decisions create no outgoing card and definite rejections can be retried explicitly", async (t) => {
  const inbox = fixture(t);
  inbox.decide(id, "ignored", "Nothing to record");
  assert.deepEqual(inbox.cardCounts(), {});
  assert.throws(() => inbox.queueCard(id), /created_issue_required/);
  const second = "b".repeat(64);
  inbox.db
    .prepare(
      "INSERT INTO feedback(id,digest,envelope,decision,issue) SELECT ?,digest,envelope,'created',302 FROM feedback WHERE id=?",
    )
    .run(second, id);
  inbox.queueCard(second);
  await notifyOne(inbox, {
    repo: "example/repo",
    getIssue: async () => ({ number: 302, title: "New task" }),
    sendCard: async () => {
      throw Object.assign(new Error("permission_denied"), {
        definitelyNotSent: true,
      });
    },
  });
  assert.deepEqual(inbox.cardCounts(), { rejected: 1 });
  assert.equal(inbox.retryRejectedCards(), 1);
  assert.deepEqual(inbox.cardCounts(), { pending: 1 });
  const frozen = inbox.nextCard().payload;
  await notifyOne(inbox, {
    repo: "example/repo",
    getIssue: async () => assert.fail("a retry must not refetch frozen metadata"),
    renderView: async () => assert.fail("a retry must not restyle a frozen payload"),
    sendCard: async ({ payload }) => {
      assert.equal(payload, frozen);
      return "om_retry";
    },
  });
  assert.deepEqual(inbox.cardCounts(), { sent: 1 });
});

test("the CLI sender fixes bot identity and recipient, passing card JSON through stdin", async () => {
  const calls = [];
  const send = createCardSender(
    {
      program: "/official/lark-cli",
      profile: "configured-app",
      chatIds: [chat],
    },
    async (program, args, input) => {
      calls.push({ program, args, input });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          identity: "bot",
          data: { message_id: "om_receipt" },
        }),
        stderr: "",
      };
    },
  );
  assert.equal(
    await send({
      conversationId: conversation,
      payload: '{"card":"public issue only"}',
      key: "feedback-301",
    }),
    "om_receipt",
  );
  assert.ok(calls[0].args.includes("--as"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--as") + 1], "bot");
  assert.equal(calls[0].args[calls[0].args.indexOf("--chat-id") + 1], chat);
  assert.equal(calls[0].input, '{"card":"public issue only"}');
  await assert.rejects(send({ conversationId: "f".repeat(64), payload: "{}", key: "x" }), /unauthorized_conversation/);
  assert.equal(calls.length, 1);
});
