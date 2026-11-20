import { join } from "node:path";
import { nodePath } from "./node-path.ts";

// The installed plugin carries its own small interface; it does not import the engine checkout.
export default {
  command: (turn: { command?: string[] }) => [
    nodePath(process.execPath),
    join(import.meta.dirname, "main.ts"),
    ...(turn.command ?? []),
  ],
  read(stdout: string, code: number | null, stderr: string) {
    if (code === null) return {};
    if (code !== 0) return { error: stderr.trim().slice(-300) || `PR 通知命令退出 ${code}` };
    return { text: stdout };
  },
};
