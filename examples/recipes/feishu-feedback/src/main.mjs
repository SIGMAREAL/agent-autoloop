import * as Lark from "@larksuiteoapi/node-sdk";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { Relay, Store } from "./core.mjs";
import { createMediaReader, createForwarder, createBoundedHttp } from "./adapters.mjs";
import { loadConfig, acquireLock } from "./runtime.mjs";

process.umask(0o077);
const args = process.argv.slice(2);
const index = args.indexOf("--config");
if (index < 0 || !args[index + 1]) {
  console.error("Usage: node src/main.mjs --config /private/config.json [--check|--connect-only]");
  process.exit(2);
}
const connectOnly = args.includes("--connect-only");
const statusOnly = args.includes("--status");
const operatorCommand = args.includes("--confirm-delivered")
  ? "--confirm-delivered"
  : args.includes("--retry-delivery")
    ? "--retry-delivery"
    : null;
const log = (status, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), status, ...extra }));
try {
  const config = loadConfig(args[index + 1], {
    connectOnly: connectOnly || statusOnly || Boolean(operatorCommand),
  });
  const shutdown = new AbortController();
  const forward =
    connectOnly || statusOnly || operatorCommand ? null : createForwarder(config.target, { signal: shutdown.signal });
  const databasePath = join(config.stateDir, "relay.sqlite");
  if (statusOnly) {
    log("queue_status", {
      allowedChats: config.chatIds.length,
      targetConfigured: Boolean(config.target?.url),
      ...Store.inspect(databasePath),
    });
    process.exit(0);
  }
  if (args.includes("--check")) {
    log("config_valid", { allowedChats: config.chatIds.length, connectOnly });
    process.exit(0);
  }
  const release = acquireLock(config.stateDir);
  if (operatorCommand) {
    const id = args[args.indexOf(operatorCommand) + 1];
    if (!/^[a-f0-9]{64}$/.test(id || "")) {
      release();
      throw new Error("invalid_delivery_id");
    }
    const state = new Store(databasePath);
    const changed = operatorCommand === "--confirm-delivered" ? state.confirmDelivered(id) : state.retryUncertain(id);
    state.close();
    release();
    if (!changed) throw new Error("unknown_uncertain_delivery");
    log("delivery_reconciled");
    process.exit(0);
  }
  const logger = {
    error: (...values) =>
      log("feishu_transport_error", {
        codes: values
          .filter((v) => v && typeof v === "object")
          .map((v) => ({
            code: v.code,
            status: v.response?.status,
            apiCode: v.response?.data?.code,
          })),
      }),
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
  const base = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Lark.Domain.Feishu,
    logger,
    httpInstance: createBoundedHttp(Lark.defaultHttpInstance, {
      signal: shutdown.signal,
    }),
  };
  const client = new Lark.Client(base);
  const ws = new Lark.WSClient({
    ...base,
    loggerLevel: Lark.LoggerLevel.error,
    handshakeTimeoutMs: 20000,
    onReady: () => log("websocket_connected"),
    onReconnecting: () => log("websocket_reconnecting"),
    onError: () => log("websocket_failed"),
  });
  const store = connectOnly ? null : new Store(databasePath);
  const bot = store
    ? new Relay({
        store,
        allowedChats: config.chatIds,
        io: {
          download: createMediaReader(client, { signal: shutdown.signal }),
          forward,
        },
      })
    : null;
  const discoveredPath = join(config.stateDir, "discovered-chats.json");
  const discovered = new Set(
    existsSync(discoveredPath) ? JSON.parse(readFileSync(discoveredPath, "utf8")).chatIds : [],
  );
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      if (connectOnly) {
        // Bootstrap metadata only. No content is stored, downloaded, sent to AI or filed.
        const id = event.message?.chat_id;
        if (event.message?.chat_type === "group" && /^oc_[\w]+$/.test(id || "") && !discovered.has(id)) {
          discovered.add(id);
          writeFileSync(discoveredPath, JSON.stringify({ chatIds: [...discovered] }) + "\n", { mode: 0o600 });
          log("group_metadata_discovered");
        }
      } else if (bot.receive(event)) log("message_queued");
      return {};
    },
  });
  let current;
  let retryAfter = 0;
  let stopping = false;
  let lastStatus;
  const timer = bot
    ? setInterval(() => {
        if (stopping || current || Date.now() < retryAfter) return;
        current = bot
          .tick()
          .then((r) => {
            if (!["idle", "busy"].includes(r.status) && r.status !== lastStatus) log(r.status);
            lastStatus = r.status;
          })
          .catch(() => {
            if (!stopping) {
              retryAfter = Date.now() + 60_000;
              log("processing_failed_will_retry");
            }
          })
          .finally(() => {
            current = null;
          });
      }, 1000)
    : null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    shutdown.abort();
    ws.close({ force: true });
    await current;
    store?.close();
    release();
    log("stopped");
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await ws.start({ eventDispatcher: dispatcher });
  log(connectOnly ? "metadata_receiver_started" : "receiver_started", {
    allowedChats: config.chatIds.length,
    connectionState: ws.getConnectionStatus().state,
  });
} catch (error) {
  log("startup_failed", {
    reason: /^[a-z_0-9]+$/.test(error.message) ? error.message : "configuration_or_connection_error",
  });
  process.exit(1);
}
