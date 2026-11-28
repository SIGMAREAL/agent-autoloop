// Prevent dropped recordings, arbitrary-path uploads, partial-upload duplicate Issues and unbounded video output.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Inbox } from "../intake.mjs";
import { FeedbackTools } from "../tools.mjs";
import { createMediaIssue } from "../media.mjs";

const id = "a".repeat(64),
  conversation = "b".repeat(64);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "feedback-media-"));
  const inbox = new Inbox(dir, [conversation]);
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  bytes.write("ftypisom", 4);
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId: id,
    source: { conversationId: conversation },
    message: { type: "media", text: "异常录屏", content: {} },
    attachments: [
      { status: "available", name: "../../secret.mp4", mimeType: "video/mp4", base64: bytes.toString("base64") },
    ],
  });
  t.after(() => {
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, inbox, bytes };
}
test("recordings above the old 5 MiB limit remain durable and recoverable", (t) => {
  const { inbox, bytes } = fixture(t);
  assert.deepEqual(inbox.readAttachment(id, 0), bytes);
});
test("selected stored media accompanies creation; partial upload never creates a second Issue", async (t) => {
  const { inbox } = fixture(t);
  let writes = 0;
  const tools = new FeedbackTools(inbox, {
    repo: "example/app",
    media: { ghProgram: "/fake/gh" },
    github: async () => [],
    mediaCreate: async ({ files, body, repo }) => {
      writes++;
      assert.equal(repo, "example/app");
      assert.match(body, /petwins-feedback:/);
      assert.deepEqual(files[0].bytes, inbox.readAttachment(id, 0));
      assert.equal(files[0].mimeType, "video/mp4");
      return { number: 31, attachmentsComplete: false };
    },
  });
  await tools.findIssues({ deliveryId: id });
  const args = {
    deliveryId: id,
    title: "宠物行为异常",
    body: "来自实际录屏的反馈",
    attachments: [{ deliveryId: id, index: 0 }],
  };
  const first = await tools.createIssue(args);
  assert.equal(first.issueNumber, 31);
  assert.equal(first.attachmentStatus, "incomplete");
  assert.equal((await tools.createIssue(args)).issueNumber, 31);
  assert.equal(writes, 1);
});
test("operator recovery preserves original intake digest and refuses replacing existing bytes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-recover-"));
  const inbox = new Inbox(dir, [conversation]);
  t.after(() => {
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const e = {
    schema: "petwins.feishu.message.v1",
    deliveryId: id,
    source: { conversationId: conversation },
    message: { type: "media", text: "", content: {} },
    attachments: [{ status: "unavailable", reason: "resource_too_large" }],
  };
  inbox.accept(e);
  const before = inbox.db.prepare("SELECT digest FROM feedback WHERE id=?").get(id).digest;
  inbox.recoverAttachment(id, 0, { bytes: Buffer.from("original media"), mimeType: "video/mp4" });
  assert.equal(inbox.db.prepare("SELECT digest FROM feedback WHERE id=?").get(id).digest, before);
  assert.deepEqual(inbox.readAttachment(id, 0), Buffer.from("original media"));
  inbox.accept(e);
  inbox.decide(id, "needs_info", "Recording was above the old transport limit");
  inbox.reconsiderRecoveredMedia(id, id);
  assert.equal(inbox.get(id).decision, null);
  assert.equal(
    inbox.db.prepare("SELECT decision FROM media_recovery_decisions WHERE feedback_id=?").get(id).decision,
    "needs_info",
  );
  assert.throws(
    () => inbox.recoverAttachment(id, 0, { bytes: Buffer.from("different"), mimeType: "video/mp4" }),
    /already_available/,
  );
});
test("video frames use only stored bytes and explicit bounded timestamps", async (t) => {
  const { inbox, dir } = fixture(t);
  const fake = join(dir, "ffmpeg");
  writeFileSync(fake, "#!/usr/bin/env node\nprocess.stdout.write(Buffer.from([255,216,255,217]));", { mode: 0o700 });
  const tools = new FeedbackTools(inbox, { repo: "example/app", media: { ffmpegProgram: fake } });
  const result = await tools.readVideoFrames({ deliveryId: id, index: 0, seconds: [0, 12] });
  assert.equal(result.content.filter((c) => c.type === "image").length, 2);
  assert.match(result.content[0].text, /12/);
  await assert.rejects(tools.readVideoFrames({ deliveryId: id, index: 0, seconds: [-1] }), /invalid_video_times/);
});
test("the official CLI partial-success receipt is retained and source filenames cannot select paths", async (t) => {
  const { dir } = fixture(t);
  const fake = join(dir, "gh");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import fs from 'node:fs';import assert from 'node:assert/strict';
const args=process.argv.slice(2),file=args[args.indexOf('--attach')+1],body=args[args.indexOf('--body-file')+1];
assert.ok(file.endsWith('/evidence-1.mp4'));assert.equal(fs.readFileSync(file,'utf8'),'stored video');assert.match(fs.readFileSync(body,'utf8'),/marker/);
console.log('https://github.com/example/app/issues/51');process.exit(1);
`,
    { mode: 0o700 },
  );
  assert.deepEqual(
    await createMediaIssue(
      {
        repo: "example/app",
        title: "video",
        body: "marker",
        files: [{ bytes: Buffer.from("stored video"), mimeType: "video/mp4" }],
      },
      { ghProgram: fake },
    ),
    { number: 51, attachmentsComplete: false },
  );
});
test("an old GitHub CLI is rejected before claiming an uncertain Issue write", async (t) => {
  const { inbox, dir } = fixture(t);
  const fake = join(dir, "old-gh");
  writeFileSync(fake, "#!/usr/bin/env node\nconsole.log('Usage: gh issue create');", { mode: 0o700 });
  const tools = new FeedbackTools(inbox, { repo: "example/app", media: { ghProgram: fake }, github: async () => [] });
  await tools.findIssues({ deliveryId: id });
  await assert.rejects(
    tools.createIssue({ deliveryId: id, title: "test", body: "test", attachments: [{ deliveryId: id, index: 0 }] }),
    /github_media_cli_upgrade_required/,
  );
  assert.equal(inbox.get(id).creationState, null);
});
