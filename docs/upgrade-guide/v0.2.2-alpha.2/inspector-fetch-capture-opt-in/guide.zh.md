---
kind: upgrade-guide
description: "开发者工具组合包不再自动采集 Host 请求。"
---

# Host fetch 采集需要显式启用

[English](guide.md) | 中文

## 变更

开发者工具组合包现在设置 `captureFetch: false`，Inspector 和「统计」视图保持启用。使用该组合包的 profile 不再记录 Host 请求头或请求体，除非自己的补丁显式启用采集。已有的显式覆盖配置保持不变。

## 迁移

1. 连接 AWS、Supabase 或任何真实账户时，请保持采集关闭。未经脱敏的采集可能包含访问 token 和刷新 token。
2. 若 profile 的 `cordis.patch.yml` 已为 `experimental-inspector` 设置 `captureFetch: true`，请删除该覆盖配置或改为 `false`。重启 Host，确认 Inspector 的 Network 面板不再显示新的 Host fetch 流量。
3. 仅在受控调试中使用可丢弃的测试凭据时启用采集。即使关闭采集，调试器仍允许执行本地代码；在共享或不受信任的机器上应关闭开发者工具。请参阅 [Inspector 安全限制](../../../../packages/experimental/inspector/README.zh.md#security)。
