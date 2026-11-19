// Prevent incorrect resource bytes, unbounded downloads and false delivery acknowledgements.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createMediaReader, createForwarder, createBoundedHttp } from "../src/adapters.mjs";
test("downloads file bytes as data using the message resource API", async () => {
  let args;
  const media = createMediaReader({
    im: {
      messageResource: {
        get: async (a) => {
          args = a;
          return {
            getReadableStream: () => Readable.from([Buffer.from("fixture")]),
          };
        },
      },
    },
  });
  const [file] = await media({
    message_id: "m",
    message_type: "file",
    content: JSON.stringify({ file_key: "key", file_name: "steps.txt" }),
  });
  assert.equal(args.path.message_id, "m");
  assert.equal(args.params.type, "file");
  assert.equal(Buffer.from(file.base64, "base64").toString(), "fixture");
});
test("download has a strict byte limit", async () => {
  const media = createMediaReader({
    im: {
      messageResource: {
        get: async () => ({
          getReadableStream: () => Readable.from([Buffer.alloc(6 * 1024 * 1024)]),
        }),
      },
    },
  });
  const [file] = await media({
    message_id: "m",
    message_type: "image",
    content: '{"image_key":"key"}',
  });
  assert.equal(file.status, "unavailable");
  assert.equal(file.reason, "resource_too_large");
  assert.equal(file.base64, undefined);
});
test("forwarder is absent until configured; never chooses a model or provider", () => {
  assert.equal(createForwarder(), null);
  assert.throws(() => createForwarder({ url: "http://remote.example/inbox" }), /https_required/);
});
test("forwarder sends transport envelope and delivery key only, and requires explicit receipt", async () => {
  let request;
  const forward = createForwarder(
    { url: "https://ai.example/inbox", token: "private-test-token" },
    {
      fetchImpl: async (url, init) => {
        request = { url, init };
        return {
          ok: true,
          json: async () => ({ accepted: true, deliveryId: "fixture-id" }),
        };
      },
    },
  );
  assert.equal((await forward({ deliveryId: "fixture-id", message: { text: "fixture" } })).accepted, true);
  assert.equal(request.init.headers["Idempotency-Key"], "fixture-id");
  assert.equal(JSON.parse(request.init.body).model, undefined);
  const wrong = createForwarder(
    { url: "https://ai.example/inbox" },
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ accepted: true, deliveryId: "wrong-id" }),
      }),
    },
  );
  await assert.rejects(wrong({ deliveryId: "fixture-id" }), /invalid_receipt/);
});

test("one missing resource does not discard successfully downloaded images", async () => {
  const media = createMediaReader({
    im: {
      messageResource: {
        get: async ({ path }) => {
          if (path.file_key === "missing") throw new Error("forbidden");
          return {
            getReadableStream: () => Readable.from([Buffer.from("available")]),
          };
        },
      },
    },
  });
  const files = await media({
    message_id: "post",
    message_type: "post",
    content: JSON.stringify({
      content: [
        [
          { tag: "img", image_key: "good" },
          { tag: "img", image_key: "missing" },
        ],
      ],
    }),
  });
  assert.deepEqual(
    files.map((f) => f.status),
    ["available", "unavailable"],
  );
});

test("stalled resource streams hit an absolute deadline and are destroyed", { timeout: 1000 }, async () => {
  const stream = new Readable({ read() {} });
  const media = createMediaReader(
    {
      im: {
        messageResource: {
          get: async () => ({ getReadableStream: () => stream }),
        },
      },
    },
    { timeoutMs: 20 },
  );
  const [file] = await media({
    message_id: "m",
    message_type: "image",
    content: '{"image_key":"key"}',
  });
  assert.equal(file.status, "unavailable");
  assert.equal(file.reason, "resource_timeout");
  assert.equal(stream.destroyed, true);
});

test("SDK HTTP requests to a stalled server honor the configured timeout", { timeout: 2000 }, async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const http = createBoundedHttp(Lark.defaultHttpInstance, {
    timeoutMs: 30,
  });
  await assert.rejects(
    http.request({
      url: `http://127.0.0.1:${server.address().port}/stalled`,
      method: "GET",
      proxy: false,
    }),
    (e) => e.code === "ECONNABORTED",
  );
});
