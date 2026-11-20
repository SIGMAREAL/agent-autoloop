import { readFileSync } from "node:fs";
import { Avatars } from "./avatars.mjs";
import { run } from "./cli.mjs";

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

export async function renderReply(
  card: Card,
  rule: string,
  stateDir?: string,
  image?: (url: string) => Promise<string | null>,
) {
  if (card.rule !== rule || card.kind !== "notice" || card.state !== "closed") throw new Error("reply_fyi_required");
  const { renderA2ui, loadView } = await import("./ui.mjs");
  const view = card.text.startsWith("a2ui:")
    ? loadView(stateDir, card.text)
    : {
        title: card.title,
        messages: [
          {
            version: "1.0",
            createSurface: {
              surfaceId: "reply",
              catalogId: "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
              components: [
                { id: "root", component: "Column", children: ["answer"] },
                { id: "answer", component: "Text", text: { "@path": "/answer" } },
              ],
              dataModel: { answer: card.text },
            },
          },
        ],
      };
  return renderA2ui(view, { image });
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
  return {
    rule: config.rule,
    stateDir: config.stateDir,
    scope: relay.appId || c.profile,
    chatId: relay.chatIds[0],
    profile: c.profile,
    command: command as string[],
  };
}

// Only output is added here. The existing SDK listener still owns incoming human messages.
export default async function replies({ hub, options, signal, log }: Context) {
  while (!signal.aborted) {
    const { card } = await hub.nextCard(50);
    if (!card) continue;
    try {
      const c = settings(String(options.config));
      if (card.ref) {
        await hub.delivered(card.id, card.version, card.ref);
        continue;
      }
      const avatars = new Avatars({ ...c, signal, log });
      const content = JSON.stringify(await renderReply(card, c.rule, c.stateDir, (url) => avatars.resolve(url)));
      const result = JSON.parse(
        await run(
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
