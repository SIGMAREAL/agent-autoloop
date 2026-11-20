import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ghRequest } from "./tools.mjs";

export class PullRequests {
  constructor({ repositoriesFile, github = ghRequest }) {
    if (!isAbsolute(repositoriesFile) || statSync(repositoriesFile).mode & 0o077)
      throw new Error("private_repository_list_required");
    const repositories = JSON.parse(readFileSync(repositoriesFile, "utf8"));
    if (
      !Array.isArray(repositories) ||
      !repositories.length ||
      repositories.length > 100 ||
      repositories.some(
        (r) => typeof r !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(r),
      )
    ) {
      throw new Error("invalid_repository_list");
    }
    this.repositories = [...new Set(repositories.map((r) => r.toLowerCase()))];
    this.github = github;
  }
  async list({ repository } = {}, signal = AbortSignal.timeout(120_000)) {
    const selected = repository === undefined ? this.repositories : [String(repository).toLowerCase()];
    if (selected.some((r) => !this.repositories.includes(r))) throw new Error("unauthorized_repository");
    const results = new Array(selected.length);
    let next = 0;
    const read = async (repo) => {
      const pullRequests = [];
      try {
        for (let page = 1; page <= 10; page++) {
          signal.throwIfAborted();
          const items = await this.github(
            "GET",
            `repos/${repo}/pulls`,
            {
              state: "open",
              sort: "created",
              direction: "desc",
              per_page: "100",
              page: String(page),
            },
            { signal, timeoutMs: 15_000 },
          );
          if (!Array.isArray(items)) throw new Error("github_invalid_response");
          for (const p of items) {
            if (!Number.isSafeInteger(p.number) || p.number < 1 || typeof p.title !== "string")
              throw new Error("github_invalid_response");
            pullRequests.push({
              number: p.number,
              title: p.title.slice(0, 300),
              author: String(p.user?.login || "unknown").slice(0, 100),
              avatarUrl:
                Number.isSafeInteger(p.user?.id) && p.user.id > 0
                  ? `https://avatars.githubusercontent.com/u/${p.user.id}?s=80&v=4`
                  : null,
              draft: Boolean(p.draft),
              url: `https://github.com/${repo}/pull/${p.number}`,
              createdAt: Number.isFinite(Date.parse(p.created_at)) ? new Date(p.created_at).toISOString() : null,
              updatedAt: Number.isFinite(Date.parse(p.updated_at)) ? new Date(p.updated_at).toISOString() : null,
            });
          }
          if (items.length < 100) return { repository: repo, pullRequests, complete: true };
        }
        return { repository: repo, pullRequests, complete: false, error: "page_limit_reached" };
      } catch {
        return { repository: repo, pullRequests, complete: false, error: "github_request_failed" };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, selected.length) }, async () => {
        while (next < selected.length) {
          const index = next++;
          results[index] = await read(selected[index]);
        }
      }),
    );
    return {
      queriedAt: new Date().toISOString(),
      complete: results.every((r) => r.complete),
      total: results.reduce((n, r) => n + r.pullRequests.length, 0),
      repositories: results,
    };
  }
}
