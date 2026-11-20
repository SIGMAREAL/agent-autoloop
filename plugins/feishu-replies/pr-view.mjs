import { githubItem, githubView, time } from "./github-view.mjs";
export { BASIC_CATALOG } from "./github-view.mjs";

export function pullRequestViews(result) {
  const items = result.repositories.flatMap((r) => r.pullRequests.map((p) => githubItem("pr", r.repository, p)));
  const shown = items.slice(0, 80),
    pages = Math.max(1, Math.ceil(shown.length / 8));
  const failed = result.repositories.filter((r) => !r.complete).map((r) => r.repository);
  const coverage = failed.length ? `未完整核实：${failed.join("、")}` : `已核实 ${result.repositories.length} 个仓库`;
  const summary = `${coverage}\n查询：${time(result.queriedAt)} · 上海时间\n展示 ${shown.length} / ${items.length} 个 PR（含草稿）`;
  return Array.from({ length: pages }, (_, page) => {
    return githubView({
      title: `未合并 PR · ${items.length} 个${pages > 1 ? ` · ${page + 1}/${pages}` : ""}`,
      summary,
      items: shown.slice(page * 8, page * 8 + 8),
      empty: result.complete ? "当前没有未合并 PR。" : "已核实范围暂无 PR；部分仓库查询不完整。",
      footer:
        items.length > shown.length
          ? {
              text: "清单超过 80 个，剩余 PR 请打开仓库完整列表。",
              links: result.repositories
                .filter((r) => r.pullRequests.length)
                .map((r) => ({
                  label: `${r.repository} · 全部 PR`,
                  url: `https://github.com/${r.repository}/pulls`,
                })),
            }
          : null,
    });
  });
}
