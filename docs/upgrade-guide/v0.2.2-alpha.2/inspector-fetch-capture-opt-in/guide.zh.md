---
kind: upgrade-guide
description: "Inspector 插件、库 API 和开发者工具组合包均默认关闭 Host fetch 采集。"
---

# Host fetch 采集需要显式启用

[English](guide.md) | 中文

## 变更

Inspector 插件、库 API 和开发者工具组合包现在均将 `captureFetch` 默认为 `false`。Inspector 和「统计」视图仍然可用，但不再自动记录 Host 请求 headers 和请求体。仅修改端口的配置覆盖也保持采集关闭。已有的显式 `captureFetch: true` 覆盖保持不变。

## 迁移

1. 使用真实账户凭据时保持采集关闭。未经脱敏的采集可能包含访问令牌、Cookie 以及请求体或响应体。
2. 如果 profile 的 `cordis.patch.yml`、home patch 或 overlay 在 `experimental-inspector` 上设置了 `captureFetch: true`，请移除该字段或将其设为 `false`。直接调用插件或库的代码也应省略该字段或将其设为 `false`。重启 Host，确认 Inspector 的 Network 面板中不再出现新的 Host fetch 流量。
3. 仅在使用一次性测试凭据进行受控调试时显式设置 `captureFetch: true`，完成后移除该设置。即使关闭采集，调试器仍允许执行本地代码，因此请在共用或不可信机器上停用开发者工具。请参阅 [Inspector 安全限制](../../../../packages/experimental/inspector/README.zh.md#security)。
