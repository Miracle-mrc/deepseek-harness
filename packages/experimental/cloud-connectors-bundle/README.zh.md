---
description: "Desktop 随附 AWS 和 Supabase 云连接组合包，默认不登录账户。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-bundle

[English](README.md) | 中文

## 概述

这个可选配置层将 [AWS 与 Supabase 云连接](../cloud-connectors/README.zh.md)预装到 Desktop。两个连接初始都为**未连接**；必须由用户完成浏览器 OAuth 登录并确认 MCP 工具权限。工具仅在审核页面**默认全部勾选**；用户确认之前不会启用任何工具。

## 使用本包

全新的 Desktop 配置默认启用此组合包。打开插件页面，选择 AWS 或 Supabase 后进行连接。已有自定义配置保持原样；可以通过插件管理器手动添加。

## 安全边界

本包不分发 OAuth 令牌、AWS IAM 策略、Supabase 项目权限或服务登录状态。每台设备需要单独授权；更多限制、撤销方式和 AWS 客户端注册前提见[服务端集成文档](../cloud-connectors/README.zh.md)。

## 模型体验

用户在登录后显式确认工具列表之前，模型不会获得任何工具。
