export const BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
const time = (iso) => {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "未知";
  return new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
};

export function pullRequestViews(result) {
  const items = result.repositories.flatMap((r) =>
    r.pullRequests.map((p) => ({
      title: `${r.repository} #${p.number} · ${p.title}`,
      url: p.url,
      author: `作者：${p.author}`,
      authorUrl: p.author.endsWith("[bot]")
        ? `https://github.com/apps/${p.author.slice(0, -5)}`
        : `https://github.com/${p.author}`,
      status: p.draft ? "草稿" : "待合并",
      dates: `创建：${time(p.createdAt)}\n更新：${time(p.updatedAt)} · 上海时间`,
    })),
  );
  const shown = items.slice(0, 80),
    pages = Math.max(1, Math.ceil(shown.length / 8));
  const failed = result.repositories.filter((r) => !r.complete).map((r) => r.repository);
  const coverage = failed.length ? `未完整核实：${failed.join("、")}` : `已核实 ${result.repositories.length} 个仓库`;
  const summary = `${coverage}\n查询：${time(result.queriedAt)} · 上海时间\n展示 ${shown.length} / ${items.length} 个 PR（含草稿）`;
  return Array.from({ length: pages }, (_, page) => {
    const dataModel = { summary, items: shown.slice(page * 8, page * 8 + 8) };
    const components = [],
      children = [];
    const add = (id, component, props) => {
      components.push({ id, component, ...props });
      return id;
    };
    const text = (id, value, variant = "body") => add(id, "Text", { text: value, variant });
    const link = (id, label, url) =>
      add(id, "Button", {
        child: text(`${id}_label`, label),
        variant: "borderless",
        action: { functionCall: { "@call": "openUrl", args: { url } } },
      });
    const path = (p) => ({ "@path": p });
    children.push(text("summary", path("/summary"), "caption"));
    if (!items.length)
      children.push(text("empty", result.complete ? "当前没有未合并 PR。" : "已核实范围暂无 PR；部分仓库查询不完整。"));
    dataModel.items.forEach((_, i) => {
      children.push(add(`divider_${i}`, "Divider", {}));
      children.push(link(`pr_${i}`, path(`/items/${i}/title`), path(`/items/${i}/url`)));
      const author = link(`author_${i}`, path(`/items/${i}/author`), path(`/items/${i}/authorUrl`));
      const status = text(`status_${i}`, path(`/items/${i}/status`), "caption");
      children.push(add(`meta_${i}`, "Row", { children: [author, status] }));
      children.push(text(`dates_${i}`, path(`/items/${i}/dates`), "caption"));
    });
    if (items.length > shown.length) {
      children.push(text("overflow", "清单超过 80 个，剩余 PR 请打开仓库完整列表。", "caption"));
      result.repositories
        .filter((r) => r.pullRequests.length)
        .forEach((r, i) => {
          children.push(link(`repo_${i}`, `${r.repository} · 全部 PR`, `https://github.com/${r.repository}/pulls`));
        });
    }
    components.unshift({ id: "root", component: "Column", children });
    return {
      title: `未合并 PR · ${items.length} 个${pages > 1 ? ` · ${page + 1}/${pages}` : ""}`,
      messages: [
        { version: "1.0", createSurface: { surfaceId: "pr_list", catalogId: BASIC_CATALOG, components, dataModel } },
      ],
    };
  });
}
