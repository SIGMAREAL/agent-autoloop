import { readFileSync, statSync } from "node:fs";
import { Inbox, createIngress, dispatchOne, reconcileRouting } from "./intake.mjs";
import { acquireLock } from "../src/runtime.mjs";
import { createCardSender, notifyOne } from "./notifications.mjs";
import { renderA2ui } from "@agent-autoloop/feishu-a2ui";
import { Avatars } from "@agent-autoloop/feishu-a2ui/avatars";

process.umask(0o077);
const path = process.argv[process.argv.indexOf("--config") + 1];
if (!path || statSync(path).mode & 0o077) throw new Error("private_ai_config_required");
const config = JSON.parse(readFileSync(path, "utf8"));
const hub = new URL(config.hubUrl);
if (
  hub.protocol !== "http:" ||
  hub.hostname !== "127.0.0.1" ||
  !config.sourceToken ||
  !config.token ||
  !Number.isSafeInteger(config.port) ||
  config.port < 1024 ||
  config.port > 65535
)
  throw new Error("invalid_ai_config");
if (process.argv.includes("--reconcile-routing") || process.argv.includes("--retry-rejected-cards")) {
  const inbox = new Inbox(config.stateDir, config.allowedConversations);
  try {
    console.log(
      JSON.stringify(
        process.argv.includes("--retry-rejected-cards")
          ? { retried: inbox.retryRejectedCards() }
          : await reconcileRouting(inbox, config),
      ),
    );
  } finally {
    inbox.close();
  }
  process.exit(0);
}
const release = acquireLock(config.stateDir);
const inbox = new Inbox(config.stateDir, config.allowedConversations);
inbox.recoverCards();
let sendCard, renderView;
if (config.cardNotifications?.enabled) {
  const relayPath = config.cardNotifications.relayConfig;
  if (!relayPath || statSync(relayPath).mode & 0o077) throw new Error("private_relay_config_required");
  const relay = JSON.parse(readFileSync(relayPath, "utf8"));
  sendCard = createCardSender({
    program: config.cardNotifications.program,
    profile: config.cardNotifications.profile,
    chatIds: relay.chatIds,
  });
  renderView = (view) => {
    const avatars = new Avatars({
      stateDir: config.stateDir,
      profile: config.cardNotifications.profile,
      scope: relay.appId || config.cardNotifications.profile,
      command: [config.cardNotifications.program],
      signal: AbortSignal.timeout(45_000),
      log: (detail) => console.log(JSON.stringify({ status: "issue_avatar_unavailable", detail })),
    });
    return renderA2ui(view, { image: (url) => avatars.resolve(url) });
  };
}
const server = createIngress({ inbox, token: config.token });
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, "127.0.0.1", () => console.log(JSON.stringify({ status: "ai_ingress_started" })));
let busy = false,
  retryAt = 0,
  cardRetryAt = 0;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    if (Date.now() >= retryAt) {
      try {
        const result = await dispatchOne(inbox, config);
        if (result) console.log(JSON.stringify(result));
      } catch {
        retryAt = Date.now() + 30_000;
        console.log(JSON.stringify({ status: "dispatch_pending_retry" }));
      }
    }
    if (sendCard && Date.now() >= cardRetryAt) {
      try {
        const result = await notifyOne(inbox, { repo: config.repo, sendCard, renderView });
        if (result) console.log(JSON.stringify(result));
      } catch {
        cardRetryAt = Date.now() + 30_000;
        console.log(JSON.stringify({ status: "issue_card_pending_retry" }));
      }
    }
  } finally {
    busy = false;
  }
}, 1000);
async function stop() {
  clearInterval(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
  inbox.close();
  release();
  process.exit(0);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
