import { readFileSync, statSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { issueResultView, renderA2ui } from "@agent-autoloop/feishu-a2ui";
import { Avatars } from "@agent-autoloop/feishu-a2ui/avatars";
import { run as command } from "@agent-autoloop/feishu-a2ui/cli";
import { readSnapshot } from "./source.ts";

const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const clip = (x: unknown, n: number) => (typeof x === "string" ? Array.from(x).slice(0, n).join("") : "");
const repository = /^[\w.-]+\/[\w.-]+$/;
export type Result = {
  id: string;
  repo: string;
  number: number;
  title: string;
  outcome: string;
  status: string;
  summary: string;
  reason: string;
  author: string;
  avatarUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  resultAt?: string;
  prUrl?: string;
  commentUrl?: string;
};
export type Config = {
  enabled: boolean;
  source: string;
  project: string;
  repositories: string[];
  sourceCommand: string[];
  databaseFile: string;
  stateDir: string;
  pollSeconds: number;
  timeZone: string;
  profile: string;
  chatId: string;
  larkCommand: string[];
};
function privateJson(file: string) {
  if (!isAbsolute(file)) throw Error("absolute_private_config_required");
  const st = lstatSync(file);
  if (!st.isFile() || st.mode & 0o077) throw Error("private_regular_config_required");
  return JSON.parse(readFileSync(file, "utf8"));
}
function argv(x: unknown): x is string[] {
  return Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === "string" && s && !s.includes("\0"));
}
export function readConfig(file: string): Config {
  const c = privateJson(file),
    d = privateJson(c.destinationConfig);
  if (typeof c.enabled !== "boolean" || !/^[\w-]+$/.test(c.source || "") || !/^[\w-]+$/.test(c.project || ""))
    throw Error("invalid_source");
  if (
    !Array.isArray(c.repositories) ||
    !c.repositories.length ||
    c.repositories.some((x: string) => !repository.test(x))
  )
    throw Error("explicit_repositories_required");
  if (
    !argv(c.sourceCommand) ||
    !argv(d.larkCommand) ||
    !isAbsolute(c.databaseFile || "") ||
    !isAbsolute(c.stateDir || "")
  )
    throw Error("invalid_command_or_path");
  if (!Number.isInteger(c.pollSeconds) || c.pollSeconds < 10 || c.pollSeconds > 3600)
    throw Error("invalid_poll_interval");
  if (typeof c.timeZone !== "string") throw Error("explicit_time_zone_required");
  new Intl.DateTimeFormat("en-CA", { timeZone: c.timeZone }).format(new Date());
  if (!d.enabled || !/^[\w-]+$/.test(d.profile || "") || !/^oc_[\w]+$/.test(d.chatId || ""))
    throw Error("existing_bot_destination_required");
  return { ...c, profile: d.profile, chatId: d.chatId, larkCommand: d.larkCommand };
}

