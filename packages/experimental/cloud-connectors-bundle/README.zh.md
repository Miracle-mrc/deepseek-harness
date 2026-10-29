---
description: "Desktop 随附 AWS 和 Supabase 云连接组合包，默认不登录账户。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-bundle

[English](README.md) | 中文

## 概述

这个可选配置层将 [AWS 与 Supabase 云连接](../cloud-connectors/README.zh.md)预装到 Desktop。两个连接初始都为**未连接**；必须由用户完成浏览器 OAuth 登录并确认 MCP 工具权限。工具仅在审核页面**默认全部勾选**；用户确认之前不会启用任何工具。

## 目录

- [使用本包](#use-this-package)
- [安全边界](#security-boundary)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

全新的 Desktop 配置默认启用此组合包。打开插件页面，选择 AWS 或 Supabase 后进行连接。已有自定义配置保持原样；可以通过插件管理器手动添加。

<a id="security-boundary"></a>
## 安全边界

本包不分发 OAuth 令牌、AWS IAM 策略、Supabase 项目权限或服务登录状态。每台设备需要单独授权；更多限制、撤销方式和 AWS 登录前提见[服务端集成文档](../cloud-connectors/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

通过[云连接插件](../cloud-connectors/README.zh.md)间接影响模型；该插件只注册显式批准的工具。

#### KV Cache 影响

组合包本身不添加模型上下文；启用工具可能通过所属插件改变后续请求的工具 schema 前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 安装组合包不会登录账户或从其他设备迁移凭据。

### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
