// Failure modes: repeated authors upload on every reply; another app reuses an incompatible key; failures suppress
// answers; a view causes arbitrary network access, an unbounded download, or a user-identity upload.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = "https://avatars.githubusercontent.com/u/123?s=80&v=4";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("repeated authors share one bot upload, cached across cards and isolated by application", async (t) => {
  const { Avatars } = await import("../avatars.mjs");
  const dir = mkdtempSync(join(tmpdir(), "a2ui-avatar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "cli.mjs"),
    capture = join(dir, "uploads.jsonl");
  writeFileSync(
    cli,
    `import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);if(a[a.indexOf('--file')+1]!=='image=-')process.exit(2);let size=0;for await(const c of process.stdin)size+=c.length;if(!size)process.exit(3);appendFileSync(${JSON.stringify(capture)},JSON.stringify(a)+'\\n');console.log(JSON.stringify({ok:true,identity:'bot',data:{image_key:'img_v3_avatar'}}));`,
  );
  let downloads = 0;
  const options = {
    stateDir: dir,
    profile: "existing",
    scope: "cli_app",
    command: [process.execPath, cli],
    fetch: async () => {
      downloads++;
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
    signal: new AbortController().signal,
    log: () => {},
  };
  const a = new Avatars(options);
  assert.deepEqual(await Promise.all([a.resolve(url), a.resolve(url)]), ["img_v3_avatar", "img_v3_avatar"]);
  assert.equal(await new Avatars(options).resolve(url), "img_v3_avatar");
  assert.equal(downloads, 1);
  await new Avatars({ ...options, scope: "another_app" }).resolve(url);
  assert.equal(downloads, 2);
  const calls = readFileSync(capture, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((a) => a.includes("bot") && a.includes("existing") && a.includes('{"image_type":"message"}')));
});

test("unsafe sources, failed and oversized responses leave text replies available", async (t) => {
  const { Avatars } = await import("../avatars.mjs");
  const dir = mkdtempSync(join(tmpdir(), "a2ui-avatar-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const options = {
    stateDir: dir,
    profile: "existing",
    scope: "cli_app",
    command: [process.execPath],
    signal: new AbortController().signal,
    log: () => {},
    fetch: async () => {
      calls++;
      throw Error("offline");
    },
  };
  const a = new Avatars(options);
  assert.equal(await a.resolve("http://127.0.0.1/private"), null);
  assert.equal(calls, 0);
  assert.equal(await a.resolve(url), null);
  assert.equal(
    await new Avatars({
      ...options,
      fetch: async () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
    }).resolve(url),
    null,
  );
});