export function selectResults(snapshot: any, c: Pick<Config, "project" | "repositories">): Result[] {
  if (snapshot?.project !== c.project || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.tasks))
    throw Error("invalid_execution_snapshot");
  return snapshot.items.flatMap((i: any) => {
    if (!c.repositories.includes(i.repo)) return [];
    if (typeof i.id !== "string" || !Number.isSafeInteger(i.number) || i.number < 1)
      throw Error("invalid_issue_identity");
    const tasks = snapshot.tasks.filter((t: any) => (i.taskIds || []).includes(t.id));
    const t = tasks.find((t: any) => t.prUrl);
    const blocked = i.state !== "parked" && tasks.find((t: any) => t.state === "blocked");
    let outcome, status;
    if (i.state === "closed" && i.comment?.html_url) {
      outcome = "closed";
      status = "已关闭";
    } else if (i.state === "enriched" && i.comment?.html_url) {
      outcome = "enriched";
      status = "已补充";
    } else if (t && (t.state === "merged" || i.state === "merged" || i.pr?.state === "merged")) {
      outcome = "pr";
      status = "PR 已合并";
    } else if (t && (t.blocker === "pr-closed" || i.state === "pr-closed" || i.pr?.state === "closed")) {
      outcome = "pr";
      status = "PR 已关闭（未合并）";
    } else if (["needs-human", "held"].includes(i.state)) {
      outcome = "human";
      status = "待人工处理";
    } else if (blocked) {
      outcome = "human";
      status = "任务未完成";
    } else if (t) {
      outcome = "pr";
      status = "已创建 PR";
    } else return [];
    if (outcome === "human" && !t) return [];
    const issueUrl = `https://github.com/${i.repo}/issues/${i.number}`;
    const commentUrl = i.comment?.html_url;
    if (
      commentUrl &&
      !(
        commentUrl.startsWith(issueUrl + "#issuecomment-") &&
        /^\d+$/.test(commentUrl.slice((issueUrl + "#issuecomment-").length))
      )
    )
      throw Error("invalid_issue_comment_receipt");
    const prUrl = t?.prUrl;
    if (
      prUrl &&
      !(
        prUrl.startsWith(`https://github.com/${i.repo}/pull/`) &&
        /^[1-9]\d*$/.test(prUrl.slice(`https://github.com/${i.repo}/pull/`.length))
      )
    )
      throw Error("invalid_pr_receipt");
    const ci =
      status === "PR 已合并"
        ? "GitHub 已确认 PR 合并。"
        : status === "PR 已关闭（未合并）"
          ? "GitHub 已确认 PR 关闭，未合并。"
          : i.pr?.green === true && i.pr.head === t?.result?.headSha
            ? "CI：已通过，等待人工 Review。"
            : i.pr?.failed
              ? "CI：未通过，等待修复；尚未合并。"
              : "CI：未确认通过；等待人工 Review，尚未合并。";
    const blocker = outcome === "human" ? i.blocker || blocked?.blocker || (blocked ? "execution" : null) : null;
    const blockers: Record<string, string> = {
      "pr-head-changed": "PR 提交已由其他操作改变，需要人工检查。",
      authorization: "改动超出当前持续授权，需要人工处理。",
      cleanup: "上一轮进程清理状态未确认，已停止自动重试。",
      execution: "开发或验证未完成，需要人工检查运行记录。",
    };
    return [
      {
        id: i.id,
        repo: i.repo,
        number: i.number,
        title: clip(i.title, 200),
        outcome,
        status,
        summary: blocker
          ? t
            ? "自动处理已停下，原有 PR 已保留。"
            : "自动处理已停下，原有工作记录已保留。"
          : clip((outcome === "pr" ? t?.result?.summary : null) || i.summary, 300),
        reason: clip(blocker ? blockers[blocker] || blockers.execution : outcome === "pr" ? ci : i.reason, 500),
        author: clip(i.author, 80),
        avatarUrl: i.avatarUrl,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        resultAt: t?.resultAt && Date.parse(t.resultAt) > (Date.parse(i.resultAt) || 0) ? t.resultAt : i.resultAt,
        ...(prUrl ? { prUrl } : {}),
        ...(commentUrl ? { commentUrl } : {}),
      },
    ];
  });
}
function openState(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!statSync(dir).isDirectory()) throw Error("invalid_state_directory");
  const file = join(dir, "results.sqlite"),
    db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
  );
  return db;
}
function live(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== "ESRCH";
  }
}
export function state(c: Pick<Config, "stateDir">) {
  const db = openState(c.stateDir);
  try {
    return {
      deliveries: db
        .prepare("SELECT body FROM results")
        .all()
        .map((x: any) => JSON.parse(x.body)),
      poll: db.prepare("SELECT body FROM meta WHERE id='poll'").get(),
    };
  } finally {
    db.close();
  }
}
export async function poll(
  c: Config,
  ports: {
    snapshot?: () => Promise<any>;
    run?: typeof command;
    image?: (url: string) => Promise<string | null>;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
) {
  const counts = { sent: 0, updated: 0, unchanged: 0, errors: [] as string[] };
  if (!c.enabled) return counts;
  const db = openState(c.stateDir),
    token = randomUUID();
  const put = (table: string, id: string, body: any) =>
    db
      .prepare(`INSERT INTO ${table}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`)
      .run(id, JSON.stringify(body));
  let locked = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    const lock: any = db.prepare("SELECT body FROM meta WHERE id='lock'").get();
    if (lock && live(JSON.parse(lock.body).pid)) {
      db.exec("ROLLBACK");
      throw Error("result_notifier_already_polling");
    }
    put("meta", "lock", { pid: process.pid, token });
    db.exec("COMMIT");
    locked = true;
    const snapshot = ports.snapshot ? await ports.snapshot() : await readSnapshot(c, ports.signal);
    const results = selectResults(snapshot, c),
      run = ports.run || command;
    const avatars = new Avatars({
      stateDir: c.stateDir,
      profile: c.profile,
      scope: c.profile,
      command: c.larkCommand,
      signal: ports.signal ?? new AbortController().signal,
      log: () => {},
    });
    for (const result of results) {
      ports.signal?.throwIfAborted();
      const id = hash({
        source: c.source,
        profile: c.profile,
        chat: c.chatId,
        repo: result.repo,
        number: result.number,
      });
      const digest = hash({ result, timeZone: c.timeZone });
      const old: any = db.prepare("SELECT body FROM results WHERE id=?").get(id);
      const record = old ? JSON.parse(old.body) : { id, messageId: null, digest: null };
      if (record.digest === digest) {
        counts.unchanged++;
        continue;
      }
      put("results", id, { ...record, result, pendingDigest: digest });
      try {
        const content = JSON.stringify(
          await renderA2ui(issueResultView({ ...result, timeZone: c.timeZone }), {
            image: ports.image || ((url: string) => avatars.resolve(url)),
          }),
        );
        if (Buffer.byteLength(content) > 29_000) throw Error("result_card_too_large");
        let created = false;
        if (!record.messageId) {
          const now = (ports.now || Date.now)();
          // Feishu's UUID deduplication expires after one hour. Never repeat an uncertain POST after that window.
          if (record.firstSendAt && (now < record.firstSendAt || now - record.firstSendAt >= 55 * 60_000))
            throw Error("发送回执仍未知，该条已暂停；请核对原消息，避免重复发卡");
          record.firstSendAt ??= now;
          put("results", id, { ...record, result, pendingDigest: digest });
          const answer = JSON.parse(
            await run(
              c.larkCommand,
              [
                "im",
                "+messages-send",
                "--profile",
                c.profile,
                "--as",
                "bot",
                "--chat-id",
                c.chatId,
                "--msg-type",
                "interactive",
                "--content",
                "-",
                "--idempotency-key",
                "ithaca-" + id.slice(0, 40),
                "--json",
              ],
              content,
              ports.signal,
            ),
          );
          if (answer.ok !== true || answer.identity !== "bot" || !/^om_[\w-]+$/.test(answer.data?.message_id || ""))
            throw Error("bot_send_unconfirmed");
          record.messageId = answer.data.message_id;
          created = true;
          put("results", id, { ...record, result, pendingDigest: digest });
        }
        // A replayed native send may return an older payload; synchronize before recording the new digest.
        const answer = JSON.parse(
          await run(
            c.larkCommand,
            [
              "im",
              "messages",
              "patch",
              "--profile",
              c.profile,
              "--as",
              "bot",
              "--message-id",
              record.messageId,
              "--data",
              "-",
              "--json",
            ],
            JSON.stringify({ content }),
            ports.signal,
          ),
        );
        if (answer.ok !== true || answer.identity !== "bot") throw Error("bot_update_unconfirmed");
        put("results", id, {
          ...record,
          result,
          digest,
          pendingDigest: null,
          lastError: null,
          deliveredAt: new Date().toISOString(),
        });
        if (created) counts.sent++;
        else counts.updated++;
      } catch (e) {
        const error = String(e).slice(0, 500);
        counts.errors.push(`${result.repo}#${result.number}: ${error}`);
        put("results", id, { ...record, result, pendingDigest: digest, lastError: error });
      }
    }
    put("meta", "poll", { at: new Date().toISOString(), runId: snapshot.run?.id, ...counts });
    return counts;
  } finally {
    if (locked) db.prepare("DELETE FROM meta WHERE id='lock'").run();
    db.close();
  }
}
