import { DatabaseSync } from "node:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:http";

export const isId = (value) => /^[a-f0-9]{64}$/.test(value || "");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const MAX_RESOURCE = 5 * 1024 * 1024;
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
      CREATE TABLE IF NOT EXISTS issue_cards(feedback_id TEXT PRIMARY KEY,issue INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',payload TEXT,message_id TEXT);`);
  }
  get(id) {
    if (!isId(id)) throw new Error("invalid_feedback_id");
    const r = this.db.prepare("SELECT * FROM feedback WHERE id=?").get(id);
    if (!r) throw new Error("unknown_feedback");
    return {
      deliveryId: r.id,
      envelope: JSON.parse(r.envelope),
      state: r.state,
      hubEvent: r.hub_event,
      searched: Boolean(r.searched),
      decision: r.decision,
      reason: r.reason,
      issueNumber: r.issue,
      creationState: r.creation_state,
    };
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
  searched(id) {
    this.get(id);
    this.db.prepare("UPDATE feedback SET searched=1 WHERE id=?").run(id);
  }
  decide(id, decision, reason, issue = null) {
    const r = this.get(id);
    if (r.decision) {
      if (r.decision === decision && r.issueNumber === issue) return r;
      throw new Error("feedback_already_decided");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE feedback SET decision=?,reason=?,issue=?,creation_state=CASE WHEN ?='created' THEN 'created' ELSE creation_state END WHERE id=? AND decision IS NULL",
        )
        .run(decision, reason, issue, decision, id).changes;
      if (!changed) throw new Error("feedback_already_decided");
      if (decision === "created") this.queueCard(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }
  queueCard(id) {
    const r = this.get(id);
    if (r.decision !== "created" || !Number.isSafeInteger(r.issueNumber) || r.issueNumber < 1)
      throw new Error("created_issue_required");
    this.db.prepare("INSERT OR IGNORE INTO issue_cards(feedback_id,issue) VALUES (?,?)").run(id, r.issueNumber);
  }
  nextCard() {
    return this.db.prepare("SELECT * FROM issue_cards WHERE state='pending' ORDER BY rowid LIMIT 1").get();
  }
  prepareCard(id, payload) {
    this.db
      .prepare("UPDATE issue_cards SET payload=? WHERE feedback_id=? AND state='pending' AND payload IS NULL")
      .run(payload, id);
  }
  claimCard(id) {
    return (
      this.db.prepare("UPDATE issue_cards SET state='sending' WHERE feedback_id=? AND state='pending'").run(id)
        .changes > 0
    );
  }
  finishCard(id, state, messageId = null) {
    this.db
      .prepare("UPDATE issue_cards SET state=?,message_id=? WHERE feedback_id=? AND state='sending'")
      .run(state, messageId, id);
  }
  recoverCards() {
    this.db.prepare("UPDATE issue_cards SET state='uncertain' WHERE state='sending'").run();
  }
  retryRejectedCards() {
    return this.db.prepare("UPDATE issue_cards SET state='pending' WHERE state='rejected'").run().changes;
  }
  cardCounts() {
    return Object.fromEntries(
      this.db
        .prepare("SELECT state,COUNT(*) AS count FROM issue_cards GROUP BY state")
        .all()
        .map((r) => [r.state, r.count]),
    );
  }
  claimCreate(id) {
    return (
      this.db
        .prepare(
          "UPDATE feedback SET creation_state='creating' WHERE id=? AND creation_state IS NULL AND decision IS NULL",
        )
        .run(id).changes > 0
    );
  }
  uncertain(id) {
    this.db.prepare("UPDATE feedback SET creation_state='uncertain' WHERE id=? AND decision IS NULL").run(id);
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
