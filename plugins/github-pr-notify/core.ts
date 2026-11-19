import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Config = {
  enabled: boolean;
  repositories: string[];
  stateDir: string;
  hubUrl: string;
  sourceKey: string;
  sourceName: string;
  ghCommand: string[];
  larkCommand: string[];
  profile: string;
  chatId: string;
};
type PR = { repo: string; number: number; title: string; author: string; draft: boolean; createdAt: string };
type Event = { id: string; type: string; subject: string; summary: string; detail: string; link: string };
const REPO = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/;
const TYPE = "pull_request.opened";
const SCHEMA = "github.pr.notice.v1";
const text = (value: unknown, limit: number) => {
  if (typeof value !== "string") throw new Error("缺少文字资料");
  const cut = value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
};
const link = (pr: PR) => `https://github.com/${pr.repo}/pull/${pr.number}`;
const key = (pr: PR) => createHash("sha256").update(`${pr.repo.toLowerCase()}#${pr.number}`).digest("hex");

export function readConfig(file: string): Config {
  const c = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof c.enabled !== "boolean" ||
    !Array.isArray(c.repositories) ||
    !c.repositories.length ||
    c.repositories.some((repo: unknown) => typeof repo !== "string" || !REPO.test(repo))
  ) {
    throw new Error("配置需要 enabled 与非空仓库清单");
  }
  c.repositories = [...new Set(c.repositories.map((repo: string) => repo.toLowerCase()))];
  for (const name of ["ghCommand", "larkCommand"]) {
    if (
      !Array.isArray(c[name]) ||
      !c[name].length ||
      c[name].some((part: unknown) => typeof part !== "string" || !part)
    ) {
      throw new Error(`配置缺少 ${name}`);
    }
  }
  if (
    !isAbsolute(c.stateDir) ||
    !/^[a-z][a-z0-9-]*$/.test(c.sourceName) ||
    !c.sourceKey ||
    typeof c.profile !== "string" ||
    !c.profile ||
    !/^oc_[a-zA-Z0-9]+$/.test(c.chatId)
  ) {
    throw new Error("配置缺少绝对状态目录、来源、profile 或群 ID");
  }
  const hub = new URL(c.hubUrl);
  if (
    hub.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(hub.hostname) ||
    hub.username ||
    hub.password ||
    hub.pathname !== "/" ||
    hub.search ||
    hub.hash
  ) {
    throw new Error("来源密钥只交给本机中台的 HTTP 根地址");
  }
  return c;
}

export function run(command: string[], args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: AbortSignal.timeout(30_000),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`CLI 退出 ${code}: ${stderr.trim().slice(-300)}`)),
    );
    child.stdin.end(input ?? "");
  });
}

async function listPulls(c: Config, repo: string, page: number): Promise<unknown[]> {
  const endpoint = `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`;
  const data = JSON.parse(await run(c.ghCommand, ["api", "--hostname", "github.com", endpoint]));
  if (!Array.isArray(data)) throw new Error("GitHub 未返回 PR 清单");
  return data;
}

export async function postEvent(c: Config, event: unknown) {
  const response = await fetch(c.hubUrl.replace(/\/$/, "") + "/v1/events", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${c.sourceKey}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`中台返回 ${response.status}`);
  return response.json();
}

function validatePR(c: Config, data: any): PR {
  if (
    !data ||
    typeof data.repo !== "string" ||
    !REPO.test(data.repo) ||
    !c.repositories.some((repo) => repo.toLowerCase() === data.repo.toLowerCase()) ||
    !Number.isSafeInteger(data.number) ||
    data.number <= 0 ||
    typeof data.draft !== "boolean" ||
    typeof data.createdAt !== "string" ||
    !Number.isFinite(Date.parse(data.createdAt))
  ) {
    throw new Error("PR 资料不属于授权仓库，或格式不正确");
  }
  return {
    repo: data.repo.toLowerCase(),
    number: data.number,
    title: text(data.title, 300),
    author: text(data.author, 100),
    draft: data.draft,
    createdAt: new Date(data.createdAt).toISOString(),
  };
}

