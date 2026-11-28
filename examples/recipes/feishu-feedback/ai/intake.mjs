import { DatabaseSync } from "node:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:http";
import { MAX_MEDIA_BYTES } from "../limits.mjs";

export const isId = (value) => /^[a-f0-9]{64}$/.test(value || "");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const MAX_RESOURCE = MAX_MEDIA_BYTES;
const MAX_BODY = 72 * 1024 * 1024;

export class Inbox {
  constructor(dir, allowedConversations) {
    if (!isAbsolute(dir) || !allowedConversations.length || !allowedConversations.every(isId))
      throw new Error("invalid_ai_config");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dir = dir;
    this.allowed = new Set(allowedConversations);
    this.db = new DatabaseSync(join(dir, "feedback.sqlite"));
    chmodSync(join(dir, "feedback.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS feedback(
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, envelope TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', hub_event INTEGER,
        searched INTEGER NOT NULL DEFAULT 0, decision TEXT, reason TEXT,
        issue INTEGER, creation_state TEXT);
      CREATE TABLE IF NOT EXISTS resources(feedback_id TEXT NOT NULL, position INTEGER NOT NULL,
        bytes BLOB NOT NULL, PRIMARY KEY(feedback_id,position));
      CREATE TABLE IF NOT EXISTS recovered_resources(feedback_id TEXT NOT NULL,position INTEGER NOT NULL,
        metadata TEXT NOT NULL,PRIMARY KEY(feedback_id,position));
      CREATE TABLE IF NOT EXISTS media_recovery_decisions(feedback_id TEXT NOT NULL,decision TEXT NOT NULL,
        reason TEXT NOT NULL,recovered_from TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issue_cards(feedback_id TEXT PRIMARY KEY,issue INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',payload TEXT,message_id TEXT);
      CREATE TABLE IF NOT EXISTS feedback_plans(feedback_id TEXT PRIMARY KEY,plan TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback_actions(feedback_id TEXT NOT NULL,action_key TEXT NOT NULL,
        description TEXT NOT NULL,searched INTEGER NOT NULL DEFAULT 0,decision TEXT,reason TEXT,
        issue INTEGER,creation_state TEXT,PRIMARY KEY(feedback_id,action_key));
      CREATE TABLE IF NOT EXISTS action_issue_cards(feedback_id TEXT NOT NULL,action_key TEXT NOT NULL,
        issue INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',payload TEXT,message_id TEXT,
        PRIMARY KEY(feedback_id,action_key));`);
  }
  get(id) {
    if (!isId(id)) throw new Error("invalid_feedback_id");
    const r = this.db.prepare("SELECT * FROM feedback WHERE id=?").get(id);
    if (!r) throw new Error("unknown_feedback");
    const actionPlan = this.db
      .prepare("SELECT * FROM feedback_actions WHERE feedback_id=? ORDER BY rowid")
      .all(id)
      .map((a) => ({
        actionKey: a.action_key,
        description: a.description,
        searched: Boolean(a.searched),
        decision: a.decision,
        reason: a.reason,
        issueNumber: a.issue,
        creationState: a.creation_state,
      }));
    const envelope = JSON.parse(r.envelope);
    for (const recovery of this.db
      .prepare("SELECT position,metadata FROM recovered_resources WHERE feedback_id=?")
      .all(id))
      envelope.attachments[recovery.position] = JSON.parse(recovery.metadata);
    return {
      deliveryId: r.id,
      envelope,
      state: r.state,
      hubEvent: r.hub_event,
      searched: Boolean(r.searched),
      decision: r.decision,
      reason: r.reason,
      issueNumber: r.issue,
      creationState: r.creation_state,
      actionPlan,
      issueNumbers: actionPlan.length
        ? [...new Set(actionPlan.map((a) => a.issueNumber).filter((n) => n !== null))]
        : r.issue
          ? [r.issue]
          : [],
    };
  }
  scope(id, actionKey = null) {
    const parent = this.get(id);
    if (actionKey === null) {
      if (parent.actionPlan.length) throw new Error("action_key_required");
      return { row: parent, table: "feedback", where: "id=?", params: [id] };
    }
    if (typeof actionKey !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(actionKey))
      throw new Error("invalid_action_key");
    const row = parent.actionPlan.find((a) => a.actionKey === actionKey);
    if (!row) throw new Error("unknown_action");
    return {
      row: { deliveryId: id, ...row },
      table: "feedback_actions",
      where: "feedback_id=? AND action_key=?",
      params: [id, actionKey],
    };
  }
  planActions(id, actions) {
    if (
      !Array.isArray(actions) ||
      !actions.length ||
      actions.length > 50 ||
      actions.some(
        (a) =>
          !a ||
          typeof a.key !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.key) ||
          typeof a.description !== "string" ||
          !a.description.trim() ||
          a.description.length > 2000,
      ) ||
      new Set(actions.map((a) => a.key)).size !== actions.length
    )
      throw new Error("invalid_action_plan");
    const plan = JSON.stringify(actions.map(({ key, description }) => ({ key, description })));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.get(id),
        old = this.db.prepare("SELECT plan FROM feedback_plans WHERE feedback_id=?").get(id);
      if (old) {
        if (old.plan !== plan) throw new Error("action_plan_conflict");
      } else {
        if (row.decision || row.creationState) throw new Error("feedback_already_decided");
        this.db.prepare("INSERT INTO feedback_plans(feedback_id,plan) VALUES (?,?)").run(id, plan);
        for (const a of actions)
          this.db
            .prepare("INSERT INTO feedback_actions(feedback_id,action_key,description) VALUES (?,?,?)")
            .run(id, a.key, a.description);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }
  finishPlan(id) {
    const actions = this.get(id).actionPlan;
    if (!actions.length || actions.some((a) => !a.decision)) return;
    const decision = ["created", "duplicate", "needs_info", "ignored"].find((d) =>
      actions.some((a) => a.decision === d),
    );
    const issue =
      actions.find((a) => a.decision === "created")?.issueNumber ??
      actions.find((a) => a.issueNumber)?.issueNumber ??
      null;
    this.db
      .prepare("UPDATE feedback SET decision=?,reason=?,issue=?,creation_state=? WHERE id=? AND decision IS NULL")
      .run(
        decision,
        `AI 已完成 ${actions.length} 个任务的逐项判断`,
        issue,
        decision === "created" ? "created" : null,
        id,
      );
  }
  accept(e) {
    if (
      e?.schema !== "petwins.feishu.message.v1" ||
      !isId(e.deliveryId) ||
      typeof e.message?.type !== "string" ||
      typeof e.message?.text !== "string" ||
      e.message.text.length > 100_000 ||
      JSON.stringify(e.message.content ?? {}).length > 200_000 ||
      !Array.isArray(e.attachments) ||
      e.attachments.length > 10
    )
      throw new Error("invalid_envelope");
    if (!this.allowed.has(e.source?.conversationId)) throw new Error("unauthorized_conversation");
    const hash = digest(JSON.stringify(e));
    const old = this.db.prepare("SELECT digest FROM feedback WHERE id=?").get(e.deliveryId);
    if (old) {
      if (old.digest !== hash) throw new Error("delivery_conflict");
      return { accepted: true, deliveryId: e.deliveryId };
    }
    const resources = e.attachments.map((a) => {
      if (a.status === "unavailable")
        return {
          status: "unavailable",
          reason: String(a.reason || "unavailable").slice(0, 200),
        };
      if (
        a.status !== "available" ||
        typeof a.base64 !== "string" ||
        a.base64.length > Math.ceil(MAX_RESOURCE / 3) * 4 ||
        a.base64.length % 4 !== 0
      )
        throw new Error("invalid_attachment");
      const bytes = Buffer.from(a.base64, "base64");
      if (bytes.length > MAX_RESOURCE || bytes.toString("base64") !== a.base64) throw new Error("invalid_attachment");
      return {
        status: "available",
        name: String(a.name || "attachment").slice(0, 255),
        mimeType: String(a.mimeType || "application/octet-stream").slice(0, 100),
        bytes,
      };
    });
    if (resources.reduce((sum, a) => sum + (a.bytes?.length || 0), 0) > MAX_MEDIA_BYTES)
      throw new Error("invalid_attachment");
    const folder = join(this.dir, "resources", e.deliveryId);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const attachments = resources.map((a, index) => {
      if (!a.bytes) return a;
      const { bytes, ...metadata } = a,
        path = join(folder, String(index));
      writeFileSync(path, bytes, { mode: 0o600 });
      return { ...metadata, path, size: bytes.length, sha256: digest(bytes) };
    });
    const envelope = {
      schema: e.schema,
      deliveryId: e.deliveryId,
      source: {
        messageId: String(e.source.messageId || "").slice(0, 500),
        conversationId: e.source.conversationId,
        rootId: String(e.source.rootId || "").slice(0, 500),
        threadId: String(e.source.threadId || "").slice(0, 500),
        createdAt: String(e.source.createdAt || "").slice(0, 100),
      },
      message: e.message,
      attachments,
    };
    // The receipt covers both metadata and bytes. Materialized files are only a recoverable cache.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO feedback(id,digest,envelope) VALUES (?,?,?)")
        .run(e.deliveryId, hash, JSON.stringify(envelope));
      resources.forEach((a, index) => {
        if (a.bytes)
          this.db
            .prepare("INSERT INTO resources(feedback_id,position,bytes) VALUES (?,?,?)")
            .run(e.deliveryId, index, a.bytes);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { accepted: true, deliveryId: e.deliveryId };
  }
  readAttachment(id, index) {
    const a = this.get(id).envelope.attachments[index];
    const r = this.db.prepare("SELECT bytes FROM resources WHERE feedback_id=? AND position=?").get(id, index);
    if (a?.status !== "available" || !r) throw new Error("attachment_unavailable");
    const bytes = Buffer.from(r.bytes);
    if (digest(bytes) !== a.sha256) throw new Error("attachment_corrupt");
    if (!existsSync(a.path) || digest(readFileSync(a.path)) !== a.sha256) {
      mkdirSync(join(this.dir, "resources", id), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(a.path, bytes, { mode: 0o600 });
    }
    return bytes;
  }
  // Operator-only recovery: retain the original intake digest, envelope and decisions.
  // This method is deliberately absent from the model's MCP tool set.
  recoverAttachment(id, index, { bytes, mimeType }) {
    const row = this.get(id),
      previous = row.envelope.attachments[index];
    if (!Number.isSafeInteger(index) || index < 0 || !previous) throw new Error("invalid_attachment_index");
    if (previous.status !== "unavailable") throw new Error("attachment_already_available");
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MEDIA_BYTES || typeof mimeType !== "string")
      throw new Error("invalid_attachment");
    const total = row.envelope.attachments.reduce((n, a) => n + (a.status === "available" ? a.size : 0), 0);
    if (total + bytes.length > MAX_MEDIA_BYTES) throw new Error("invalid_attachment");
    const metadata = {
      status: "available",
      name: "recovered-recording",
      mimeType,
      path: join(this.dir, "resources", id, String(index)),
      size: bytes.length,
      sha256: digest(bytes),
      recovered: true,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO resources(feedback_id,position,bytes) VALUES (?,?,?)").run(id, index, bytes);
      this.db
        .prepare("INSERT INTO recovered_resources(feedback_id,position,metadata) VALUES (?,?,?)")
        .run(id, index, JSON.stringify(metadata));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id).envelope.attachments[index];
  }
  reconsiderRecoveredMedia(id, recoveredFrom) {
    const row = this.get(id),
      source = this.get(recoveredFrom);
    if (
      row.decision !== "needs_info" ||
      row.creationState ||
      row.actionPlan.length ||
      row.envelope.source.conversationId !== source.envelope.source.conversationId ||
      !source.envelope.attachments.some((a) => a.recovered)
    )
      throw new Error("media_reconsideration_not_allowed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO media_recovery_decisions(feedback_id,decision,reason,recovered_from,at) VALUES (?,?,?,?,?)",
        )
        .run(id, row.decision, row.reason, recoveredFrom, new Date().toISOString());
      this.db
        .prepare(
          "UPDATE feedback SET decision=NULL,reason=NULL,searched=0 WHERE id=? AND decision='needs_info' AND creation_state IS NULL",
        )
        .run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }
  pending() {
    const r = this.db.prepare("SELECT id FROM feedback WHERE state='pending' ORDER BY rowid LIMIT 1").get();
    return r ? this.get(r.id) : null;
  }
  dispatched(id, event) {
    this.db.prepare("UPDATE feedback SET state='dispatched',hub_event=? WHERE id=?").run(event, id);
  }
  holdRouting(id, event) {
    this.db.prepare("UPDATE feedback SET state='routing_held',hub_event=? WHERE id=?").run(event, id);
  }
  heldRouting() {
    return this.db.prepare("SELECT id,hub_event FROM feedback WHERE state='routing_held'").all();
  }
  searched(id, actionKey = null) {
    const s = this.scope(id, actionKey);
    this.db.prepare(`UPDATE ${s.table} SET searched=1 WHERE ${s.where}`).run(...s.params);
  }
  decide(id, decision, reason, issue = null, actionKey = null) {
    const s = this.scope(id, actionKey),
      r = s.row;
    if (r.decision) {
      if (r.decision === decision && r.issueNumber === issue) return r;
      throw new Error("feedback_already_decided");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE ${s.table} SET decision=?,reason=?,issue=?,creation_state=CASE WHEN ?='created' THEN 'created' ELSE creation_state END WHERE ${s.where} AND decision IS NULL`,
        )
        .run(decision, reason, issue, decision, ...s.params).changes;
      if (!changed) throw new Error("feedback_already_decided");
      if (decision === "created") this.queueCard(id, actionKey);
      if (actionKey !== null) this.finishPlan(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.scope(id, actionKey).row;
  }
  queueCard(id, actionKey = null) {
    const r = this.scope(id, actionKey).row;
    if (r.decision !== "created" || !Number.isSafeInteger(r.issueNumber) || r.issueNumber < 1)
      throw new Error("created_issue_required");
    if (actionKey === null)
      this.db.prepare("INSERT OR IGNORE INTO issue_cards(feedback_id,issue) VALUES (?,?)").run(id, r.issueNumber);
    else
      this.db
        .prepare("INSERT OR IGNORE INTO action_issue_cards(feedback_id,action_key,issue) VALUES (?,?,?)")
        .run(id, actionKey, r.issueNumber);
  }
  nextCard() {
    return this.db
      .prepare(
        `SELECT feedback_id,issue,state,payload,message_id,NULL AS action_key,0 AS lane,rowid AS position
      FROM issue_cards WHERE state='pending' UNION ALL
      SELECT feedback_id,issue,state,payload,message_id,action_key,1 AS lane,rowid AS position
      FROM action_issue_cards WHERE state='pending' ORDER BY lane,position LIMIT 1`,
      )
      .get();
  }
  cardScope(id, actionKey = null) {
    this.scope(id, actionKey);
    return actionKey === null
      ? { table: "issue_cards", where: "feedback_id=?", params: [id] }
      : { table: "action_issue_cards", where: "feedback_id=? AND action_key=?", params: [id, actionKey] };
  }
  prepareCard(id, payload, actionKey = null) {
    const s = this.cardScope(id, actionKey);
    this.db
      .prepare(`UPDATE ${s.table} SET payload=? WHERE ${s.where} AND state='pending' AND payload IS NULL`)
      .run(payload, ...s.params);
  }
  claimCard(id, actionKey = null) {
    const s = this.cardScope(id, actionKey);
    return (
      this.db.prepare(`UPDATE ${s.table} SET state='sending' WHERE ${s.where} AND state='pending'`).run(...s.params)
        .changes > 0
    );
  }
  finishCard(id, state, messageId = null, actionKey = null) {
    const s = this.cardScope(id, actionKey);
    this.db
      .prepare(`UPDATE ${s.table} SET state=?,message_id=? WHERE ${s.where} AND state='sending'`)
      .run(state, messageId, ...s.params);
  }
  recoverCards() {
    this.db.prepare("UPDATE issue_cards SET state='uncertain' WHERE state='sending'").run();
    this.db.prepare("UPDATE action_issue_cards SET state='uncertain' WHERE state='sending'").run();
  }
  retryRejectedCards() {
    return (
      this.db.prepare("UPDATE issue_cards SET state='pending' WHERE state='rejected'").run().changes +
      this.db.prepare("UPDATE action_issue_cards SET state='pending' WHERE state='rejected'").run().changes
    );
  }
  cardCounts() {
    return Object.fromEntries(
      this.db
        .prepare(
          "SELECT state,COUNT(*) AS count FROM (SELECT state FROM issue_cards UNION ALL SELECT state FROM action_issue_cards) GROUP BY state",
        )
        .all()
        .map((r) => [r.state, r.count]),
    );
  }
  claimCreate(id, actionKey = null) {
    const s = this.scope(id, actionKey);
    return (
      this.db
        .prepare(
          `UPDATE ${s.table} SET creation_state='creating' WHERE ${s.where} AND creation_state IS NULL AND decision IS NULL`,
        )
        .run(...s.params).changes > 0
    );
  }
  uncertain(id, actionKey = null) {
    const s = this.scope(id, actionKey);
    this.db
      .prepare(`UPDATE ${s.table} SET creation_state='uncertain' WHERE ${s.where} AND decision IS NULL`)
      .run(...s.params);
  }
  counts() {
    return Object.fromEntries(
      this.db
        .prepare("SELECT state,COUNT(*) AS count FROM feedback GROUP BY state")
        .all()
        .map((r) => [r.state, r.count]),
    );
  }
  close() {
    this.db.close();
  }
}

export async function dispatchOne(inbox, config, fetchImpl = fetch) {
  const row = inbox.pending();
  if (!row) return false;
  const response = await fetchImpl(new URL("/v1/events", config.hubUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.sourceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: row.deliveryId,
      type: "feishu.feedback",
      subject: row.envelope.source.conversationId,
      summary: "飞书群反馈，等待 AI 判断",
      detail: JSON.stringify({ deliveryId: row.deliveryId }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("autoloop_dispatch_failed");
  const receipt = await response.json();
  if (!Number.isInteger(receipt.event) || receipt.event < 1) throw new Error("autoloop_invalid_receipt");
  if (!receipt.routed?.includes(config.rule)) {
    inbox.holdRouting(row.deliveryId, receipt.event);
    return { status: "routing_held" };
  }
  inbox.dispatched(row.deliveryId, receipt.event);
  return { status: "autoloop_dispatched" };
}

export async function reconcileRouting(inbox, config, fetchImpl = fetch) {
  let resumed = 0;
  for (const row of inbox.heldRouting()) {
    const response = await fetchImpl(new URL(`/v1/events/${row.hub_event}`, config.hubUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${config.sourceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("routing_reconciliation_failed");
    const current = await response.json();
    if (current.event === row.hub_event && current.runs?.some((run) => run.rule === config.rule)) {
      inbox.dispatched(row.id, row.hub_event);
      resumed++;
    }
  }
  return { resumed, held: inbox.heldRouting().length };
}

export function createIngress({ inbox, token, maxBody = MAX_BODY }) {
  if (!token) throw new Error("ingress_token_required");
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const auth = Buffer.from(req.headers.authorization || "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
      return reply(401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/health")
      return reply(200, {
        ok: true,
        queue: inbox.counts(),
        cards: inbox.cardCounts(),
      });
    if (req.method !== "POST" || req.url !== "/feishu") return reply(404, { error: "not_found" });
    if (Number(req.headers["content-length"] || 0) > maxBody) return reply(413, { error: "request_too_large" });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) {
          reply(413, { error: "request_too_large" });
          return;
        }
        chunks.push(chunk);
      }
      const e = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.headers["idempotency-key"] !== e.deliveryId) throw new Error("idempotency_key_mismatch");
      reply(200, inbox.accept(e));
    } catch (error) {
      const known = /^(invalid_|unauthorized_|delivery_conflict|idempotency_)/.test(error.message);
      reply(known || error instanceof SyntaxError ? 400 : 500, {
        error: known ? error.message : "intake_failed",
      });
    }
  });
}
