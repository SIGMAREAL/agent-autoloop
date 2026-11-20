import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: string;
  state: string;
  title: string;
  text: string;
  rule?: string;
};
type Context = {
  options: Record<string, unknown>;
  signal: AbortSignal;
  log(line: string): void;
  hub: {
    nextCard(wait: number): Promise<{ card: Card | null }>;
    delivered(id: number, version: number, ref: string | null): Promise<unknown>;
    failed(id: number, version: number, error: string): Promise<unknown>;
  };
};

export function renderReply(card: Card, rule: string) {
  if (card.rule !== rule || card.kind !== "notice" || card.state !== "closed") throw new Error("reply_fyi_required");
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: card.title } },
    elements: [{ tag: "div", text: { tag: "plain_text", content: card.text } }],
  };
}

function settings(file: string) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const c = config.cardNotifications;
  if (!c?.enabled || typeof config.rule !== "string" || !/^[\w-]+$/.test(c.profile || ""))
    throw new Error("reply_config_required");
  const relay = JSON.parse(readFileSync(c.relayConfig, "utf8"));
  // The current feedback rule shares one session and one authorized group. Never guess among multiple destinations.
  if (!Array.isArray(relay.chatIds) || relay.chatIds.length !== 1 || !/^oc_[a-zA-Z0-9]+$/.test(relay.chatIds[0])) {
    throw new Error("single_authorized_chat_required");
  }
  const command = c.command ?? [c.program];
  if (!Array.isArray(command) || !command.length || command.some((p) => typeof p !== "string" || !p))
    throw new Error("reply_command_required");
  return { rule: config.rule, chatId: relay.chatIds[0], profile: c.profile, command: command as string[] };
}

function send(command: string[], args: string[], content: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command[0],
      [...command.slice(1), ...args],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin!.on("error", () => {});
    child.stdin!.end(content);
  });
}

// Only output is added here. The existing SDK listener still owns incoming human messages.
export default async function replies({ hub, options, signal, log }: Context) {
  while (!signal.aborted) {
    const { card } = await hub.nextCard(50);
    if (!card) continue;
    try {
      const c = settings(String(options.config));
      const content = JSON.stringify(renderReply(card, c.rule));
      if (card.ref) {
        await hub.delivered(card.id, card.version, card.ref);
        continue;
      }
      const result = JSON.parse(
        await send(
          c.command,
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
            `feedback-reply-${card.id}`,
            "--json",
          ],
          content,
          signal,
        ),
      );
      const ref = result.data?.message_id;
      if (result.ok !== true || result.identity !== "bot" || typeof ref !== "string" || !/^om_[\w-]+$/.test(ref)) {
        throw new Error("reply_send_unconfirmed");
      }
      await hub.delivered(card.id, card.version, ref);
    } catch (error) {
      const message = String(error).slice(-500);
      log(`reply card ${card.id}: ${message}`);
      await hub.failed(card.id, card.version, message);
    }
  }
}
