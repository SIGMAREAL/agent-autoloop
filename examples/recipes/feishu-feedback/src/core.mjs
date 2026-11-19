import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function text(message, content) {
  if (message.message_type === "text") return String(content.text || "");
  if (message.message_type !== "post") return "";
  const parts = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.title === "string") parts.push(node.title);
    if (typeof node.text === "string") parts.push(node.text);
    for (const v of Object.values(node)) if (typeof v === "object") walk(v);
  }
  walk(content);
  return parts.join("\n");
}
export class Store {
  static inspect(path) {
    if (!existsSync(path)) return { queue: [], uncertain: [] };
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        queue: db.prepare("SELECT status,COUNT(*) AS count FROM relay_queue GROUP BY status").all(),
        uncertain: db
          .prepare("SELECT id FROM relay_queue WHERE status='uncertain' ORDER BY rowid")
          .all()
          .map((row) => row.id),
      };
    } finally {
      db.close();
    }
  }
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS relay_queue(id TEXT PRIMARY KEY,payload TEXT,envelope TEXT,status TEXT NOT NULL DEFAULT 'pending');
      UPDATE relay_queue SET status='uncertain' WHERE status='sending';`);
  }
  receive(m) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO relay_queue(id,payload) VALUES (?,?)")
        .run(hash(`${m.chat_id}\0${m.message_id}`), JSON.stringify(m)).changes > 0
    );
  }
  uncached() {
    return this.db.prepare("SELECT * FROM relay_queue WHERE status='pending' ORDER BY rowid LIMIT 1").get();
  }
  next() {
    return this.db
      .prepare("SELECT * FROM relay_queue WHERE status IN ('ready','sending','uncertain') ORDER BY rowid LIMIT 1")
      .get();
  }
  cache(id, envelope) {
    this.db
      .prepare("UPDATE relay_queue SET envelope=?,payload=NULL,status='ready' WHERE id=?")
      .run(JSON.stringify(envelope), id);
  }
  status(id, status) {
    this.db.prepare("UPDATE relay_queue SET status=? WHERE id=?").run(status, id);
  }
  complete(id) {
    this.db.prepare("UPDATE relay_queue SET status='done',payload=NULL,envelope=NULL WHERE id=?").run(id);
  }
  confirmDelivered(id) {
    return (
      this.db
        .prepare("UPDATE relay_queue SET status='done',payload=NULL,envelope=NULL WHERE id=? AND status='uncertain'")
        .run(id).changes > 0
    );
  }
  retryUncertain(id) {
    return (
      this.db.prepare("UPDATE relay_queue SET status='ready' WHERE id=? AND status='uncertain'").run(id).changes > 0
    );
  }
  summary() {
    return this.db.prepare("SELECT status,COUNT(*) AS count FROM relay_queue GROUP BY status").all();
  }
  close() {
    this.db.close();
  }
}
export class Relay {
  constructor({ store, allowedChats, io }) {
    if (!allowedChats.length) throw new Error("chat_allowlist_required");
    Object.assign(this, { store, allowedChats: new Set(allowedChats), io });
    this.allowedConversations = new Set(allowedChats.map(hash));
    this.running = false;
  }
  receive(event) {
    const m = event?.message;
    if (
      !m ||
      m.chat_type !== "group" ||
      !this.allowedChats.has(m.chat_id) ||
      event.sender?.sender_type !== "user" ||
      typeof m.message_id !== "string" ||
      typeof m.content !== "string" ||
      m.content.length > 100_000
    )
      return false;
    return this.store.receive(m);
  }
  async tick() {
    if (this.running) return { status: "busy" };
    this.running = true;
    try {
      let row = this.io.forward ? this.store.next() : null;
      const pending = row ? null : this.store.uncached();
      if (pending) {
        const m = JSON.parse(pending.payload);
        if (!this.allowedChats.has(m.chat_id)) {
          this.store.status(pending.id, "withheld");
          return { status: "withheld" };
        }
        let content;
        try {
          content = JSON.parse(m.content);
        } catch {
          content = { unparsed: m.content };
        }
        let attachments = [];
        if (m.message_type !== "text")
          try {
            attachments = await this.io.download(m);
          } catch (error) {
            if (error.name === "AbortError") throw error;
            attachments = [
              {
                status: "unavailable",
                reason: "permission_or_download_failed",
              },
            ];
          }
        this.store.cache(pending.id, {
          schema: "petwins.feishu.message.v1",
          deliveryId: pending.id,
          source: {
            messageId: m.message_id,
            conversationId: hash(m.chat_id),
            rootId: m.root_id || null,
            threadId: m.thread_id || null,
            createdAt: m.create_time || null,
          },
          message: { type: m.message_type, text: text(m, content), content },
          attachments,
        });
      }
      row ??= this.store.next();
      if (!row) return { status: "idle" };
      const envelope = JSON.parse(row.envelope);
      if (!this.allowedConversations.has(envelope.source.conversationId)) {
        this.store.status(row.id, "withheld");
        return { status: "withheld" };
      }
      if (!this.io.forward) return { status: "waiting_target" };
      if (row.status !== "ready") return { status: "needs_reconciliation" };
      this.store.status(row.id, "sending");
      try {
        const receipt = await this.io.forward(envelope);
        if (receipt?.accepted !== true || receipt.deliveryId !== envelope.deliveryId)
          throw new Error("invalid_receipt");
        this.store.complete(row.id);
        return { status: "forwarded" };
      } catch {
        this.store.status(row.id, "uncertain");
        return { status: "needs_reconciliation" };
      }
    } finally {
      this.running = false;
    }
  }
}
