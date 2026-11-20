import { canonicalAvatarUrl } from "./avatar-url.mjs";

export const BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
export const time = (iso) => {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "未知";
  return new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
};

export function githubItem(kind, repository, item) {
  const author = item.author || "未知";
  const validAuthor = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(author);
  return {
    title: `${repository} #${item.number} · ${item.title}`,
    linkLabel: `#${item.number} · 查看 ${kind === "pr" ? "PR" : "Issue"}`,
    url: `https://github.com/${repository}/${kind === "pr" ? "pull" : "issues"}/${item.number}`,
    author: `作者：${author}`,
    authorUrl: !validAuthor
      ? null
      : author.endsWith("[bot]")
        ? `https://github.com/apps/${author.slice(0, -5)}`
        : `https://github.com/${author}`,
    avatarUrl: canonicalAvatarUrl(item.avatarUrl),
    status:
      item.state === "closed"
        ? item.mergedAt
          ? "已合并"
          : "已关闭"
        : kind === "issue"
          ? "待处理"
          : item.draft
            ? "草稿"
            : "待合并",
    dates: `创建：${time(item.createdAt)}\n更新：${time(item.updatedAt)} · 上海时间`,
  };
}

// One item definition serves both standalone notices and entries in a query list.
export function githubView({ title, items, summary, empty, footer }) {
  const dataModel = { items, ...(summary ? { summary } : {}) },
    components = [],
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
  if (summary) children.push(text("summary", path("/summary"), "caption"));
  if (!items.length && empty) children.push(text("empty", empty));
  items.forEach((item, i) => {
    if (i || summary) children.push(add(`divider_${i}`, "Divider", {}));
    const itemChildren = [
      text(`title_${i}`, path(`/items/${i}/title`)),
      link(`pr_${i}`, path(`/items/${i}/linkLabel`), path(`/items/${i}/url`)),
    ];
    const author = item.authorUrl
      ? link(`author_${i}`, path(`/items/${i}/author`), path(`/items/${i}/authorUrl`))
      : text(`author_${i}`, path(`/items/${i}/author`));
    const status = text(`status_${i}`, path(`/items/${i}/status`), "caption");
    const avatar = item.avatarUrl
      ? [
          add(`avatar_${i}`, "Image", {
            url: path(`/items/${i}/avatarUrl`),
            description: path(`/items/${i}/author`),
            variant: "avatar",
            fit: "cover",
          }),
        ]
      : [];
    itemChildren.push(add(`meta_${i}`, "Row", { children: [...avatar, author, status] }));
    itemChildren.push(text(`dates_${i}`, path(`/items/${i}/dates`), "caption"));
    children.push(add(`item_${i}`, "Column", { children: itemChildren }));
  });
  if (footer) {
    children.push(text("overflow", footer.text, "caption"));
    footer.links.forEach((r, i) => children.push(link(`repo_${i}`, r.label, r.url)));
  }
  components.unshift({ id: "root", component: "Column", children });
  return {
    title,
    messages: [
      {
        version: "1.0",
        createSurface: {
          surfaceId: "github",
          catalogId: BASIC_CATALOG,
          components,
          dataModel,
        },
      },
    ],
  };
}

export function pullRequestNotice(pr) {
  return githubView({ title: `新 PR · ${pr.repo} #${pr.number}`, items: [githubItem("pr", pr.repo, pr)] });
}

export function issueCreatedView(repository, issue) {
  return githubView({
    title: `已创建 Issue #${issue.number}`,
    items: [
      githubItem("issue", repository, {
        number: issue.number,
        title: Array.from(issue.title).slice(0, 200).join(""),
        author: issue.user?.login,
        avatarUrl: issue.user?.avatar_url,
        state: issue.state,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      }),
    ],
  });
}
