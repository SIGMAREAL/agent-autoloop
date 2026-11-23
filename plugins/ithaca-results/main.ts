import { setTimeout as wait } from "node:timers/promises";
import { poll, readConfig, state } from "./core.ts";

const [mode, file] = process.argv.slice(2);
if (!file || !["once", "watch", "status"].includes(mode || ""))
  throw Error("用法：main.ts <once|watch|status> /绝对路径/config.json");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
if (mode === "status") console.log(JSON.stringify(state(readConfig(file)), null, 2));
else {
  do {
    const c = readConfig(file);
    try {
      const result = await poll(c, { signal: controller.signal });
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      if (mode === "once" && result.errors.length) process.exitCode = 1;
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error(String(e));
        if (mode === "once") process.exitCode = 1;
      }
    }
    if (mode !== "watch" || controller.signal.aborted) break;
    await wait(c.pollSeconds * 1000, undefined, { signal: controller.signal }).catch(() => {});
  } while (!controller.signal.aborted);
}
