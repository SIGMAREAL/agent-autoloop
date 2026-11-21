import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const MAX_OUTPUT = 2 * 1024 * 1024,
  MAX_SNAPSHOT = 6 * 1024 * 1024;

export function documentLink(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) throw Error();
    const u = new URL(value),
      match = u.pathname.match(/^\/(docx|wiki|minutes)\/([A-Za-z0-9]{10,128})\/?$/);
    if (
      u.protocol !== "https:" ||
      u.port ||
      u.username ||
      u.password ||
      !/^(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)$/.test(u.hostname) ||
      !match
    )
      throw Error();
    if (match[1] === "minutes" && !/^[a-z0-9]+$/.test(match[2])) throw Error();
    const anchor = /^#share-[A-Za-z0-9_-]{1,200}$/.test(u.hash) ? u.hash : "";
    return {
      kind: match[1],
      token: match[2],
      url: u.origin + "/" + match[1] + "/" + match[2] + anchor,
      selection: Boolean(anchor),
    };
  } catch {
    throw new Error("invalid_document_link");
  }
}

function sharedLinks(message) {
  const links = new Set();
  const read = (value) => {
    if (typeof value === "string")
      for (const raw of value.match(/https:\/\/[^\s<>"'`]+/g) || []) {
        try {
          links.add(documentLink(raw.replace(/[)\]，。；！？、]+$/u, "")).url);
        } catch {}
      }
    else if (Array.isArray(value)) value.forEach(read);
    else if (value && typeof value === "object") Object.values(value).forEach(read);
  };
  read(message);
  return links;
}

function run(command, args, signal, cwd) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("document_read_cancelled"));
    const child = spawn(command[0], [...command.slice(1), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      cwd,
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure,
      timer,
      treeStop;
    const kill = (signal) => {
      if (!child.pid) return;
      // The official npm entry waits on a native child with inherited pipes.
      if (process.platform === "win32") {
        treeStop ??= new Promise((done) => {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
            .once("error", done)
            .once("close", done);
        });
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch (e) {
          if (e.code !== "ESRCH") throw e;
        }
      }
    };
    const stop = (message) => {
      if (failure) return;
      failure = message;
      kill("SIGTERM");
      timer = setTimeout(() => kill("SIGKILL"), 1000);
      timer.unref();
    };
    const abort = () =>
      stop(signal.reason?.name === "TimeoutError" ? "document_read_timeout" : "document_read_cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    for (const [stream, name] of [
      [child.stdout, "out"],
      [child.stderr, "err"],
    ]) {
      stream.setEncoding("utf8");
      stream.on("data", (part) => {
        bytes += Buffer.byteLength(part);
        if (bytes > MAX_OUTPUT) return stop("document_output_too_large");
        if (name === "out") stdout += part;
        else stderr += part;
      });
    }
    child.once("error", () => {
      failure ||= "document_cli_unavailable";
    });
    child.once("close", async () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await treeStop;
      if (failure) return reject(new Error(failure));
      for (const value of [stdout, stderr]) {
        const start = value.indexOf("{");
        if (start < 0) continue;
        try {
          return resolve(JSON.parse(value.slice(start)));
        } catch {}
      }
      reject(new Error("document_cli_invalid_response"));
    });
  });
}

