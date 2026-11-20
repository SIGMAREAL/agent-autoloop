# 用卡片回答飞书群问题

复用框架原生 `notice` FYI 回执，把答案作为卡片正文发回授权群。配套接收和 Codex 规则在 [飞书反馈场景](../../examples/recipes/feishu-feedback/ai/README.md)。用户在群里继续追问，现有规则续接 Codex 会话。

这是只发送的通道，不创建事件监听。将本目录的固定版本复制或链接到 `~/.agent-autoloop/plugins/feishu-replies/`。仅依赖 Node 内置模块与现有 `lark-cli`，不增加 AI 工具或额外队列。

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

只接受已配置规则的 `notice`、`closed` 卡片，正文按 plain_text 展示。收件群由配置决定，消息正文和 AI 无法指定其他地址。内容经 stdin 交给官方 CLI，以 bot 身份发送，用中台卡片编号作为幂等键；送达、重试及预算使用中台原有机制，不承诺跨外部服务故障的绝对一次送达。

旧的建单回执 outbox 继续负责成功建单的固定卡片；普通问答使用这里的原生 FYI，避免把每个问题都变成 Issue。MCP 默认仍为原有六工具，配置仓库白名单后可多一个只读 PR 查询工具；代码、PR 写入、合并和发布权限不变。

查看 `agent-autoloop runs 飞书反馈建单`、`why <轮次>`。暂停规则会停止处理新消息；移除此通道配置并重启即可卸载。测试 `node --test tests/feishu-replies.test.ts` 使用临时中台和假 CLI，不操作在线消息或数据库。
