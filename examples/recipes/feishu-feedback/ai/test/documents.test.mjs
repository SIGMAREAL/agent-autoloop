// Failure modes: the model reads an unshared URL/another host, identity silently escalates, long text is presented
// as complete, replay reads a changed meeting, or a transcript path/CLI process escapes private bounded storage.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../intake.mjs";

const id = "a".repeat(64),
  conversation = "b".repeat(64);
const doc = "https://my.feishu.cn/docx/abcdefghijklmnopqrstuvwxyz1";
const wiki = "https://my.feishu.cn/wiki/abcdefghijklmnopqrstuvwxyz2";
const minute = "https://my.feishu.cn/minutes/obcexampleminutes123456789";
async function fixture(t, body, url = doc) {
  const dir = mkdtempSync(join(tmpdir(), "meeting-document-"));
  const inbox = new Inbox(dir, [conversation]);
  inbox.accept({
    schema: "petwins.feishu.message.v1",
    deliveryId: id,
    source: { conversationId: conversation },
    message: {
      type: "post",
      text: "请读这份纪要",
      content: { zh_cn: { content: [[{ tag: "a", href: url, text: "会议纪要" }]] } },
    },
    attachments: [],
  });
  const cli = join(dir, "cli.mjs"),
    calls = join(dir, "calls.jsonl"),
    source = join(dir, "source.json");
  writeFileSync(
    source,
    JSON.stringify({
      ok: true,
      identity: "bot",
      data: { document: { revision_id: 7, content: "# 周会\n" + "正文".repeat(15000) } },
    }),
  );
  writeFileSync(
    cli,
    `import {appendFileSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
    const args=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
    ${body || `console.log(readFileSync(${JSON.stringify(source)},'utf8'));`}`,
  );
  t.after(() => {
    inbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { Documents } = await import("../documents.mjs").catch(() => ({}));
  assert.equal(typeof Documents, "function", "a shared document reader must be available");
  const reader = new Documents(inbox, {
    stateDir: dir,
    documents: { enabled: true, command: [process.execPath, cli], profile: "test-bot", identity: "bot" },
  });
  return { dir, inbox, reader, calls, source };
}

test("a shared document has paged, immutable private content and an explicit bot identity", async (t) => {
  const { reader, calls, source } = await fixture(t);
  const page = await reader.read({ deliveryId: id, url: doc, limit: 2000 });
  assert.equal(page.kind, "docx");
  assert.equal(page.revision, 7);
  assert.equal(page.text.length, 2000);
  assert.equal(page.nextOffset, 2000);
  assert.equal(page.partial, false);
  writeFileSync(source, JSON.stringify({ ok: true, identity: "bot", data: { document: { content: "changed" } } }));
  const next = await reader.read({ deliveryId: id, url: doc, offset: page.nextOffset, limit: 2000 });
  assert.equal(next.snapshotId, page.snapshotId);
  assert.ok(!next.text.includes("changed"));
  const invocations = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0][invocations[0].indexOf("--as") + 1], "bot");
  assert.equal(invocations[0][invocations[0].indexOf("--profile") + 1], "test-bot");
  assert.ok(invocations[0].includes("+fetch"));
  assert.ok(invocations[0].includes("markdown"));
});

test("Wiki links use the same document reader; a shared selection retains its scope", async (t) => {
  const url = wiki + "#share-abc123";
  const { reader, calls } = await fixture(t, null, url);
  const result = await reader.read({ deliveryId: id, url });
  assert.equal(result.kind, "wiki");
  assert.equal(result.coverage, "shared_selection");
  assert.ok(readFileSync(calls, "utf8").includes("#share-abc123"));
});

test("unshared links, other hosts, credentials and revoked conversations never reach the CLI", async (t) => {
  const { reader, calls, inbox } = await fixture(t);
  for (const url of [
    doc.replace("abcdefghijklmnopqrstuvwxyz1", "otherdocument"),
    doc.replace("my.feishu.cn", "my.feishu.cn.evil.test"),
    doc.replace("https://", "https://user:pass@"),
    doc.replace("my.feishu.cn", "my.feishu.cn:444"),
    "file:///etc/passwd",
  ])
    await assert.rejects(reader.read({ deliveryId: id, url }), /invalid_document_link|document_not_shared/);
  inbox.allowed.clear();
  await assert.rejects(reader.read({ deliveryId: id, url: doc }), /unauthorized_conversation/);
  assert.throws(() => readFileSync(calls), /ENOENT/);
});

