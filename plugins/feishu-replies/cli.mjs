import { execFile } from "node:child_process";

export function run(command, args, content, signal, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command[0],
      [...command.slice(1), ...args],
      { encoding: "utf8", timeout, maxBuffer: 1024 * 1024, windowsHide: true, signal },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(content);
  });
}
