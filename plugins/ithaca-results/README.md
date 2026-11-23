# Ithaca 处理结果发到飞书

只为每个 Issue 的三种实际结果新发消息：已关闭、已补充、已创建 PR。仅完成评估但仍待人工、排队、读代码、执行检查、依赖等待和停驻不发新消息。第一次接入补发当前池中已有实际结果；已创建 PR 后的人工阻塞、关闭或合并更新原卡，保留原 PR 链接。

复用 `@agent-autoloop/feishu-a2ui` 的官方 A2UI Core、GitHub 展示单元、头像和飞书适配器。显示原 Issue、作者、结果、简短说明，以及实际 PR／补充评论链接。任务已排队不代表 PR 已创建；关闭／补充必须有执行收据，PR 必须有同仓库实际链接。AI 说明保留原文，不增加模型调用。

插件是一个命令 Agent 的入口，不改变中台协议或内核。通过已认证 SSH 读取执行机 SQLite 的一致只读快照，只导出结果资料；原始正文、评论、提示词和完整日志留在执行机。群和机器人身份从现有私有通知配置读取，消息资料不能指定收件人。不启动第二个飞书监听，不更改 Ithaca 授权、任务、会话、运行期限或并发。

## 安装

Node 24+，执行机支持 Node SQLite；现有 `lark-cli` bot profile 已在目标群。执行 `npm run ui:install` 安装插件各自锁定的依赖；部署完整 `plugins/ithaca-results`（包括 `node_modules`）到一个固定版本目录。消费者不在运行时相对查找其他安装目录。

把下列配置保存在仓库外，权限 0600。`destinationConfig` 使用原有 PR 通知配置，其中已有 `enabled`、`larkCommand`、`profile` 和 `chatId`；不复制或创建密钥。

```json
{
  "enabled": true,
  "source": "my-execution-host",
  "project": "example",
  "repositories": ["example/app", "example/backend"],
  "sourceCommand": [
    "/usr/bin/ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "existing-host",
    "/absolute/node --input-type=module"
  ],
  "databaseFile": "/absolute/private/issue-loop/pool.sqlite",
  "stateDir": "/absolute/private/ithaca-results",
  "destinationConfig": "/absolute/private/existing-pr-notify.json",
  "pollSeconds": 20,
  "timeZone": "America/Los_Angeles"
}
```

现有中台可增加一条可信命令规则，每分钟检查一次：

```json
{
  "agents": {
    "ithaca-results": {
      "name": "推送 Ithaca 处理结果",
      "worker": "existing-worker",
      "use": "command",
      "command": ["/absolute/node", "/fixed-release/plugins/ithaca-results/main.ts", "once", "/private/results.json"],
      "timeout": 15,
      "maxActive": 1
    }
  },
  "rules": [
    {
      "name": "Ithaca 结果通知",
      "when": { "cron": "* * * * *" },
      "to": "ithaca-results",
      "cwd": "/fixed-release",
      "group": "ithaca-results",
      "parallel": 1,
      "maxActive": 1,
      "tell": "never",
      "prompt": "检查并推送已确认的 Issue 结果"
    }
  ]
}
```

合并进原配置，保留其他规则。运行 `agent-autoloop check` 后热加载；不重启已有中台和消息监听。通知直接由固定 bot 发送，`tell: never` 避免中台再发一份命令执行报告。

```sh
node /fixed-release/plugins/ithaca-results/main.ts once /private/results.json
node /fixed-release/plugins/ithaca-results/main.ts status /private/results.json
```

`watch` 模式可独立运行；不要与定时规则同时部署。通知电脑休眠／断线期间不发送，恢复后补发最新结果。暂停该规则或将 `enabled` 设为 false 即可停止发送，不会停止 Ithaca。

## 送达与更新

私有 SQLite 保存结果摘要、稳定的原生幂等键和飞书 message_id。同一 Issue 没有新结果就静默；新结果更新原卡。先确认消息 ID，再同步完整内容，成功后才推进送达摘要；更新失败重试同一消息，不另发一条。原生发送幂等受飞书接口有效期限制，不宣称跨外部故障绝对一次。

首次发送前持久化尝试时间；发送回执一直未知时，只在飞书一小时幂等窗口内重试。55 分钟后保守挂起该条，核实原消息后再处理，不盲目再 POST。已知 message_id 的更新不受该发送窗口影响。PR 的人工阻塞、合并和关闭优先展示当前事实，保留原 PR 链接。

飞书消息卡片更新有 14 天窗口和 30 KB 限制。超过限制或失败时保留错误和收据供 `status` 核对，不伪装送达，也不影响业务开发。数据目录中的收据是去重依据，不能为重试删除。作者头像使用既有固定 GitHub CDN 校验和缓存。

## 验证

`node --test tests/ithaca-results.test.ts` 使用临时 SQLite、假外部命令，检查最终结果筛选、补发去重、失败重试、原卡更新与只读快照；A2UI 测试在 `plugins/feishu-replies/test`。不拿替身测试充当真实飞书发送或显示验收。真实接入按用户明确授权发送实际结果，再通过消息回读和飞书界面核对。
