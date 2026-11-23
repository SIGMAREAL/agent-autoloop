# Ithaca Issue Results Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Send one existing-bot A2UI result card per completed Ithaca Issue, updating its result without process notifications.

**Architecture:** A send-only plugin reads a compact read-only SQLite snapshot from the configured execution host. It selects confirmed close/enrich/PR outcomes or human blockers, stores delivery receipts, and reuses the official A2UI GitHub item layout. Its separate process leaves the active Ithaca trial, bot listener and hub unchanged.

**Tech Stack:** Node 24+, SQLite, existing SSH, official lark-cli bot profile, pinned @agent-autoloop/feishu-a2ui.

## Task 1: Result boundary and delivery

Files: plugins/ithaca-results/{core,source,main}.mjs and package manifests; tests/ithaca-results.test.ts.

1. Write failing behavior tests for intermediate-state silence, confirmed result selection, initial backfill, duplicate suppression, existing-message updates and failed delivery retry.
2. Run the tests and confirm the missing module/behavior failure.
3. Implement a read-only source, fixed destination, durable native-idempotency receipt and bounded serial watcher. No new keys, listeners, agents or business scheduling.
4. Re-run the behavior tests against temporary databases and fake commands only.

## Task 2: Shared A2UI result view

Files: plugins/feishu-replies/{github-view,ui}.mjs, ui.d.mts, test/ui.test.mjs.

1. Add a failing test that result metadata and PR/Issue navigation use the existing GitHub item layout.
2. Add a result view and optional item detail using the official MessageProcessor and existing adapter.
3. Preserve other Issue/PR views and verify text stays plain and destinations stay constrained.

## Task 3: Verification and deployment

Files: plugin README, root installation/test commands as needed.

1. Run plugin/UI tests, typecheck, formatting and serial root quick regression. Request independent review and bind the final SHA.
2. Open a PR. Do not merge without final multi-platform CI or explicit owner instruction; report platform CI blocks accurately.
3. Deploy a frozen reviewed release with a private config derived from the existing bot profile/group. Read back actual sent cards and verify an update on one real result card.
4. Add a trusted command Agent and cron rule to the existing hub, verify hot reload and deduplication, and preserve the current Ithaca run/deadline and existing services.
