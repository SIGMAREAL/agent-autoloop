import { readFileSync } from "node:fs";
import { notices, poll, readConfig } from "./core.ts";

try {
  const [mode, file] = process.argv.slice(2);
  if (!file || !["poll", "notify"].includes(mode)) throw new Error("用法：main.ts <poll|notify> /绝对路径/config.json");
  const config = readConfig(file);
  if (mode === "poll") {
    const result = await poll(config);
    if (result.errors.length) throw new Error(result.errors.join("\n"));
    console.log(`PR 检查完成：基线 ${result.baselined} 个仓库，投递 ${result.emitted} 个新 PR。`);
  } else {
    const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
    const notice = notices(config, context);
    console.log(notice.length ? `已整理 ${notice.length} 个新 PR 通知。` : "没事可做：没有新 PR。");
    if (notice.length) console.log("\n```agent-autoloop\n" + JSON.stringify({ notice }) + "\n```");
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
