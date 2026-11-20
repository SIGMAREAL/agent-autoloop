# Agent Autoloop + Codex 反馈分诊

此目录是独立的 AI 侧包。飞书传输端只向本机接口投递消息；AI 侧负责保存资料、
调用 Autoloop 和提供 GitHub 工具。传输端不导入此包，也不持有 GitHub 凭据。

允许回答群内问题、判断反馈、查询重复项和创建指定仓库的 Issue。答案放在原生 FYI
卡片中发回原群；成功建单继续发送固定工单回执。不安装自动修代码、提交、PR、合并、
发布规则。消息不按关键词或固定话题过滤，是否回答或建单交给 AI，见 `feedback-instructions.md`。

## 运行前提

- Node >=24；官方 Agent Autoloop v1.9.3，源码提交
  `dd4187a495bbd81ff5bc1c1e70de08ee11ed1fc9`。
- 已由用户登录的官方 Codex CLI；本次使用独立安装的 0.170.0，复用原登录，
  不读取或复制登录凭据，不修改原全局 CLI。
- 已登录且可查询/创建目标仓库 Issue 的 `gh`。
- `npm ci` 安装本包锁定的官方 MCP SDK；本包测试用 `npm test`。

私有配置放 Git 外，权限 0600，示例：

```json
{
  "stateDir": "/private/feedback-ai-state",
  "contextRoot": "/private/autoloop-home/worker",
  "allowedConversations": ["SHA256_OF_AUTHORIZED_CHAT_ID"],
  "repo": "owner/repository",
  "port": 3351,
  "hubUrl": "http://127.0.0.1:3350",
  "sourceToken": "AUTOLOOP_SOURCE_KEY",
  "token": "PRIVATE_INGRESS_TOKEN",
  "rule": "飞书反馈建单",
  "codexProgram": "/private/codex-install/node_modules/.bin/codex",
  "model": "MODEL_FROM_USER_CONFIGURATION",
  "effort": "high"
}
```

`sourceToken` 仅是本来源密钥，不是 Autoloop 的 owner 密钥。不要把 Autoloop 自带
的管理 MCP 配入反馈 Codex，否则 Agent 可能自行回答审批卡片。现有传输配置的
`target` 指向 `http://127.0.0.1:3351/feishu`，token 与这里一致。

```sh
node main.mjs --config /private/ai.json
```

接口固定监听 127.0.0.1，Bearer 鉴权；`Idempotency-Key` 必须等于 deliveryId。
成功回执只代表资料已持久接收，不代表 Issue 已创建。完整消息与附件字节在同一个
SQLite 事务中落盘后才应答；本地资源文件是可恢复缓存。向 Autoloop 投递时复用
同一 event.id。已接收但未路由的事件记录为 `routing_held`，不堵塞后续反馈。

## Autoloop 配置

在既有安装中使用独立反馈工作目录；`rules.json` 保留用户其他规则，新增反馈规则。
`sources` 必须登记该来源，配置里的来源密钥与它匹配。开启回答时，先按
[卡片回复通道说明](../../../../plugins/feishu-replies/README.md)安装只发送通道。

```json
{
  "agents": {
    "feedback": {
      "name": "Codex 反馈分诊",
      "worker": "YOUR_WORKER",
      "use": "codex",
      "program": "/private/feedback-codex-wrapper",
      "access": "read",
      "maxActive": 1,
      "timeout": 15
    }
  },
  "rules": [
    {
      "name": "飞书反馈建单",
      "when": { "source": "local", "types": ["feishu.feedback"] },
      "to": "feedback",
      "cwd": "/private/feedback-workspace",
      "prompt": "FULL_CONTENTS_OF_feedback-instructions.md",
      "resume": true,
      "maxActive": 1,
      "tell": "needed",
      "channels": ["feishu-replies"]
    }
  ],
  "channels": { "feishu-replies": { "name": "群问题回答" } }
}
```

专用 wrapper 设置 `PETWINS_FEEDBACK_AI_CONFIG`，再执行
`node /installed/path/ai/codex-wrapper.mjs "$@"`。它强制只读、忽略用户配置和执行
规则，仅配置反馈 MCP，禁用 shell、浏览器、其他应用/插件、记忆和子代理。
登录仍由 Codex 官方 CLI 自己读取。0.170.0 不允许 `--trust` 与
`--ignore-user-config` 同用；不要为消除该错误取消隔离。

