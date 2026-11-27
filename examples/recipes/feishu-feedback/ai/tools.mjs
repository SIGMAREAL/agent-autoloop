import { spawn } from "node:child_process";
import { createMediaIssue, readVideoFrames, mediaExtensions, checkMediaProgram } from "./media.mjs";

const privateData = (value) =>
  /(?:\b(?:cli|oc|ou|om)_[A-Za-z0-9_]+\b|https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/|https:\/\/(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)\/(?:docx|wiki|minutes|notes|doc)\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/i.test(
    value,
  );

export async function ghRequest(
  method,
  path,
  data,
  { program = "/opt/homebrew/bin/gh", signal, timeoutMs = 120_000 } = {},
) {
  const args = ["api", "--method", method, path];
  if (method === "GET" && data)
    for (const [key, value] of Object.entries(data)) args.push("--raw-field", `${key}=${value}`);
  else if (data) args.push("--input", "-");
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    let stdout = "",
      bytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => {
      bytes += Buffer.byteLength(part);
      if (bytes > 4 * 1024 * 1024) child.kill();
      else stdout += part;
    });
    child.stderr.resume();
    child.on("error", () => reject(new Error("github_request_failed")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("github_request_failed"));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("github_invalid_response"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(method !== "GET" && data ? JSON.stringify(data) : undefined);
  });
}

