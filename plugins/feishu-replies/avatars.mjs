import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { run } from "./cli.mjs";
import { isAvatarUrl } from "./avatar-url.mjs";

const imageKey = (key) => typeof key === "string" && /^img_[\w-]+$/.test(key);
const LIMIT = 1024 * 1024,
  DAY = 24 * 3600_000;

export class Avatars {
  constructor({ stateDir, profile, scope, command, signal, log = () => {}, fetch = globalThis.fetch, now = Date.now }) {
    Object.assign(this, { stateDir, profile, scope, command, signal, log, fetch, now });
    this.pending = new Map();
  }
  resolve(url) {
    if (!isAvatarUrl(url)) return Promise.resolve(null);
    if (!this.pending.has(url))
      this.pending.set(
        url,
        this.load(url).catch(() => {
          this.log("GitHub avatar unavailable; keeping author name and link");
          return null;
        }),
      );
    return this.pending.get(url);
  }
  async load(url) {
    if (typeof this.stateDir !== "string" || !isAbsolute(this.stateDir))
      throw Error("private_avatar_directory_required");
    const dir = join(this.stateDir, "avatar-images");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || (process.platform !== "win32" && stat.mode & 0o077))
      throw Error("private_avatar_directory_required");
    const hash = createHash("sha256")
      .update(`${this.scope || this.profile}\0${this.profile}\0${url}`)
      .digest("hex");
    const file = join(dir, `${hash}.json`);
    try {
      const st = lstatSync(file);
      if (st.isFile() && st.size < 1024 && (process.platform === "win32" || !(st.mode & 0o077))) {
        const cached = JSON.parse(readFileSync(file, "utf8"));
        const age = this.now() - cached.savedAt;
        if (imageKey(cached.key) && age >= 0 && age < DAY) return cached.key;
      }
    } catch {}
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]);
    const response = await this.fetch(url, { signal, redirect: "error" });
    const type = response.headers.get("content-type")?.split(";")[0];
    if (
      !response.ok ||
      !["image/png", "image/jpeg"].includes(type) ||
      Number(response.headers.get("content-length")) > LIMIT
    ) {
      await response.body?.cancel();
      throw Error("invalid_avatar_response");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMIT) throw Error("avatar_too_large");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (
      !(type === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : bytes[0] === 255 && bytes[1] === 216)
    )
      throw Error("invalid_avatar_image");
    const stdout = await run(
      this.command,
      [
        "im",
        "images",
        "create",
        "--profile",
        this.profile,
        "--as",
        "bot",
        "--data",
        '{"image_type":"message"}',
        "--file",
        "image=-",
        "--json",
      ],
      bytes,
      this.signal,
      20_000,
    );
    const result = JSON.parse(stdout),
      key = result.data?.image_key;
    if (result.ok !== true || result.identity !== "bot" || !imageKey(key)) throw Error("avatar_upload_unconfirmed");
    const stage = join(dir, `${hash}.${randomUUID()}.tmp`);
    writeFileSync(stage, JSON.stringify({ key, savedAt: this.now() }), { mode: 0o600 });
    renameSync(stage, file);
    return key;
  }
}