export class Documents {
  constructor(inbox, config) {
    const c = config.documents;
    const command = c?.command ?? [c?.program];
    if (
      !c?.enabled ||
      !isAbsolute(config.stateDir) ||
      !/^[\w-]+$/.test(c.profile || "") ||
      !["bot", "user"].includes(c.identity) ||
      !Array.isArray(command) ||
      !command.length ||
      command.some((p) => typeof p !== "string" || !p)
    )
      throw new Error("invalid_document_config");
    this.inbox = inbox;
    this.command = command;
    this.profile = c.profile;
    this.identity = c.identity;
    this.directory = join(config.stateDir, "document-snapshots");
  }
  directoryReady() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.directory);
    if (!st.isDirectory() || (process.platform !== "win32" && st.mode & 0o077))
      throw new Error("private_document_directory_required");
  }
  load(file, deliveryId, url) {
    let st;
    try {
      st = lstatSync(file);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    if (!st.isFile() || st.size > MAX_SNAPSHOT || (process.platform !== "win32" && st.mode & 0o077))
      throw new Error("invalid_document_snapshot");
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (
      s.deliveryId !== deliveryId ||
      s.data?.url !== url ||
      typeof s.data.text !== "string" ||
      s.snapshotId !== hash(JSON.stringify(s.data))
    )
      throw new Error("invalid_document_snapshot");
    return s;
  }
  async capture(link, signal) {
    const base = ["--profile", this.profile, "--as", this.identity];
    const output = mkdtempSync(join(this.directory, ".read-"));
    try {
      const args =
        link.kind === "minutes"
          ? [
              "minutes",
              "+detail",
              ...base,
              "--minute-tokens",
              link.token,
              "--summary",
              "--todo",
              "--chapter",
              "--transcript",
              "--output-dir",
              ".",
            ]
          : ["docs", "+fetch", ...base, "--doc", link.url, "--doc-format", "markdown"];
      const raw = await run(this.command, args, signal, output);
      if (raw.identity && raw.identity !== this.identity) throw new Error("document_identity_mismatch");
      if (raw.ok !== true) {
        const e = raw.error || {};
        const minute = link.kind === "minutes" ? raw.data?.minutes?.[0] : null;
        if (minute?.status === "processing" && minute.retryable === true) throw new Error("document_not_ready");
        if (minute && /\b2091005\b|^No read permission for minute\b/.test(minute.error || ""))
          throw Object.assign(new Error("document_permission_required"), {
            requiredScopes: [],
            identity: this.identity,
          });
        if (e.type === "authorization")
          throw Object.assign(new Error("document_permission_required"), {
            requiredScopes: (Array.isArray(e.missing_scopes) ? e.missing_scopes : []).filter(
              (s) => typeof s === "string" && /^[a-z0-9_:.-]{1,150}$/.test(s),
            ),
            identity: this.identity,
          });
        throw new Error("document_read_failed");
      }
      if (raw.identity !== this.identity) throw new Error("document_identity_mismatch");
      if (link.kind !== "minutes") {
        const document = raw.data?.document;
        if (typeof document?.content !== "string") throw new Error("document_cli_invalid_response");
        const comments = document.reference_map?.comments;
        const text = document.content + (comments ? "\n\n[文档评论]\n" + JSON.stringify(comments) : "");
        return {
          kind: link.kind,
          url: link.url,
          title:
            document.title ||
            text
              .split("\n")[0]
              .replace(/^#+\s*/, "")
              .slice(0, 200),
          revision: document.revision_id ?? null,
          text,
          coverage: link.selection ? "shared_selection" : "visible_document_text",
          partial: !link.selection && /^\s*<fragment\b/.test(document.content),
          raw,
        };
      }
      const minute = raw.data?.minutes?.[0];
      if (!minute) throw new Error("document_cli_invalid_response");
      const a = minute.artifacts || {};
      let transcript = "";
      if (a.transcript_file) {
        if (typeof a.transcript_file !== "string") throw new Error("unsafe_transcript_path");
        const transcriptPath = resolve(output, a.transcript_file);
        const st = lstatSync(transcriptPath),
          real = realpathSync(transcriptPath);
        if (!st.isFile() || !real.startsWith(realpathSync(output) + sep)) throw new Error("unsafe_transcript_path");
        if (st.size > MAX_OUTPUT) throw new Error("document_output_too_large");
        transcript = readFileSync(real, "utf8");
      }
      const text = [
        minute.title,
        a.summary,
        a.todos ? JSON.stringify(a.todos) : "",
        a.chapters ? JSON.stringify(a.chapters) : "",
        transcript,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (!text) throw new Error("document_not_ready");
      return {
        kind: "minutes",
        url: link.url,
        title: minute.title || "飞书妙记",
        revision: null,
        text,
        coverage: transcript ? "meeting_artifacts_and_transcript" : "meeting_artifacts",
        partial: !transcript,
        raw,
      };
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
  async read({ deliveryId, url, offset = 0, limit = 20000 }, externalSignal) {
    const link = documentLink(url),
      row = this.inbox.get(deliveryId);
    if (!this.inbox.allowed.has(row.envelope.source.conversationId)) throw new Error("unauthorized_conversation");
    if (!sharedLinks(row.envelope.message).has(link.url)) throw new Error("document_not_shared");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30000)
      throw new Error("invalid_document_range");
    this.directoryReady();
    const file = join(this.directory, hash(deliveryId + "\0" + link.url) + ".json");
    let snapshot = this.load(file, deliveryId, link.url);
    if (!snapshot) {
      const signal = AbortSignal.any([...(externalSignal ? [externalSignal] : []), AbortSignal.timeout(45000)]);
      const data = await this.capture(link, signal);
      snapshot = { deliveryId, capturedAt: new Date().toISOString(), snapshotId: hash(JSON.stringify(data)), data };
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized) > MAX_SNAPSHOT) throw new Error("document_output_too_large");
      try {
        writeFileSync(file, serialized, { mode: 0o600, flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      snapshot = this.load(file, deliveryId, link.url);
    }
    const { raw, text, ...metadata } = snapshot.data;
    if (offset > text.length) throw new Error("invalid_document_range");
    const end = Math.min(text.length, offset + limit);
    return {
      ...metadata,
      untrustedDocument: true,
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      text: text.slice(offset, end),
      offset,
      totalChars: text.length,
      nextOffset: end < text.length ? end : null,
    };
  }
}
