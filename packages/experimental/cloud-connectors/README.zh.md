---
description: "为 Web、Desktop 和终端提供 AWS CLI 与 Supabase 浏览器登录、共享本地授权以及显式 MCP 工具确认。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-connectors

[English](README.md) | 中文

## 概述

在 Web、Desktop 或终端中连接 AWS 与 Supabase，再选择允许 agent（智能体）使用的 MCP 工具。AWS 使用 Harness Host 上的命名 AWS CLI（命令行界面）配置文件；Supabase 使用浏览器 OAuth。登录本身不会启用工具。使用同一 Harness 主目录的 profile 共享连接与工具选择。

## 目录

- [使用本包](#use-this-package)
- [安全边界](#security-boundary)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过[云连接组合包](../cloud-connectors-bundle/README.zh.md)使用 Web 或 Desktop 的插件页面，或运行专用的 [`dsh cloud` 命令](../cloud-connectors-cli/README.zh.md)。全新的 Desktop profile 包含该组合包；Web 和现有 Desktop profile 可自行启用。未保存授权时，本包不会登录任何提供方。

### 连接并选择工具

打开插件页面，找到 AWS 或 Supabase，然后选择**连接**。按下文完成对应提供方的登录步骤。工具发现完成后，检查工具列表：页面初始勾选全部工具，但在选择**启用选中的工具**之前不会注册任何工具。取消不需要的工具。之后可通过**更改工具权限**替换选择，也可以禁用全部工具而保留登录。

### AWS 前置条件与登录

在运行 Harness Host 的计算机上安装最新的 [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)。集成会拒绝低于 2.32.0 的版本，并要求提供 [`signin create-oauth2-token-with-iam` 命令](https://docs.aws.amazon.com/cli/latest/reference/signin/create-oauth2-token-with-iam.html)，因此较旧的 v2 版本仍可能需要更新。选择 AWS MCP 区域、CLI 配置文件和登录方式。默认配置文件为 `dsh-cloud`；使用专用配置文件可将此登录与其他 CLI 用途分开。

| 方式 | 行为 |
|---|---|
| `login` | 为命名配置文件运行 `aws login --remote`。打开显示的 AWS 网址，再将浏览器中的私密授权响应粘贴到专用输入框。替换已保存的 AWS 登录需要明确回答 yes 或 no。 |
| `sso` | 为已配置 IAM Identity Center 的配置文件运行 `aws sso login --use-device-code --no-browser`。在浏览器中输入公开验证码。 |
| `existing` | 复用命名配置文件中的现有凭据，不打开登录页面。 |

浏览器 `login` 需要 [AWS CLI 浏览器登录](https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html)要求的权限。所有方式都需要创建 MCP 令牌所需的 `signin:CreateOAuth2Token`，以及所请求操作需要的 AWS MCP 和 AWS API 权限。工具选择不会授予这些权限。登录或令牌创建失败时，请更新 CLI，并请 AWS 管理员检查该身份和配置文件。配置文件的底层凭据保存在 AWS 自己的文件中；Harness 保存 MCP 授权和工具选择。

### Supabase 登录

Supabase 连接固定的托管端点 `https://mcp.supabase.com/mcp`。[托管 MCP 流程](https://supabase.com/docs/guides/ai-tools/mcp)使用动态客户端注册、S256 PKCE 和 state 校验。此客户端请求 `client_secret_basic`；授权服务器动态返回客户端注册信息和密钥。无需配置共享应用密钥，也无需粘贴个人访问令牌。已保存的注册密钥、访问令牌和刷新令牌都留在 Host 上。

### 远程 Web 与 SSH 主机

浏览器可以运行在另一台计算机上。AWS `login` 使用上述私密浏览器响应；SSO 使用公开设备验证码。Supabase 通常返回 Host 上的一次性 `127.0.0.1` 回调。如果浏览器无法访问该回调，请从地址栏复制完整的失败回调网址，粘贴到**浏览器回调网址（可选）**。Host 会校验来源、路径和 state，仅接受一次，并在 OAuth 交换中保留 issuer。不要将授权响应或回调网址放入 agent 对话或命令参数。

终端通过隐藏输入读取私密响应；[`--secret-stdin`](../cloud-connectors-cli/README.zh.md#use-this-package)可显式启用非终端输入。取消登录只会停止本次尝试，不会断开其他调用方已保存的连接。如果取消后仍有已保存的登录但没有活动连接，卡片会提供**重试**；连接成功前云工具保持不可用，未确认的工具选择仍需明确批准。这些流程不提供公网回调中继。

### 凭据与断开连接

使用同一 Host 和 Harness 主目录的 profile 与浏览器标签页共享授权及工具选择。**断开此设备连接**或 `dsh cloud disconnect <provider>` 会删除该主目录保存的授权与选择。其他 profile 中的后续调用会重新检查授权，在断开、更换账户或移除权限后失败。已发送给提供方的操作无法撤回。断开不会运行 `aws logout`、删除 AWS CLI 配置文件或缓存，也不会撤销提供方令牌；这些操作需通过提供方另行处理。

Supabase 刷新会在令牌交换期间持有共享凭据存储锁，防止多个 Host 分别消费同一刷新令牌。AWS 通过命名 CLI 配置文件获取 MCP 令牌。登录无效或被撤销时，工具会被移除，并要求重新登录；临时故障不会丢弃工具授权。

### 自定义组装

本包以插件形式挂载；[组合包](../cloud-connectors-bundle/README.zh.md)负责 profile 安装。自定义组装必须提供 `credentials`、`authorization` 和 `tools`，再挂载本插件：

```yaml
- id: cloud-connectors
  name: '@deepseek-ai/dsh-experimental-cloud-connectors'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `awsProfile` | `dsh-cloud` | 调用方未指定时使用的命名 AWS CLI 配置文件。 |
| `awsMethod` | `login` | 调用方未指定时使用的 AWS 登录方式。 |
| `awsExecutable` | `aws` | Host 上受信任的 AWS CLI 可执行文件。 |
| `restoreOnStart` | `true` | 启动时重新发现已保存连接；专用 CLI profile 会关闭此项。 |

[配置目录](../../../docs/config-catalog.zh.md)提供完整字段和超时参考。Headless 默认关闭凭据与授权服务；自定义 agent profile 必须显式启用这些服务及本插件。

<a id="security-boundary"></a>
## 安全边界

这些控件选择整个 MCP 工具；每个工具的实际操作仍受提供方授权限制。

- 通用 AWS API 工具可执行所选身份允许的 IAM 操作。复选框不限制单项 AWS API 操作。
- Supabase `execute_sql` 可读写数据并修改 schema。禁用 `apply_migration` 不会禁止这些 schema 修改。管理 SQL 的权限可能超出应用 RLS；此连接使用账户范围的托管端点。
- Harness 审批策略与工具选择相互独立。启用工具不保证每次操作都有额外的提供方确认。
- 本地凭据存储无法防止以同一操作系统用户身份运行的其他进程读取凭据。授权时不要启用开发者工具的 `captureFetch`，因为它会记录未经脱敏的 OAuth 请求和令牌。调试器可以执行本地代码。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[Host 服务](src/index.ts)负责授权尝试、凭据协调、MCP 发现以及可撤销的工具注册。[Web 客户端](src/client/CloudConnectionCard.tsx)和[终端应用](../cloud-connectors-cli/README.zh.md)使用同一组操作。公开状态包含连接状态、工具描述、允许名称、安全错误类别以及尝试与提示标识，不包含已保存令牌或客户端密钥。私密响应仅返回给匹配且仍有效的提示。

[AWS CLI 适配器](src/aws-cli.ts)不经过 shell，使用固定参数列表运行命令并获取限定于 MCP 的 bearer 令牌。[Supabase OAuth 提供方](src/oauth-provider.ts)使用 SDK 发现、动态注册和刷新。[端点目录](src/catalog.ts)固定两个提供方网址及受支持的 AWS 区域，调用方不能替换端点。[MCP 子系统参考](../../../docs/subsystems/mcp.zh.md#ctxcloudconnections--cloudconnections)提供生成的服务方法参考。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [云连接组合包](../cloud-connectors-bundle/README.zh.md)：Web 与 Desktop 启用方式。
- [云终端命令](../cloud-connectors-cli/README.zh.md)：登录、状态、工具选择与断开连接。
- [本地凭据](../../credentials/credentials-local/README.zh.md)：存储所有权与同用户访问。
- [AWS CLI 登录](https://docs.aws.amazon.com/cli/latest/reference/login/index.html)与 [Supabase MCP](https://supabase.com/docs/guides/ai-tools/mcp)：提供方要求。

-----

<a id="model-experience"></a>
## 模型体验

### 已批准的云工具

#### 模型看到的内容

未经确认的连接不注册云工具。确认后，所选工具使用 `mcp__<provider>__<tool>` 命名空间及提供方提供的描述和 schema。本包不添加系统提示词，也不向模型发送授权响应、已保存令牌或注册密钥。

#### Token 影响

已启用工具的 schema 和返回结果通过现有 MCP 适配器消耗 token。本包不承诺固定 token 开销。

#### KV Cache 影响

更改允许工具集合可能改变后续请求的工具 schema 前缀。本包不会重写之前的消息。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

提供方与平台验收存在以下限制：

- 真实 AWS 与 Supabase 登录、注册、刷新和云操作仍未验证。连接真实账户的人负责手动验收；自动覆盖使用外部提供方 mock 和无需密钥的 Session 记录。
- Desktop 打包支持 macOS 和 Windows。原生 Linux Desktop 安装包及跨操作系统的真实浏览器登录并未通过 mock 流程得到验证。
- 新增工具需要重新连接，才能发现并审核更新后的列表。启动恢复可能等待 MCP 协商或超时，但不会启用未经确认的工具选择。
- 缺少所需登录标识或已注册回调的无效预览版凭据不会恢复；请重新连接以创建经过校验的授权。
- MCP 客户端未声明支持表单或 URL elicitation，不能假定提供方会显示破坏性 SQL 确认或 Edge Function 密钥对话框。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
