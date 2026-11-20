# Unified GitHub A2UI Cards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Issue creation receipts, new PR notices and PR queries use the same official A2UI presentation and Feishu adapter; single PR notices and query lists reuse one PR item definition.

**Architecture:** Keep the existing three triggers, trusted destinations and durable delivery mechanisms. The existing plugin-local `@agent-autoloop/feishu-a2ui` package owns GitHub item data, A2UI component composition, official Core rendering and avatar handling. Consumers install this local package into their own node_modules with `--install-links`, so a copied plugin remains self-contained. No engine/protocol changes, new AI tools, event listeners or queues.

**Tech Stack:** Node 24+, official `@a2ui/web_core` 0.15.0 / A2UI 1.0, Feishu JSON 2.0, existing official lark-cli, Node test runner.

---

### Task 1: Shared presentation (test first)

- Add behavior tests to `plugins/feishu-replies/test/ui.test.mjs`: a standalone PR renders identically to its entry in a query; an Issue uses the same metadata/link/avatar/date layout; Issue URLs are safely supported.
- Extract shared GitHub item data/components into `plugins/feishu-replies/github-view.mjs`. `pr-view.mjs` only selects/pages items and adds query coverage. Export standalone PR and Issue views plus the existing adapter through the plugin package.
- Preserve full titles, canonical links, Shanghai times, bot avatar routes, plain-text handling, empty/partial queries and bounded pagination.

### Task 2: Existing consumers (test first)

- Extend `tests/github-pr-notify.test.ts` to verify the production notice renderer outputs the same PR body as the query renderer. Preserve source/allowlist validation, cursor, native FYI and idempotency tests, including copied-plugin tests.
- Extend `examples/recipes/feishu-feedback/ai/test/notifications.test.mjs` to verify the production Issue outbox renders A2UI and retains author/avatar/time data while freezing the payload and preserving sent/uncertain/rejected behavior.
- Install the shared local package into both consumers; add its exports/types. New PR payloads retain avatar, update time and actual closed/merged state; old queued payloads still work with missing optional fields.
- Replace the two manual Feishu JSON templates with the shared view + official renderer. Pass bot-bound avatar resolution from the current channel/AI service; do not change destination or send keys.

### Task 3: Packaging, docs and verification

- Update `feedback:install` and CI dependency preparation before typecheck/tests on all platforms, including full nightly. Keep root runtime dependencies empty.
- Document the one presentation source, local-package installation, production queue boundaries and supported Issue navigation. Search for obsolete split-template claims.
- Run focused UI/consumer and copied-plugin tests, feedback tests, quick tests, typecheck, format and diff checks. Commit and open one PR; request independent review immediately and verify the final head's three OS checks.

### Task 4: Real deployment and completion

- Freeze the reviewed source and consumer dependencies into a private release. Back up operator files; switch the two installed plugins and Codex wrapper. Reload the owned hub only while idle; update/restart the AI receipt service while idle. Leave the sole Feishu SDK listener running and preserve all state.
- Verify the real new PR notification, reuse the original human PR query, and verify the Issue presentation using real existing Issue data without creating a synthetic public Issue or resetting an outbox. Record which delivery paths were exercised.
- Read back original-group cards and inspect native Feishu screenshots after the last visual change. Record runtime/source correspondence and delivery receipts privately.
- Merge after review/final-head CI, run main check and full nightly for the exact merged commit, clean the owned temporary branch, retain the established development worktree. No release/tag.
