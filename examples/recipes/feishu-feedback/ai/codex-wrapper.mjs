import { readFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyDecisions } from "./completion.mjs";

const configPath = process.env.PETWINS_FEEDBACK_AI_CONFIG;
if (!configPath) throw new Error("feedback_config_required");
const config = JSON.parse(readFileSync(configPath, "utf8"));
let args = process.argv.slice(2);
if (args[0] === "exec") {
  // Auth remains in the user's own Codex home; unrelated configuration/tools are not loaded.
  const options = {
    model: config.model,
    model_reasoning_effort: config.effort,
    sandbox_mode: "read-only",
    approval_policy: "never",
    web_search: "disabled",
    "mcp_servers.feedback.command": process.execPath,
    "mcp_servers.feedback.args": [fileURLToPath(new URL("./mcp.mjs", import.meta.url)), "--config", configPath],
    "mcp_servers.feedback.required": true,
    "mcp_servers.feedback.startup_timeout_sec": 30,
    "mcp_servers.feedback.tool_timeout_sec": 180,
    "mcp_servers.feedback.enabled_tools": [
      "read_context",
      "read_feedback",
      "find_issues",
      "read_issue",
      ...(config.prRepositoriesFile ? ["list_pull_requests"] : []),
      "create_issue",
      "record_decision",
    ],
    // The user explicitly authorized these two writes. Other tools keep their default approval policy.
    "mcp_servers.feedback.tools.create_issue.approval_mode": "approve",
    "mcp_servers.feedback.tools.record_decision.approval_mode": "approve",
    ...(process.env.AGENT_AUTOLOOP_CONTEXT
      ? {
          "mcp_servers.feedback.env.AGENT_AUTOLOOP_CONTEXT": process.env.AGENT_AUTOLOOP_CONTEXT,
        }
      : {}),
  };
  const overrides = Object.entries(options).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
  const disabled = [
    "apps",
    "plugins",
    "remote_plugin",
    "memories",
    "hooks",
    "computer_use",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "image_generation",
    "multi_agent",
    "multi_agent_v2",
    "shell_tool",
  ];
  args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    ...args.slice(1),
    ...overrides,
    ...disabled.flatMap((feature) => ["--disable", feature]),
  ];
} else if (
  !(args.length === 2 && args[0] === "login" && args[1] === "status") &&
  !(args.length === 1 && args[0] === "--version")
) {
  throw new Error("feedback_codex_command_not_allowed");
}
const child = spawn(config.codexProgram, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));
child.once("error", () => process.exit(1));
child.once("exit", (code) => {
  if (code === 0 && args[0] === "exec") {
    try {
      verifyDecisions(config, process.env.AGENT_AUTOLOOP_CONTEXT);
    } catch {
      // Autoloop's Codex adapter trusts turn.completed even with a later nonzero exit.
      // A terminal failure event preserves the session while making the business failure visible.
      writeSync(
        1,
        JSON.stringify({
          type: "turn.failed",
          error: { message: "feedback_decision_missing" },
        }) + "\n",
      );
      console.error("feedback_decision_missing");
      process.exit(1);
    }
  }
  process.exit(code ?? 1);
});
