# GitHub PR 群通知 Implementation Plan

> Execute task by task in this worktree; use test-driven-development and requesting-code-review.

**Goal:** 已授权仓库有新 PR 时，由现有飞书应用机器人向指定群发一张卡片。

**Architecture:** 使用标准 `plugins/github-pr-notify/{agent,channel}.ts` 接口。定时命令读取 GitHub，稳定事件编号交给中台；另一条命令规则产生 FYI 回执，由只发送的通道发群卡片。队列、并发、重派、卡片状态沿用中台；不增加飞书监听，不经过 AI。

**Tech Stack:** Node 24+ 内置 API、已有 gh 和 lark-cli 登录、现有中台 HTTP 协议。

## 约定与选择

- 每分钟轮询；相较 Webhook 无需公网入口，相较模型定时任务不消耗模型 token。
- 首次成功读取每个仓库只建基线；后续新建 PR 包括草稿、轮询间已关闭的 PR。重新打开、推送和评论不再通知。
- 分页读完新增范围，再按 PR 编号递增投递。中台确认事件已持久化后才推进游标；重试沿用事件编号。
- 仓库清单、群 ID、CLI profile、来源密钥和游标只放本机私有配置，不提交真实业务清单。
- 卡片文字作为 plain_text，链接由已验证的仓库名与 PR 编号构造。通知通道只接受本插件的 FYI 资料。
- 中台默认通道保留为本机文件；仅 PR 通知规则明确路由到群，避免把内部告警和其他资料发到群。
- 现有飞书反馈接收、Codex 建单、会话接续和工单回执保持原配置。
- 仓库范围是显式清单；新增关联仓库后编辑清单，该仓库首次读取仍只建基线。

## Task 1: Poller and durable handoff

Create `tests/github-pr-notify.test.ts`, `plugins/github-pr-notify/core.ts`, `main.ts`, `agent.ts`.

1. 写首次基线、新 PR、分页失败、确认丢失、部分成功、恶意资料的行为测试。
2. `node --test tests/github-pr-notify.test.ts`，确认功能缺失导致失败。
3. 实现私有原子游标、只读 GitHub 请求、稳定事件和严格确认校验。标准 Agent 只启动可信参数，不插值事件文字。
4. 重跑测试，确认通过。

## Task 2: FYI receipt and send-only channel

Create `plugins/github-pr-notify/channel.ts`; extend the same test file.

1. 写可信来源、仓库白名单、plain_text、固定 URL、假 CLI 发送、稳定幂等键、已发送 ref 不重发的失败测试。
2. 跑到失败，再实现从 context 产生 FYI 回执及发卡片、上报 delivered/failed。
3. 在临时目录单独复制插件，验证无需仓库内相对导入；用类型赋值对照现有 Adapter/ChannelContext。

## Task 3: Documentation and validation

Create `plugins/github-pr-notify/README.md`; update plugin index only where needed.

1. 文档给出虚构配置、两条规则、本机默认通道、安装、查看、暂停/恢复、卸载与边界。
2. `npm run test:quick`、`npm run typecheck`、`npm run format:check`，以及现有反馈的 44 项测试。
3. 不改内核/协议/模拟，因此无需本地 20 万步模拟。PR 最终提交核对三系统 check；独立 Agent 审查并修正必须修的问题。

## Task 4: Live installation and acceptance

1. 冻结已提交代码，安装标准插件；新增内部来源/通道密钥写入 0600 私有配置。
2. 为授权清单建立基线后才启用规则。只重启空闲的中台，保留现有 SDK 监听与 AI 服务。
3. 用本功能的真实 PR 验收一次群通知，并读回原群消息 ID、卡片标题与链接；不制造额外测试 PR。
4. 核对反馈服务与原队列不受影响，记录安装提交、真机环境、CI 与审查结果。

## Deferred

会话轮换、自动发现新仓库、PR 修改/合并通知、卡片审批、自动修代码均不在本批。