test("Minutes include requested artifacts and a bounded transcript from a private CLI output directory", async (t) => {
  const body = `const dir=args[args.indexOf('--output-dir')+1];mkdirSync(dir,{recursive:true});const file=join(dir,'transcript.txt');writeFileSync(file,'主持人：确认修复导出，再改进入门引导。');
    console.log(JSON.stringify({ok:true,identity:'bot',data:{minutes:[{title:'周会',artifacts:{summary:'两个任务',todos:[{content:'修复导出'}],transcript_file:file}}]}}));`;
  const { reader, calls } = await fixture(t, body, minute);
  const result = await reader.read({ deliveryId: id, url: minute });
  assert.equal(result.kind, "minutes");
  assert.equal(result.partial, false);
  assert.match(result.text, /主持人/);
  assert.match(result.text, /两个任务/);
  assert.match(result.text, /修复导出/);
  const [args] = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  for (const flag of ["+detail", "--summary", "--todo", "--chapter", "--transcript"]) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--output-dir") + 1], ".", "official CLI output paths must be relative");
});

test("permission failures are explicit and never switch to personal identity; missing transcripts stay partial", async (t) => {
  const { reader, source, calls } = await fixture(t);
  writeFileSync(
    source,
    JSON.stringify({
      ok: false,
      identity: "bot",
      error: { type: "authorization", subtype: "app_scope_not_applied", missing_scopes: ["docx:document:readonly"] },
    }),
  );
  await assert.rejects(
    reader.read({ deliveryId: id, url: doc }),
    (e) => e.message === "document_permission_required" && e.requiredScopes.includes("docx:document:readonly"),
  );
  writeFileSync(
    source,
    JSON.stringify({ ok: true, identity: "user", data: { document: { content: "must not read" } } }),
  );
  await assert.rejects(reader.read({ deliveryId: id, url: doc }), /document_identity_mismatch/);
  const separate = await fixture(
    t,
    `console.log(JSON.stringify({ok:true,identity:'bot',data:{minutes:[{title:'周会',artifacts:{summary:'摘要'}}]}}))`,
    minute,
  );
  const result = await separate.reader.read({ deliveryId: id, url: minute });
  assert.equal(result.partial, true);
  assert.ok(!readFileSync(calls, "utf8").includes('"user"'));
});

test("real Minutes partial-failure envelopes distinguish processing and resource access", async (t) => {
  const f = await fixture(t, null, minute);
  writeFileSync(
    f.source,
    JSON.stringify({
      ok: false,
      identity: "bot",
      data: {
        minutes: [
          {
            minute_token: "obcexampleminutes123456789",
            status: "processing",
            retryable: true,
            error: "artifacts are generating",
          },
        ],
      },
    }),
  );
  await assert.rejects(f.reader.read({ deliveryId: id, url: minute }), /document_not_ready/);
  writeFileSync(
    f.source,
    JSON.stringify({
      ok: false,
      identity: "bot",
      data: {
        minutes: [
          {
            minute_token: "obcexampleminutes123456789",
            error:
              "No read permission for minute obcexampleminutes123456789. Ask the user before running: minutes +apply-permission ...",
          },
        ],
      },
    }),
  );
  await assert.rejects(f.reader.read({ deliveryId: id, url: minute }), /document_permission_required/);
});

test("a transcript outside the private output directory is rejected", async (t) => {
  const { reader } = await fixture(
    t,
    `console.log(JSON.stringify({ok:true,identity:'bot',data:{minutes:[{title:'周会',artifacts:{transcript_file:process.execPath}}]}}))`,
    minute,
  );
  await assert.rejects(reader.read({ deliveryId: id, url: minute }), /unsafe_transcript_path/);
});

test("CLI output and cancellation are bounded and leave no running read", async (t) => {
  const large = await fixture(t, `process.stdout.write('x'.repeat(3*1024*1024));`);
  await assert.rejects(large.reader.read({ deliveryId: id, url: doc }), /document_output_too_large/);
  const blocked = await fixture(t, `setInterval(()=>{},1000);`);
  await assert.rejects(
    blocked.reader.read({ deliveryId: id, url: doc }, AbortSignal.timeout(40)),
    /document_read_cancelled|document_read_timeout/,
  );
});

test("cancelling the official npm-style wrapper also stops its native child", async (t) => {
  const f = await fixture(
    t,
    `import {execFileSync} from 'node:child_process';
    execFileSync(process.execPath,[new URL('./leaf.mjs',import.meta.url).pathname],{stdio:'inherit'});`,
  );
  const ready = join(f.dir, "ready"),
    finished = join(f.dir, "finished");
  writeFileSync(
    join(f.dir, "leaf.mjs"),
    `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(ready)},'ready');
    setTimeout(()=>writeFileSync(${JSON.stringify(finished)},'continued after cancellation'),700);`,
  );
  const controller = new AbortController();
  const read = f.reader.read({ deliveryId: id, url: doc }, controller.signal);
  for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(ready));
  controller.abort();
  await assert.rejects(read, /document_read_cancelled/);
  assert.equal(existsSync(finished), false, "the native subprocess must not continue after cancellation");
});