export async function poll(
  c: Config,
  io = {
    list: (repo: string, page: number) => listPulls(c, repo, page),
    emit: (event: Event): Promise<unknown> => postEvent(c, event),
  },
) {
  const result = { baselined: 0, emitted: 0, errors: [] as string[] };
  if (!c.enabled) return result;
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const file = join(c.stateDir, "cursor.json");
  const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, repos: {} };
  if (
    state.version !== 1 ||
    !state.repos ||
    Object.values(state.repos).some((n) => !Number.isSafeInteger(n) || Number(n) < 0)
  ) {
    throw new Error("游标文件不正确；保留文件，人工核对后恢复");
  }
  const save = () => {
    const temp = file + `.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  };
  for (const repo of c.repositories) {
    try {
      const name = repo.toLowerCase();
      const cursor = state.repos[name];
      const pending = new Map<number, PR>();
      for (let page = 1; ; page++) {
        const data = await io.list(repo, page);
        if (!Array.isArray(data)) throw new Error("GitHub 未返回 PR 清单");
        const items = data.map((p: any) =>
          validatePR(c, {
            repo,
            number: p.number,
            title: p.title,
            author: p.user?.login,
            draft: p.draft,
            createdAt: p.created_at,
          }),
        );
        for (const item of items) if (cursor === undefined || item.number > cursor) pending.set(item.number, item);
        // The first read is a baseline. Later reads finish the new range before advancing any cursor.
        if (cursor === undefined || items.length < 100 || items.some((p) => p.number <= cursor)) break;
      }
      if (cursor === undefined) {
        state.repos[name] = Math.max(0, ...pending.keys());
        save();
        result.baselined++;
        continue;
      }
      for (const pr of [...pending.values()].sort((a, b) => a.number - b.number)) {
        const event: Event = {
          id: `github-pr:${key(pr)}`,
          type: TYPE,
          subject: `pr:${key(pr)}`,
          summary: text(pr.title, 200),
          detail: JSON.stringify(pr),
          link: link(pr),
        };
        const ack: any = await io.emit(event);
        if (
          !ack ||
          !Number.isSafeInteger(ack.event) ||
          ack.event <= 0 ||
          typeof ack.duplicate !== "boolean" ||
          !Array.isArray(ack.routed)
        ) {
          throw new Error("中台没有确认事件已持久化");
        }
        state.repos[name] = pr.number;
        save();
        result.emitted++;
      }
    } catch (error) {
      result.errors.push(`${repo}: ${String(error)}`);
    }
  }
  return result;
}

export function notices(c: Config, context: { events: { source: string; type: string; detail: string }[] }) {
  if (!c.enabled) throw new Error("PR 通知插件已停用；保留排队事件，等待恢复后重试");
  const unique = new Map<string, PR>();
  for (const event of context.events) {
    if (event.source !== c.sourceName || event.type !== TYPE) continue;
    const pr = validatePR(c, JSON.parse(event.detail));
    unique.set(key(pr), pr);
  }
  return [...unique.values()].map((pr) => ({
    key: `pr:${key(pr)}`,
    fyi: true,
    title: `新 PR：${pr.repo} #${pr.number}`,
    text: JSON.stringify({ schema: SCHEMA, ...pr }),
  }));
}

export function renderCard(c: Config, card: { kind: string; state: string; text: string }) {
  if (card.kind !== "notice" || card.state !== "closed") throw new Error("通道只发送 PR FYI 通知");
  const payload = JSON.parse(card.text);
  if (payload.schema !== SCHEMA) throw new Error("通道拒绝非 PR 通知");
  const pr = validatePR(c, payload);
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: `新 PR · ${pr.repo} #${pr.number}` } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: pr.title } },
      {
        tag: "div",
        text: { tag: "plain_text", content: `作者：${pr.author}\n${pr.draft ? "草稿 PR" : "PR"} · ${pr.createdAt}` },
      },
      {
        tag: "action",
        actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: "查看 PR" }, url: link(pr) }],
      },
    ],
  };
}
