function parse(m) {
  try {
    return JSON.parse(m.content);
  } catch {
    return {};
  }
}
const RESOURCE_TIMEOUT_MS = 30_000;
export function createBoundedHttp(http, { timeoutMs = RESOURCE_TIMEOUT_MS, signal } = {}) {
  const wrapped = {
    request: (options) => http.request({ ...options, timeout: timeoutMs, signal }),
  };
  for (const method of ["get", "delete", "head", "options"]) {
    wrapped[method] = (url, options = {}) => wrapped.request({ ...options, url, method });
  }
  for (const method of ["post", "put", "patch"]) {
    wrapped[method] = (url, data, options = {}) => wrapped.request({ ...options, url, method, data });
  }
  return wrapped;
}
async function readResource(client, messageId, key, type, { timeoutMs, signal }) {
  signal?.throwIfAborted();
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: key },
    params: { type },
  });
  if (response.code && response.code !== 0) throw new Error("resource_permission_or_download_failed");
  let size = 0;
  const chunks = [];
  const stream = response.getReadableStream();
  if (signal?.aborted) {
    stream.destroy();
    signal.throwIfAborted();
  }
  const timer = setTimeout(() => stream.destroy(new Error("resource_timeout")), timeoutMs);
  const abort = () => stream.destroy(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) throw new Error("resource_too_large");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
  return Buffer.concat(chunks);
}
function mime(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return "image/gif";
  return "application/octet-stream";
}
export function createMediaReader(client, { timeoutMs = RESOURCE_TIMEOUT_MS, signal } = {}) {
  return async (m) => {
    const c = parse(m);
    const resources = [];
    if (m.message_type === "image") resources.push({ key: c.image_key, type: "image", name: "image" });
    else if (["file", "audio", "media", "video"].includes(m.message_type))
      resources.push({
        key: c.file_key,
        type: "file",
        name: c.file_name || "attachment",
      });
    else if (m.message_type === "post") {
      const walk = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.tag === "img" && node.image_key) resources.push({ key: node.image_key, type: "image", name: "image" });
        for (const child of Object.values(node)) if (typeof child === "object") walk(child);
      };
      walk(c);
    } else return [{ status: "unavailable", reason: "unsupported_message_resource" }];
    const files = [];
    for (const resource of resources.slice(0, 10)) {
      if (!resource.key) {
        files.push({ status: "unavailable", reason: "missing_resource_key" });
        continue;
      }
      try {
        const data = await readResource(client, m.message_id, resource.key, resource.type, { timeoutMs, signal });
        files.push({
          status: "available",
          name: String(resource.name).slice(0, 200),
          mimeType: mime(data),
          base64: data.toString("base64"),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        files.push({
          status: "unavailable",
          reason: ["resource_too_large", "resource_timeout"].includes(error.message)
            ? error.message
            : "permission_or_download_failed",
        });
      }
    }
    if (resources.length > 10) files.push({ status: "unavailable", reason: "resource_limit" });
    return files;
  };
}
export function createForwarder(target, { fetchImpl = fetch, signal } = {}) {
  if (!target?.url) return null;
  const url = new URL(target.url);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("https_required");
  if (url.username || url.password) throw new Error("target_credentials_must_use_header");
  return async (envelope) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": envelope.deliveryId,
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
      },
      body: JSON.stringify(envelope),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`target_http_${response.status}`);
    const receipt = await response.json();
    if (receipt?.accepted !== true || receipt.deliveryId !== envelope.deliveryId) throw new Error("invalid_receipt");
    return { accepted: true, deliveryId: receipt.deliveryId };
  };
}
