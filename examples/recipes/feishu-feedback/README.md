# 飞书群消息 → Codex 回答、建单与原群卡片

群内问题可由 Codex 直接回答，答案通过框架原生 notice FYI 回执显示为卡片；配置见
[AI 侧说明](ai/README.md)与[只发送回复通道](../../../plugins/feishu-replies/README.md)。

应用机器人只接收、保存和转发授权群的消息与附件。独立的 [AI 接收端](ai/README.md) 通过 Autoloop
调用 Codex 判断、查重和创建指定仓库的 Issue，成功后发送原群卡片。转发端没有模型、OpenClaw 或 GitHub 依赖。

本目录是完整业务场景，复用 [标准事件 API](../../../docs/protocol.md#来源把世界变成事件)
和内置 Codex 适配器；无需修改内核或安装新的插件加载器。两套独立包的 SDK 依赖
仅在本目录安装，框架根包保持零运行时依赖。

```sh
# 在仓库根目录安装并验证这套场景
npm ci
npm run feedback:install
npm run test:feedback
```

实际常驻安装已在 macOS 验证；Linux CI 验证离线行为，Windows 的真实业务服务尚未验收。
`ai/tools.mjs` 的 GitHub CLI 路径沿用原 macOS 部署，配置新机器时需核对。

## 运行

需要 Node.js >=22.13、官方飞书应用机器人，以及已经开通的新消息事件和只读权限。

```sh
npm --prefix examples/recipes/feishu-feedback ci
npm --prefix examples/recipes/feishu-feedback test
npm --prefix examples/recipes/feishu-feedback start -- --config /private/path/config.json
```

配置文件必须只有当前用户可读（`chmod 600`），放在 Git 外：

```json
{
  "appId": "cli_example",
  "appSecret": "YOUR_APP_SECRET",
  "chatIds": ["oc_authorized_group"],
  "stateDir": "/private/path/feishu-relay-state"
}
```

`chatIds` 为空时正常模式拒绝启动。配置 AI 入口前，授权群消息与附件仅缓存在
本机私有 SQLite 队列中；不调用任何 AI，也不向群发送消息。来源 ID 用于事件
去重；已确认接收的数据从队列正文中移除，不宣称磁盘物理擦除。

在首次确定群 ID 或设置长连接时，可使用 `--connect-only`。此模式只保存见到的
群 ID 到 stateDir 下的 `discovered-chats.json`；不保存消息正文、不下载附件，
不向外转发。只把新机器人加入已授权群，然后将对应 ID 加入 chatIds，再正常启动。

## 接入 AI

用户现已选择 Agent Autoloop + Codex。独立的 [AI 接收端](ai/README.md) 实现该接入，
只做反馈判断、Issue 查重及创建；不修改传输端的职责或依赖。

为 AI 侧配置一个接收消息的接口，再在私有配置添加：

```json
{
  "target": {
    "url": "https://your-ai-ingress.example/feishu",
    "token": "OPTIONAL_INGRESS_TOKEN"
  }
}
```

这是 AI 侧的消息接收接口，后端负责选择已配置的 AI 和管理其工具权限。
转发端向它 POST `petwins.feishu.message.v1` JSON，并传 `Idempotency-Key`。
接口处理成功后返回 `{"accepted":true,"deliveryId":"请求中的 deliveryId"}`。
AI 侧应按该 ID 幂等接收，并按 conversationId/rootId/threadId 维护上下文。
转发端不把一次 HTTP 成功当成 Issue 已创建。

数据含来源消息 ID、会话散列、话题、时间、原始结构、提取文本和附件。
附件以 MIME 类型、名称及 base64 字节传递，单资源上限 5 MiB、单消息最多 10 个。
缺失、无权限或过大的资源显式标为 unavailable；不执行文件或聊天中的指令。
请求与资源流有 30 秒时限；退出会取消在途 I/O，未完成下载保留待重启处理。
配置变更后需重启。转发和下载前再次检查当前白名单；已撤销群的待发项标为
withheld，保留但不自动转发。
聊天和附件都是 AI 侧需要按不可信资料处理的输入。

投递前记录 sending。对端未明确确认、连接中断或重启时，标成 uncertain，暂停
再次投递，避免重复触发 AI。需要对照 AI 侧接收记录确认后再恢复；未配置的
AI 接口需要按下文配置后才能启用建单。

运行状态可用相同命令加 `--status` 查看，只输出队列计数与不确定投递 ID。
对不确定投递，先停止服务并核对 AI 接收记录：已接收用
`--confirm-delivered <deliveryId>` 确认；确定未接收才用
`--retry-delivery <deliveryId>` 恢复同一 ID 的投递。操作命令会取得单实例锁，
避免与正在运行的转发进程同时修改状态。

当前目标群是外部群。个人版应用需要先完成本人实名认证，再在新版本中开启
“允许机器人被添加到外部群中使用”，发布后才能加群。认证由用户本人在飞书
手机端完成，具体流程见[飞书官方说明](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group?lang=zh-CN)。

关闭进程用 SIGTERM/SIGINT；服务会关闭官方 SDK 连接并释放单实例锁。日志只
记录连接、队列及投递状态，不打印正文、附件、凭据或接收地址。

## 来源、兼容与开发

本流程由 SIGMAREAL 从 `SIGMAREAL/PEtwinsMacOS` 的 `tools/feedback-bot/` 迁入，
来源提交为 `65a5555a74c5b63fcc23de59a2e50b0e9897f12c`；此前需求和真实运行证据见
[Petwins #258](https://github.com/SIGMAREAL/PEtwinsMacOS/issues/258)。本仓库是后续实现的维护入口，
Petwins 只保留迁移指引和历史证据。

保留 `petwins.feishu.message.v1`、`PETWINS_FEEDBACK_AI_CONFIG`、SQLite 布局及
`petwins-feedback` Issue 标记作为兼容约定，已有队列和已建 Issue 不需要重建。
包名与目录迁移不会改变群白名单、建单目标或模型权限；群内容由 AI 判断，不预设话题门槛。

私有配置、数据库、附件、CLI 登录和服务描述文件继续放在 Git 外。开发时使用临时状态
和模拟平台接口，不给已在线的应用额外启动一个长连接，也不自动发真实测试消息。
现有服务切换只更新冻结代码路径，沿用原配置与数据；见 [迁移计划](../../../docs/plans/2026-11-19-feishu-feedback-migration.md)。

在此 Fork 开发使用 `origin`，原作者仓库保留为 `upstream`。本机框架仍使用已验证的
上游 v1.9.3，业务脚本来自此 Fork 的冻结提交；框架升级单独验证。
代码沿用本仓库 [MIT 许可证](../../../LICENSE)。
