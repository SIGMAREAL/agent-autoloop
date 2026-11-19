import { spawn } from "node:child_process";

const privateData = (value) =>
  /(?:\b(?:cli|oc|ou|om)_[A-Za-z0-9_]+\b|https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?<!\d)1[3-9]\d{9}(?!\d)|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/i.test(
    value,
  );

export async function ghRequest(method, path, data) {
  const args = ["api", "--method", method, path];
  if (method === "GET" && data)
    for (const [key, value] of Object.entries(data)) args.push("--raw-field", `${key}=${value}`);
  else if (data) args.push("--input", "-");
  return new Promise((resolve, reject) => {
    const child = spawn("/opt/homebrew/bin/gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(120_000),
    });
    let stdout = "",
      bytes = 0;
    child.stdout.on("data", (part) => {
      bytes += part.length;
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
  constructor(inbox, { repo, github = ghRequest }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("invalid_repository");
    this.inbox = inbox;
    this.repo = repo;
    this.github = github;
    this.path = `repos/${repo}/issues`;
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
  async findIssues({ deliveryId, query = "" }) {
    this.inbox.get(deliveryId);
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
    this.inbox.searched(deliveryId);
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
  async reconcile(deliveryId) {
    const marker = `<!-- petwins-feedback:${deliveryId} -->`;
    for (let page = 1; page <= 2; page++) {
      const issues = await this.github("GET", this.path, {
        state: "all",
        sort: "created",
        direction: "desc",
        per_page: "100",
        page: String(page),
      });
      const match = issues.find((i) => !i.pull_request && String(i.body || "").includes(marker));
      if (match) return this.inbox.decide(deliveryId, "created", "Confirmed GitHub write", match.number);
      if (issues.length < 100) break;
    }
    throw new Error("issue_write_uncertain");
  }
  async createIssue({ deliveryId, title, body }) {
    const row = this.inbox.get(deliveryId);
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
    if (!this.inbox.claimCreate(deliveryId)) return this.reconcile(deliveryId);
    try {
      const issue = await this.github("POST", this.path, {
        title,
        body: `${body}\n\n<!-- petwins-feedback:${deliveryId} -->`,
      });
      if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error("github_invalid_response");
      return this.inbox.decide(
        deliveryId,
        "created",
        "AI classified new feedback after duplicate search",
        issue.number,
      );
    } catch {
      this.inbox.uncertain(deliveryId);
      throw new Error("issue_write_uncertain");
    }
  }
  async decide({ deliveryId, decision, reason, issueNumber = null }) {
    if (
      !["ignored", "needs_info", "duplicate"].includes(decision) ||
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 1500
    )
      throw new Error("invalid_decision");
    const row = this.inbox.get(deliveryId);
    if (row.creationState) throw new Error("issue_write_uncertain");
    if (decision === "duplicate") {
      if (!row.searched) throw new Error("duplicate_search_required");
      await this.readIssue({ issueNumber });
    } else if (issueNumber !== null) throw new Error("invalid_decision");
    return this.inbox.decide(deliveryId, decision, reason, issueNumber);
  }
}