在 Codex 0.170.0 中，`approval_policy=never` 不会自动允许 MCP 写入。wrapper 根据
用户对建单的明确授权，只给 create_issue、record_decision 配置逐工具
`approval_mode="approve"`，并固定 enabled_tools 白名单；不放开全部 MCP 工具，
不把写入伪装为只读。只读文件沙箱和 shell 禁用同时生效。
Codex 成功退出后还要核实本轮每条反馈已记录决策；缺失时向 Autoloop 报告失败，
保留原会话供重试，不以模型口头“处理完成”代替实际结果。

反馈 MCP 仅有：read_context、read_feedback、find_issues、read_issue、create_issue、
record_decision。没有任意路径、仓库或 API 参数。GitHub 工具仅允许创建 Issue，
必须先查询重复项；已记录决策的消息不能再次建单。不设测试词、机器人话题或
产品类别的硬门禁；具体内容是否值得记录由 AI 结合上下文判断。
已知敏感标识、联系方式和凭据格式不得进入 Issue 草稿。

## 建单后的原群卡片

用户授权后，在私有配置添加：

```json
{
  "cardNotifications": {
    "enabled": true,
    "program": "/private/bin/lark-cli",
    "profile": "EXISTING_APP_PROFILE",
    "relayConfig": "/private/existing-relay.json"
  }
}
```

应用须有 `im:message:send_as_bot`。发送复用官方 CLI 的现有应用 profile，身份
固定为 bot，目标由来源会话散列映射回现有白名单群。无需卡片交互回调、管理权限
或新的机器人。AI 没有任意发消息工具；确认新建的 Issue 生成固定工单卡片，包含
公开标题和指定仓库链接。普通问题、重复项说明或需要澄清的内容，由 AI 判断后用
原生 notice FYI 输出答案卡片，走独立 `feishu-replies` 通道；不机械逐条回复。

纯问答仍用 `ignored` 记录“无需建单”的分类，回答正文存中台卡片与回执日志。
已记录分类不重复创建 Issue；本轮当前问题需要回答时仍完成回复，避免重派丢答案。
原生回答卡片与下面的建单 outbox 分别由各自现成的持久机制交付，不增加第三套队列。

建单决策和回执 outbox 在同一个事务落盘。发送前冻结卡片内容并记录 sending，
使用稳定幂等键。成功保存消息编号；未知结果或发送中崩溃保留 uncertain，不自动
重发。明确的权限/参数拒绝记录 rejected，修复后操作员可显式重试：

```sh
node main.mjs --config /private/ai.json --retry-rejected-cards
```

此命令不会重试 uncertain/sent 项。outbox 上线前已经建好的 Issue，需要操作员
核实后调用 `Inbox.queueCard(feedbackId)` 一次补队；不会靠重复创建 Issue 发回执。
回执错误不阻塞新消息派发；Autoloop 暂时不可达也不阻塞已有 Issue 的回执。

## 运维与恢复

- `agent-autoloop status` / `runs 飞书反馈建单`：查看运行结果和等待状态。
- `GET /health` 使用同一 Bearer token，仅输出接收队列与卡片状态计数。
- `routing_held`：先用 Autoloop 核对事件及规则。暂停期间的事件由操作员决定是否
  `replay`；无匹配规则的事件先修正规则并按来源记录人工处理，不能靠重复同一 ID
  假装已路由。实际已有目标规则的 run 后，运行下面命令核实并解除本地 held：

```sh
node main.mjs --config /private/ai.json --reconcile-routing
```

- GitHub 创建前持久记录 creating。连接断开等未知结果变成 uncertain；再次调用
  只查询最近 Issue 的稳定标记，查不到就继续保留不确定状态，绝不盲目重复创建。
- 本机资源缓存缺失/损坏时，从 SQLite BLOB 校验并恢复。备份必须保留数据库及
  WAL；运行中备份应通过 SQLite backup，而非单独复制正在写入的主文件。
- 安装使用 Autoloop 自带 `service install`，另用本账号 launchd 服务启动此接收端
  和原飞书传输端。三者状态分别检查；登录服务不等于电脑休眠时仍能接收。

真实飞书群图片/文件、真实新反馈建单、模拟写入错误和进程恢复分别记录验收，
不以本地合成测试代替真实链路证据。不为验证创建用户未授权的公开测试 Issue。
