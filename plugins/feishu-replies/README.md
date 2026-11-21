# 用卡片回答飞书群问题

复用框架原生 `notice` FYI 回执，把答案作为卡片正文发回授权群。配套接收和 Codex 规则在 [飞书反馈场景](../../examples/recipes/feishu-feedback/ai/README.md)。用户在群里继续追问，现有规则续接 Codex 会话。

这是只发送的通道，不创建事件监听。将本目录的固定版本复制或链接到 `~/.agent-autoloop/plugins/feishu-replies/`。中台保持零运行时依赖；本插件独立安装官方 `@a2ui/web_core@0.15.0`（Apache-2.0），不采用社区飞书渲染器。复制完整目录后执行 `npm ci --ignore-scripts`，不增加 AI 权限或额外队列。

私有 `config.json` 的通道选项引用原 AI 配置，沿用其中 `cardNotifications` 的程序、profile 和 relayConfig：

```json
{
  "channels": {
    "feishu-replies": { "use": "feishu-replies", "key": "CHANNEL_KEY", "config": "/private/existing-ai.json" }
  }
}
```

AI 配置需有 `rule`，并启用原有 `cardNotifications`；传输配置 `chatIds` 必须只有当前一个授权群。多个群时拒绝发送，不能猜测目的地。Windows 的 Node CLI 等多参数入口可在 `cardNotifications.command` 配置程序数组，优先于 `program`。

在 `rules.json` 登记此通道，反馈规则设置 `channels: ["feishu-replies"]`、`tell: "needed"`，并加载最新 `feedback-instructions.md`。保留原有 `defaultChannels` 和其他规则；`tell: "never"` 会抑制回答回执。运行 `agent-autoloop check`，空闲时 `service install` 加载新通道。

Codex 最后输出：

````text
已准备当前问题的回答。

```agent-autoloop
{"notice":[{"title":"回复","text":"这里是答案。","key":"该问题的deliveryId","fyi":true}]}
```
````

只接受已配置规则的 `notice`、`closed` 卡片。普通文字被封装为官方 A2UI Text surface，再以 plain_text 展示。收件群由配置决定，消息正文和 AI 无法指定其他地址。内容经 stdin 交给官方 CLI，以 bot 身份发送，用中台卡片编号作为幂等键；送达、重试及预算使用中台原有机制，不承诺跨外部服务故障的绝对一次送达。

建单回执 outbox 继续负责成功建单的卡片，并调用同一套 A2UI 展示；普通问答使用这里的原生 FYI，避免把每个问题都变成 Issue。MCP 默认仍为原有六工具，可分别配置只读 PR 查询、群内文档读取及本地多任务清单；代码、PR 写入、合并和发布权限不变。多任务的每个成功项沿用同一工单回执。

查看 `agent-autoloop runs 飞书反馈建单`、`why <轮次>`。暂停规则会停止处理新消息；移除此通道配置并重启即可卸载。测试 `node --test tests/feishu-replies.test.ts` 使用临时中台和假 CLI，不操作在线消息或数据库。

## 官方 A2UI 与飞书映射

使用 [A2UI 1.0](https://a2ui.org/concepts/sdks/) 的官方 Basic Catalog；`ui.mjs` 通过官方 MessageProcessor 校验协议和组件，再通过 NodeResolver 解析数据绑定，最后自行生成飞书 JSON 2.0。协议与绑定没有自行重写。

目前支持 Column、Row、Text、Divider、Button 和头像 Image；Button 仅支持官方 openUrl，目标限 GitHub Issue、PR、仓库 PR 列表及作者资料。拒绝其他组件和动作，不执行 HTML、脚本或回调，不增加监听。此为单次快照适配，尚未实现 A2UI 增量更新、表单或双向交互。

## 三个场景共用一套展示

`github-view.mjs` 是唯一的 GitHub 单条展示定义：`githubItem` 归一化资料，`githubView` 组合 A2UI 组件。`pullRequestNotice` 展示一个 PR，`pr-view.mjs` 只负责查询摘要、分页和组合多个相同 PR；`issueCreatedView` 复用同一套标题、作者头像与资料链接、状态、创建/更新时间和入口按钮。三处均调用 `ui.mjs` 中的官方 Core 与飞书适配器，不另写飞书卡片模板。

修改 `github-view.mjs` 的条目结构或 `ui.mjs` 的样式映射，三个场景一起生效。资料不夹带飞书组件；时间明确为上海时间，缺失值显示未知。查询每页 8 条，最多 10 页；超限列明展示数量和完整仓库入口，查询失败仓库单独标注。

这个目录也是私有本地包 `@agent-autoloop/feishu-a2ui`。消费者通过锁定的 `file:` 依赖安装，运行 `npm ci --ignore-scripts --install-links` 将包及官方 Core 安装到自己的 `node_modules`；复制消费者部署时携带此目录，无需运行时寻找旁边的插件。引擎仍然没有运行时依赖。

统一的是展示层。Issue 回执仍由原 outbox 冻结与发送，新 PR 与查询仍走各自原生 FYI 及既有发送键。已经冻结的旧 outbox 内容原样保留，不为换样式重发历史消息。

只读 `list_pull_requests` 在本次查询后生成 A2UI 数据文件，并返回 `uiCards`。Codex 将每项 title/text 原样用于 notice，key 使用问题 deliveryId 加分页序号。`text` 是 `a2ui:<SHA256>`，文件在私有 AI `stateDir/a2ui` 下，以 0600 保存；加载检查私有权限、文件类型、大小及内容哈希，不接受路径。卡片内容较长也无需扩大中台 text 限制。文件保留用于原生回执重试和审计，备份/清理时须保留仍可能重试的引用。

```sh
npm ci --ignore-scripts
npm test
```

仓库开发可运行 `npm run feedback:install` 后再跑快速测试；此命令同时安装两个插件与两个反馈包的固定依赖。共享源码变化后重新运行，以更新消费者内的副本。插件行为测试覆盖官方绑定校验、单 PR 与列表条目一致、Issue 链接/作者/时间、空态、分页、查询失败、非法动作、引用校验和真实通道的假 CLI 交付；不发送在线测试消息。

## GitHub 作者头像

三个场景校验 GitHub API 的 avatar_url 并保留用户 /u/、应用机器人 /in/ 路径，重建固定 CDN 地址，视图用官方 A2UI `Image`（`variant: avatar`）表示。发送适配器仅下载该固定来源的 80px PNG/JPEG，禁止重定向并限制大小/超时；以现有 bot 身份调用 `im images create`、`image_type: message` 上传，再用飞书 img 显示 40px 圆形头像。头像旁保留作者资料链接，不映射或猜测飞书成员身份。

复用原应用的 `im:resource` / `im:resource:upload` 权限和 CLI profile，不增加 AI 工具、群发送权限或事件监听。`stateDir/avatar-images` 下私有缓存按应用和 profile 隔离，一天后刷新；同张卡片重复作者只下载/上传一次。缓存只保留图片 key 和时间，图片字节通过 CLI 标准输入上传，不写入本地文件。下载/上传失败时仍发送名字和链接，不阻塞 PR 答案；下次卡片重新尝试。
