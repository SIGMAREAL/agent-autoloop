# Feishu feedback migration implementation plan

> Execution: carry out this already-authorized migration in the current session; review before integration.

**Goal:** Make this Fork the development source for the running Feishu -> Autoloop -> Codex -> GitHub Issue -> original-group card workflow.

**Architecture:** Keep the existing independently installed relay and AI packages together under `examples/recipes/feishu-feedback/`. They use the documented standard event HTTP API and built-in Codex adapter; no new plugin discovery path or core dependency is needed. Private configuration, SQLite state, credentials, authorized chat and Issue destination remain outside Git and unchanged. The new repository owns implementation; Petwins retains historical acceptance and links to the new source.

**Tech Stack:** Node >=24, official Lark SDK, MCP SDK, SQLite, official Codex and Feishu/GitHub CLIs, existing launchd services.

## 1. Fork and provenance

- Create SIGMAREAL/agent-autoloop from upstream, with `origin` pointing to the Fork and `upstream` to KKKKhazix/agent-autoloop.
- Use a `codex/` development branch in a separate Git worktree; preserve upstream main and LICENSE.
- Extract only tracked `tools/feedback-bot/` files from Petwins commit `65a5555a74c5b63fcc23de59a2e50b0e9897f12c`. No private runtime/configuration is imported.

## 2. Complete independent recipe

- Place both packages, their locks and 44 existing behavioral tests at `examples/recipes/feishu-feedback/`.
- Update relative documentation, development/install/test commands, package identity and root Chinese/English discovery links.
- Preserve the existing wire schema, environment/config keys, SQLite layout, delivery IDs and GitHub markers to avoid treating old feedback as new.
- Run the completion gate against this repository's real Codex adapter, not an optional locally installed checkout.
- Add CI for the standalone recipe on Linux/macOS; retain the upstream three-platform core checks. The current business installation remains a macOS workflow, not a Windows-service claim.

## 3. Verification and review

- Install locked dependencies, run relay and AI tests plus upstream quick tests, typecheck and formatting.
- Scan all imported tracked text for actual private values from the existing installation without printing them.
- Request an independent review of package isolation, completeness, replay/permission boundaries, CI and runtime migration.
- Push to the Fork, prepare the PR against this Fork only and verify required checks before integration.

## 4. Runtime handover

- Freeze committed recipe code in a versioned private release, install both committed locks and verify its tests.
- Back up the task's three service descriptors/wrappers and configuration metadata privately. Keep existing databases in place; record counts and decision/card identity hashes.
- Wait for the current Codex run/card send to finish. Stop the old receiver before starting its replacement; never open two SDK listeners on the live app.
- Point the two existing business login services and Codex wrapper at the new release. Keep the upstream v1.9.3 framework installation unchanged for this code relocation.
- Verify all services, source commit, health, durable counts and no replay/new Issue/card caused by handover. On failure, restore descriptors to the old frozen release and investigate.

## 5. Retire old development source

- Remove the transferred implementation/test/package files from the existing Petwins task branch only, after the new runtime is healthy.
- Keep README migration pointers at the old package entrypoints and append the move to existing OpenSpec evidence.
- Update Petwins #258 and this Fork's migration Issue, commit/push both repositories and leave the new checkout ready for future development.

## Verification note

The initial parallel run exposed a test-preparation timing failure: importing the cold official Lark SDK inside a two-second request test could use up its deadline under system load. The isolated reproduction passed. SDK/HTTP imports now occur during module setup, while the unchanged 30 ms request timeout, two-second test deadline and ECONNABORTED assertion still verify the same behavior. Runtime implementation is unchanged apart from formatting.

## Local handover result — 2026-11-19 20:11 +08:00

- Fork code is committed and pushed. The business services run frozen commit `6b65c29b9dc11026a271b871065ec3a164346009` from SIGMAREAL/agent-autoloop; the independent upstream framework remains v1.9.3 (`dd4187a495bbd81ff5bc1c1e70de08ee11ed1fc9`).
- All 11 production `.mjs` files match the original source after formatting. Both package locks retain the original dependency versions.
- PASS: 44 recipe tests from both the development checkout and the frozen installation, including this Fork's actual Codex adapter. PASS: upstream quick checks (802 passed, 21 platform/explicit-real-run skips), typecheck and formatting. Independent review found no blocking Critical/Important issue.
- Old receiver stopped before replacement started; new websocket connected at `2026-11-19T12:11:07.792Z`. All three login services run normally.
- Original 14 feedback records, four card message IDs/sent states, binary-resource hashes and relay receipts are unchanged. Private configuration and rules hashes are unchanged. No new message, Issue or card was generated for migration testing.
- Authenticated health after handover: 14 dispatched feedback items and four sent cards. Only public counts and verification results are recorded here; raw state snapshots, credentials, source IDs and service descriptors stay private.
- CI, final repository ownership and removal of the old implementation are tracked by [Fork #1](https://github.com/SIGMAREAL/agent-autoloop/issues/1), not inferred from local tests.
