import { readConfig, renderCard, run } from "./core.ts";
import { Avatars } from "@agent-autoloop/feishu-a2ui/avatars";

type Card = { id: number; version: number; ref: string | null; kind: string; state: string; text: string };
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

// Send-only: the existing application keeps its one Feishu event connection.
export default async function channel({ hub, options, signal, log }: Context) {
  while (!signal.aborted) {
    const { card } = await hub.nextCard(50);
    if (!card) continue;
    try {
      const c = readConfig(String(options.config));
      if (!c.enabled) throw new Error("PR 通知插件已停用");
      const avatars = new Avatars({
        stateDir: c.stateDir,
        profile: c.profile,
        scope: c.profile,
        command: c.larkCommand,
        signal,
        log,
      });
      const content = await renderCard(c, card, card.ref ? {} : { image: (url) => avatars.resolve(url) });
      if (card.ref) {
        await hub.delivered(card.id, card.version, card.ref);
        continue;
      }
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
            `autoloop-pr-${card.id}`,
            "--json",
          ],
          JSON.stringify(content),
        ),
      );
      const ref = answer.data?.message_id;
      if (answer.ok !== true || answer.identity !== "bot" || typeof ref !== "string" || !/^om_[\w-]+$/.test(ref)) {
        throw new Error("飞书没有确认机器人消息已发送");
      }
      await hub.delivered(card.id, card.version, ref);
    } catch (error) {
      const message = String(error).slice(0, 500);
      log(`PR card ${card.id}: ${message}`);
      await hub.failed(card.id, card.version, message);
    }
  }
}