export class FeedbackTools {
  constructor(inbox, { repo, github = ghRequest, multiIssue = false, media, mediaCreate = createMediaIssue }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("invalid_repository");
    this.inbox = inbox;
    this.repo = repo;
    this.github = github;
    this.path = `repos/${repo}/issues`;
    this.multiIssue = multiIssue === true;
    this.media = media;
    this.mediaCreate = mediaCreate;
  }
  readVideoFrames(args) {
    return readVideoFrames(this.inbox, args, this.media);
  }
  scope(deliveryId, actionKey = null) {
    if (actionKey !== null && !this.multiIssue) throw new Error("multiple_actions_disabled");
    return this.inbox.scope(deliveryId, actionKey).row;
  }
  async planActions({ deliveryId, actions }) {
    if (!this.multiIssue) throw new Error("multiple_actions_disabled");
    const row = this.inbox.planActions(deliveryId, actions);
    return { deliveryId, decision: row.decision, actionPlan: row.actionPlan, issueNumbers: row.issueNumbers };
  }
  readFeedback({ deliveryId }) {
    const row = this.inbox.get(deliveryId);
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          ...row.envelope,
          decision: row.decision,
          issueNumber: row.issueNumber,
          issueNumbers: row.issueNumbers,
          actionPlan: row.actionPlan,
        }),
      },
    ];
    for (const [index, a] of row.envelope.attachments.entries()) {
      if (a.status !== "available") continue;
      const bytes = this.inbox.readAttachment(deliveryId, index);
      if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a.mimeType))
        content.push({
          type: "image",
          mimeType: a.mimeType,
          data: bytes.toString("base64"),
        });
      else if (bytes.length <= 30_000) {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (!text.includes("\0"))
            content.push({
              type: "text",
              text: JSON.stringify({ untrustedAttachment: a.name, text }),
            });
        } catch {
          /* Binary attachment remains available by its private path. */
        }
      }
    }
    return { content };
  }
  async findIssues({ deliveryId, query = "", actionKey = null }) {
    this.scope(deliveryId, actionKey);
    if (typeof query !== "string" || query.length > 200 || /[:\r\n]/.test(query) || privateData(query))
      throw new Error("invalid_search");
    let issues;
    if (query.trim()) {
      const result = await this.github("GET", "search/issues", {
        q: `repo:${this.repo} is:issue ${query}`,
        per_page: "30",
        sort: "updated",
      });
      issues = result.items;
    } else
      issues = await this.github("GET", this.path, {
        state: "all",
        sort: "updated",
        per_page: "50",
      });
    if (!Array.isArray(issues)) throw new Error("github_invalid_response");
    this.inbox.searched(deliveryId, actionKey);
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        url: i.html_url,
        body: String(i.body || "").slice(0, 3000),
      }));
  }
  async readIssue({ issueNumber }) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("invalid_issue_number");
    const issue = await this.github("GET", `${this.path}/${issueNumber}`);
    if (issue.pull_request) throw new Error("issue_required");
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      body: String(issue.body || "").slice(0, 30_000),
    };
  }
  async reconcile(deliveryId, actionKey = null) {
    const marker = `<!-- petwins-feedback:${deliveryId}${actionKey === null ? "" : ":" + actionKey} -->`;
    for (let page = 1; page <= 2; page++) {
      const issues = await this.github("GET", this.path, {
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: "100",
        page: String(page),
      });
      const match = issues.find((i) => !i.pull_request && String(i.body || "").includes(marker));
      if (match) return this.inbox.decide(deliveryId, "created", "Confirmed GitHub write", match.number, actionKey);
      if (issues.length < 100) break;
    }
    throw new Error("issue_write_uncertain");
  }
  async createIssue({ deliveryId, title, body, actionKey = null, attachments = [] }) {
    const row = this.scope(deliveryId, actionKey);
    if (row.decision === "created") return row;
    if (row.decision) throw new Error("feedback_already_decided");
    if (!row.searched) throw new Error("duplicate_search_required");
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 200 ||
      typeof body !== "string" ||
      !body.trim() ||
      body.length > 20_000
    )
      throw new Error("invalid_issue_draft");
    if (privateData(title + "\n" + body)) throw new Error("private_data_in_issue");
    if (!Array.isArray(attachments) || attachments.length > 10) throw new Error("invalid_issue_attachments");
    const conversation = this.inbox.get(deliveryId).envelope.source.conversationId;
    const seen = new Set();
    const files = attachments
      .map((ref) => {
        if (!Number.isSafeInteger(ref.index) || ref.index < 0) throw new Error("invalid_attachment_index");
        const source = this.inbox.get(ref.deliveryId);
        if (source.envelope.source.conversationId !== conversation) throw new Error("attachment_conversation_mismatch");
        const item = source.envelope.attachments[ref.index];
        if (item?.status !== "available" || !mediaExtensions[item.mimeType])
          throw new Error("unsupported_issue_attachment");
        if (!this.media?.ghProgram) throw new Error("media_program_required");
        const bytes = this.inbox.readAttachment(ref.deliveryId, ref.index);
        if (seen.has(item.sha256)) return null;
        seen.add(item.sha256);
        return { bytes, mimeType: item.mimeType };
      })
      .filter(Boolean);
    if (files.length && this.mediaCreate === createMediaIssue) await checkMediaProgram(this.media);
    if (!this.inbox.claimCreate(deliveryId, actionKey)) return this.reconcile(deliveryId, actionKey);
    try {
      const draft = {
        title,
        body: `${body}\n\n<!-- petwins-feedback:${deliveryId}${actionKey === null ? "" : ":" + actionKey} -->`,
      };
      const issue = files.length
        ? await this.mediaCreate({ repo: this.repo, ...draft, files }, this.media)
        : await this.github("POST", this.path, draft);
      if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error("github_invalid_response");
      const result = this.inbox.decide(
        deliveryId,
        "created",
        issue.attachmentsComplete === false
          ? "Issue created; attachment upload incomplete"
          : "AI classified new feedback after duplicate search",
        issue.number,
        actionKey,
      );
      return {
        ...result,
        ...(files.length ? { attachmentStatus: issue.attachmentsComplete ? "uploaded" : "incomplete" } : {}),
      };
    } catch {
      this.inbox.uncertain(deliveryId, actionKey);
      throw new Error("issue_write_uncertain");
    }
  }
  async decide({ deliveryId, decision, reason, issueNumber = null, actionKey = null }) {
    if (
      !["ignored", "needs_info", "duplicate"].includes(decision) ||
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 1500
    )
      throw new Error("invalid_decision");
    const row = this.scope(deliveryId, actionKey);
    if (row.creationState) throw new Error("issue_write_uncertain");
    if (decision === "duplicate") {
      if (!row.searched) throw new Error("duplicate_search_required");
      await this.readIssue({ issueNumber });
    } else if (issueNumber !== null) throw new Error("invalid_decision");
    return this.inbox.decide(deliveryId, decision, reason, issueNumber, actionKey);
  }
}
