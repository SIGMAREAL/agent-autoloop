import { DatabaseSync } from "node:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

export function verifyDecisions(config, contextPath) {
  if (!contextPath) return;
  const path = realpathSync(contextPath);
  if (!path.startsWith(realpathSync(config.contextRoot) + sep)) throw new Error("invalid_context_path");
  const context = JSON.parse(readFileSync(path, "utf8"));
  const ids = (context.events || [])
    .filter((event) => event.type === "feishu.feedback")
    .map((event) => JSON.parse(event.detail).deliveryId);
  if (!ids.length) return;
  const db = new DatabaseSync(join(config.stateDir, "feedback.sqlite"), {
    readOnly: true,
  });
  try {
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id || "")) throw new Error("invalid_feedback_id");
      const row = db.prepare("SELECT decision FROM feedback WHERE id=?").get(id);
      if (!row?.decision) throw new Error("feedback_decision_missing");
      if (
        config.multiIssue &&
        db.prepare("SELECT 1 FROM feedback_actions WHERE feedback_id=? AND decision IS NULL LIMIT 1").get(id)
      )
        throw new Error("feedback_action_incomplete");
    }
  } finally {
    db.close();
  }
}
