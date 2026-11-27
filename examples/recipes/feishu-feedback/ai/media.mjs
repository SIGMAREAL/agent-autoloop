import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

export const mediaExtensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function run(program, args, { maxBytes = 1024 * 1024, timeoutMs = 120_000 } = {}) {
  if (!isAbsolute(program || "")) throw new Error("media_program_required");
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let chunks = [],
      size = 0,
      overflow = false;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => reject(new Error("media_command_failed")));
    child.once("close", (code) =>
      overflow ? reject(new Error("media_output_too_large")) : resolve({ code, output: Buffer.concat(chunks) }),
    );
  });
}

export async function readVideoFrames(inbox, { deliveryId, index, seconds }, { ffmpegProgram } = {}) {
  if (
    !Array.isArray(seconds) ||
    seconds.length < 1 ||
    seconds.length > 6 ||
    seconds.some((n) => !Number.isFinite(n) || n < 0 || n > 7200)
  )
    throw new Error("invalid_video_times");
  const item = inbox.get(deliveryId).envelope.attachments[index];
  if (!item?.mimeType?.startsWith("video/") || !mediaExtensions[item.mimeType])
    throw new Error("video_attachment_required");
  const bytes = inbox.readAttachment(deliveryId, index);
  const dir = await mkdtemp(join(tmpdir(), "feedback-video-"));
  try {
    const input = join(dir, "recording." + mediaExtensions[item.mimeType]);
    await writeFile(input, bytes, { mode: 0o600 });
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          sampledSeconds: seconds,
          coverage: "Sampled frames only; not continuous playback. No audio transcription.",
        }),
      },
    ];
    for (const second of seconds) {
      const r = await run(
        ffmpegProgram,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          String(second),
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=1280:1280:force_original_aspect_ratio=decrease",
          "-q:v",
          "3",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        { maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000 },
      );
      if (r.code !== 0 || r.output.length < 4 || r.output[0] !== 255 || r.output[1] !== 216)
        throw new Error("video_frame_unavailable");
      content.push(
        { type: "text", text: `Frame at ${second} seconds` },
        { type: "image", mimeType: "image/jpeg", data: r.output.toString("base64") },
      );
    }
    return { content };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkMediaProgram({ ghProgram } = {}) {
  const help = await run(ghProgram, ["issue", "create", "--help"]);
  if (help.code !== 0 || !help.output.toString("utf8").includes("--attach"))
    throw new Error("github_media_cli_upgrade_required");
}

export async function createMediaIssue({ repo, title, body, files }, { ghProgram } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "feedback-issue-"));
  try {
    const bodyFile = join(dir, "body.md");
    await writeFile(bodyFile, body, { mode: 0o600 });
    const args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile];
    for (const [i, file] of files.entries()) {
      const extension = mediaExtensions[file.mimeType];
      if (!extension) throw new Error("unsupported_issue_attachment");
      const path = join(dir, `evidence-${i + 1}.${extension}`);
      await writeFile(path, file.bytes, { mode: 0o600 });
      args.push("--attach", path);
    }
    const r = await run(ghProgram, args, { timeoutMs: 180_000 });
    // The official CLI prints the created URL even when only some uploads succeeded.
    // Preserve that receipt before reporting partial media; never retry creation.
    const url = r.output.toString("utf8").trim();
    const prefix = `https://github.com/${repo}/issues/`;
    const number = url.startsWith(prefix) ? Number(url.slice(prefix.length)) : NaN;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("issue_write_uncertain");
    return { number, attachmentsComplete: r.code === 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
