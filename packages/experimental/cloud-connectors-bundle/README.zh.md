---
description: "为 Web 与 Desktop profile 提供可选的 AWS 和 Supabase 连接、浏览器登录及显式 MCP 工具选择。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-bundle

[English](README.md) | 中文

## 概述

为 Web 或 Desktop 的插件页面添加 AWS 与 Supabase 连接卡片。全新的 Desktop profile 已包含此组合包；Web 和现有 Desktop profile 可显式添加。安装组合包不会登录任何提供方。[云连接插件](../cloud-connectors/README.zh.md)仅在完成提供方登录并显式确认工具后启用工具。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已提供凭据、授权、工具及 Web 插件页面的 profile 中使用此配置层。

### 在 profile 中启用

在 Web profile 中启用安装中携带的组合包：

```sh
dsh plugin --profile web enable @deepseek-ai/dsh-experimental-cloud-connectors-bundle
```

此命令保留已有 profile 配置层，并选中携带的组合包，无需从注册表下载。将 `web` 替换为目标 Web profile 名称。profile 和主目录补丁仍可覆盖插入的条目。HMR（热模块替换）关闭时，需要重启 profile 才能应用组装更改。

对于已发布的包版本，使用标准 profile 包命令：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-cloud-connectors-bundle
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-cloud-connectors-bundle
```

`add` 和 `remove` 会运行 pnpm；安装要求配置的注册表中存在所请求的包版本。未发布的 fork 无法通过此途径按包名安装。安装会添加依赖并激活其声明的组合包补丁。

全新的 Desktop profile 自动包含此组合包。现有 Desktop profile 会被保留：请通过 Desktop 插件管理器启用，或通过其[内置命令](../../../apps/desktop/README.zh.md#bundled-command-runtime)管理已发布包，因为 npm CLI（命令行界面）不能管理保留的 Desktop profile。

### 连接账户

打开插件页面，选择 AWS 或 Supabase。按[登录与工具确认说明](../cloud-connectors/README.zh.md#use-this-package)操作，包括 AWS CLI 前置条件与远程浏览器响应。审核页面初始勾选全部工具，但在确认之前不会注册任何工具。[终端命令](../cloud-connectors-cli/README.zh.md)可管理同一 Harness 主目录，无需启动 Web 或 Desktop。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[补丁文件](cordis.patch.yml)插入 `cloud-connectors` Host 条目。[所属插件](../cloud-connectors/README.zh.md)提供浏览器界面和服务行为；本包不添加凭据或授权策略。manifest（元数据清单）中的 `dsh.bundle.patch` 声明使其成为可安装的 profile 配置层。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [云连接](../cloud-connectors/README.zh.md)：身份验证、工具确认与安全限制。
- [云终端命令](../cloud-connectors-cli/README.zh.md)：专用连接管理 profile。
- [Profile 与组合包](../../../docs/architecture.zh.md)：配置层顺序与覆盖。

-----

<a id="model-experience"></a>
## 模型体验

通过[云连接插件](../cloud-connectors/README.zh.md#model-experience)间接影响模型；该插件负责获批 MCP 工具及其 schema。

#### KV Cache 影响

组合包本身不添加模型上下文。更改允许工具可能通过所属插件改变后续工具 schema 前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

启用存在以下限制：

- 安装或启用此配置层不会登录账户、授予提供方权限，也不会从其他 Harness 主目录迁移凭据。
- 组合包依赖 profile 的凭据、授权和工具服务。Headless 默认关闭交互式凭据服务；自定义组装必须显式启用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
