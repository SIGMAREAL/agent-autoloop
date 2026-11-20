import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ghRequest } from "./tools.mjs";
import { issueCreatedView, renderA2ui } from "@agent-autoloop/feishu-a2ui";

function run(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(60_000),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (p) => {
      stdout += p;
      if (stdout.length > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (p) => {
      stderr += p;
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.once("error", () => reject(new Error("card_send_unknown")));
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createCardSender({ program, profile, chatIds }, execute = run) {
  if (!program || !/^[\w-]+$/.test(profile || "") || !Array.isArray(chatIds) || !chatIds.length)
    throw new Error("invalid_card_config");
  const destinations = new Map(chatIds.map((id) => [createHash("sha256").update(id).digest("hex"), id]));
  return async ({ conversationId, payload, key }) => {
    const chatId = destinations.get(conversationId);
    if (!chatId) throw new Error("unauthorized_conversation");
    const result = await execute(
      program,
      [
        "im",
        "+messages-send",
        "--profile",
        profile,
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--msg-type",
        "interactive",
        "--content",
        "-",
        "--idempotency-key",
        key,
        "--json",
      ],
      payload,
    );
    let data;
    for (const value of [result.stdout, result.stderr]) {
      const start = value.indexOf("{");
      if (start < 0) continue;
      try {
        data = JSON.parse(value.slice(start));
        break;
      } catch {
        /* Retain an unknown outcome. */
      }
    }
    if (
      result.exitCode === 0 &&
      data?.ok === true &&
      data.identity === "bot" &&
      /^om_[\w-]+$/.test(data.data?.message_id || "")
    )
      return data.data.message_id;
    const definitelyNotSent = ["authorization", "validation"].includes(data?.error?.type);
    throw Object.assign(new Error(definitelyNotSent ? "card_rejected" : "card_send_unknown"), { definitelyNotSent });
  };
}

export async function notifyOne(
  inbox,
  {
    repo,
    sendCard,
    getIssue = (number) => ghRequest("GET", `repos/${repo}/issues/${number}`),
    renderView = renderA2ui,
  },
) {
  if (!sendCard) return false;
  const row = inbox.nextCard();
  if (!row) return false;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("invalid_repository");
  let payload = row.payload;
  if (!payload) {
    const issue = await getIssue(row.issue);
    if (issue.number !== row.issue || typeof issue.title !== "string") throw new Error("invalid_issue_receipt");
    payload = JSON.stringify(await renderView(issueCreatedView(repo, issue)));
    inbox.prepareCard(row.feedback_id, payload);
  }
  const conversationId = inbox.get(row.feedback_id).envelope.source.conversationId;
  if (!inbox.claimCard(row.feedback_id)) return false;
  try {
    const messageId = await sendCard({
      conversationId,
      payload,
      key: `feedback-${row.issue}-${row.feedback_id.slice(0, 24)}`,
    });
    inbox.finishCard(row.feedback_id, "sent", messageId);
    return { status: "issue_card_sent" };
  } catch (error) {
    const state = error.definitelyNotSent ? "rejected" : "uncertain";
    inbox.finishCard(row.feedback_id, state);
    return { status: `issue_card_${state}` };
  }
}
