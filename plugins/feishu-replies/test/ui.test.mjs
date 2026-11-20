// Failure modes: a template masquerades as A2UI; bindings, PR links, authors or times are lost; partial coverage looks
// complete; unsupported executable actions run; a model-controlled reference escapes the private artifact directory.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ui = () => import("../ui.mjs");
const result = {
  queriedAt: "2026-11-20T01:00:00.000Z",
  complete: true,
  total: 1,
  repositories: [
    {
      repository: "example/app",
      complete: true,
      pullRequests: [
        {
          number: 42,
          title: "修复 [链接] <at id=all></at>",
          author: "alice",
          draft: true,
          url: "https://github.com/example/app/pull/42",
          createdAt: "2026-11-19T02:03:00.000Z",
          updatedAt: "2026-11-20T00:05:00.000Z",
        },
      ],
    },
  ],
};

test("official A2UI resolves PR data bindings into native links, author and labelled Shanghai times", async () => {
  const { pullRequestViews, renderA2ui } = await ui();
  const [view] = pullRequestViews(result);
  assert.equal(view.messages[0].version, "1.0");
  assert.equal(
    view.messages[0].createSurface.catalogId,
    "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
  );
  const card = await renderA2ui(view);
  assert.equal(card.schema, "2.0");
  const json = JSON.stringify(card);
  assert.ok(json.includes("https://github.com/example/app/pull/42"));
  assert.ok(json.includes("https://github.com/alice"));
  assert.ok(json.includes("作者：alice"));
  assert.ok(json.includes("创建：2026-11-19 10:03"));
  assert.ok(json.includes("更新：2026-11-20 08:05"));
  assert.ok(json.includes("草稿"));
  const title = card.body.elements.find((e) => e.tag === "button" && e.behaviors[0].default_url.endsWith("/42"));
  assert.equal(title.text.tag, "plain_text");
  assert.match(title.text.content, /#42/);
  assert.ok(
    card.body.elements.some(
      (e) => e.tag === "div" && e.text.tag === "plain_text" && e.text.content.includes("<at id=all>"),
    ),
  );
  const changed = structuredClone(view);
  changed.messages[0].createSurface.dataModel.items[0].title = "更新后的真实数据";
  assert.ok(JSON.stringify(await renderA2ui(changed)).includes("更新后的真实数据"));
});

test("pagination reports display limits and failed repositories instead of hiding PRs", async () => {
  const { pullRequestViews, renderA2ui } = await ui();
  const many = structuredClone(result);
  many.complete = false;
  many.repositories.push({
    repository: "example/backend",
    complete: false,
    pullRequests: [],
    error: "github_request_failed",
  });
  many.repositories[0].pullRequests = Array.from({ length: 81 }, (_, i) => ({
    ...result.repositories[0].pullRequests[0],
    number: i + 1,
    url: `https://github.com/example/app/pull/${i + 1}`,
  }));
  many.total = 81;
  const views = pullRequestViews(many);
  assert.equal(views.length, 10);
  const first = JSON.stringify(await renderA2ui(views[0]));
  assert.match(first, /example\/backend/);
  assert.match(first, /80.*81/);
  assert.match(first, /https:\/\/github.com\/example\/app\/pulls/);
});

test("empty PR results remain a real A2UI surface with query time and repository coverage", async () => {
  const { pullRequestViews, renderA2ui } = await ui();
  const empty = structuredClone(result);
  empty.total = 0;
  empty.repositories[0].pullRequests = [];
  const card = await renderA2ui(pullRequestViews(empty)[0]);
  assert.match(JSON.stringify(card), /没有未合并 PR/);
  assert.match(JSON.stringify(card), /09:00/);
});

test("GitHub bot authors navigate to their app profile", async () => {
  const { pullRequestViews, renderA2ui } = await ui();
  const bot = structuredClone(result);
  bot.repositories[0].pullRequests[0].author = "dependabot[bot]";
  assert.ok(JSON.stringify(await renderA2ui(pullRequestViews(bot)[0])).includes("https://github.com/apps/dependabot"));
});

test("official schema errors, unsupported components and unsafe navigation fail closed", async () => {
  const { pullRequestViews, renderA2ui } = await ui();
  const view = pullRequestViews(result)[0];
  const bad = structuredClone(view);
  bad.messages[0].createSurface.components.find((c) => c.component === "Text").text = 123;
  await assert.rejects(renderA2ui(bad));
  const form = structuredClone(view);
  form.messages[0].createSurface.components.find((c) => c.id === "root").component = "TextField";
  await assert.rejects(renderA2ui(form));
  const url = structuredClone(view);
  url.messages[0].createSurface.dataModel.items[0].url = "javascript:alert(1)";
  await assert.rejects(renderA2ui(url), /unsupported_url/);
});

test("private content-addressed references survive replay but reject traversal and edited files", async (t) => {
  const { pullRequestViews, saveView, loadView } = await ui();
  const dir = mkdtempSync(join(tmpdir(), "a2ui-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const view = pullRequestViews(result)[0];
  const text = saveView(dir, view);
  assert.match(text, /^a2ui:[a-f0-9]{64}$/);
  assert.equal(saveView(dir, view), text);
  assert.deepEqual(loadView(dir, text), view);
  assert.throws(() => loadView(dir, "a2ui:../../secrets"));
  const file = join(dir, "a2ui", `${text.slice(5)}.json`);
  writeFileSync(file, readFileSync(file, "utf8").replace("alice", "mallory"));
  assert.throws(() => loadView(dir, text), /artifact_hash_mismatch/);
});
