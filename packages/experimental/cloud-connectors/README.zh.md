---
description: "可选 AWS 与 Supabase MCP OAuth Host/客户端集成，提供显式的工具级权限确认。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cloud-connectors

[English](README.md) | 中文

## 概述

在插件页面提供两个独立的连接：**AWS** 和 **Supabase**。安装或启用此包后**不会**自动登录任何服务。每个连接初始均为**未连接**，用户必须在当前设备点击**连接**，完成浏览器登录并确认允许 agent（智能体）使用的 MCP 工具。

## 目录

- [使用本包](#use-this-package)
- [安全边界](#security-boundary)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

Desktop 首次创建的配置包含[云服务连接组合包](../cloud-connectors-bundle/README.zh.md)。进入**插件 → AWS** 或**插件 → Supabase**，点击**连接**并在浏览器中完成提供方登录。登录后将列出可用 MCP 工具；**默认勾选全部**。用户可取消不需要的工具，然后点击**启用选中的工具**。只有显式确认后，工具才会出现在 agent 的工具列表中。

凭据、授权码、刷新令牌及客户端注册信息只保存在本地 Host 的 Harness 凭据服务中，不进入组合包、源代码、界面响应或 Git 仓库。每台设备需要分别连接；使用同一 Harness 主目录的 profile 共享已保存的授权和工具选择。**断开此设备连接**会移除已保存的本地授权以及此 Host 中的工具，但不会撤销提供方的远程令牌；必要时须到提供方另行撤销。

每次工具调用获准执行前都会检查最新保存的登录授权和工具选择。另一 profile 断开连接、更换登录或移除权限后，后续调用将被阻止，但已经发送给提供方的操作无法撤回。Token 刷新通过共享凭据存储串行执行，避免多个 Host 分别轮换同一刷新 token。登录已被撤销或失效时，此 Host 会移除工具并要求重新连接；临时请求失败不会撤销工具授权。

提供方地址为固定值：AWS 托管 MCP 服务 `https://aws-mcp.<region>.api.aws/mcp`（选择受支持的区域），或官方 Supabase 服务 `https://mcp.supabase.com/mcp`。Host 将验证地址。连接使用 MCP OAuth 2.1 浏览器流程，并验证一次性本地回调的 state。

<a id="security-boundary"></a>
## 安全边界

- 勾选全部工具不会授予 AWS IAM 或 Supabase 账户权限；操作仍受提供方授权限制。Supabase 管理 SQL 可能具备数据库特权，应用层 RLS 不能替代对此访问的限制。
- 复选框允许或禁止整个工具。通用 AWS API 工具可在登录身份的权限范围内执行 IAM 操作。Supabase 的 `execute_sql` 可读写数据和修改 schema；仅禁用 `apply_migration` 不能禁止 schema 修改。
- 启用工具意味着 agent 可以使用它；对于可写操作，Harness 的工具审批策略仍可能要求进一步确认。请检查每项工具的描述。
- 认证失败或客户端注册未获批准时必须拒绝连接。禁止将密钥或凭据提交到 Git。
- 开发者工具默认关闭 Host fetch 采集。启用 `captureFetch` 会记录未经脱敏的 OAuth token 和请求；使用云凭据时不要启用。调试器仍允许执行本地代码，因此在共享或不受信任的机器上应关闭开发者工具。
- AWS 文档支持 localhost 重定向，但也将动态客户端注册限制为已批准的 agent。本地回调并不保证新客户端注册会被接受；若注册被拒绝，请联系 AWS 支持。浏览器 OAuth 要求用户的 IAM 身份具备 `signin:AuthorizeOAuth2Access` 和 `signin:CreateOAuth2Token` 权限，但不会增加 AWS 权限。本 fork 的真实注册流程尚未验证。
- OAuth 回调绑定 `127.0.0.1` 的随机本地端口。若浏览器与 Host 不在同一台机器上，初版尚不支持重定向桥接；目前面向本地 Desktop。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

[组合包补丁](../cloud-connectors-bundle/cordis.patch.yml)挂载 Host 服务，其浏览器部分添加独立的提供方卡片。Host 负责 OAuth 回调、凭据存储和选中工具的注册；浏览器仅接收状态、登录 URL 与工具描述。[端点目录](src/catalog.ts)向 Host 校验和本地化区域选择器提供同一组受支持的 AWS 区域。

公开 Remote 值定义在[连接类型](src/types.ts)中。`CloudConnectionView` 包含提供方标识、连接状态、可用工具名称与描述、选中工具名称及可选的脱敏错误。`CloudSignIn` 包含浏览器授权 URL。两者都不包含已存储的访问令牌、刷新令牌或客户端注册凭据。[MCP 子系统参考](../../../docs/subsystems/mcp.zh.md)维护生成的 `ctx.cloudConnections` 方法目录。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [凭据服务](../../credentials/credentials/README.zh.md)：本地凭据的管理责任。
- [AWS OAuth 访问](https://docs.aws.amazon.com/signin/latest/userguide/aws-mcp-server.html)：登录前提与提供方授权。
- [Supabase MCP](https://supabase.com/docs/guides/ai-tools/mcp)：可用能力与安全指导。

-----

<a id="model-experience"></a>
## 模型体验

### 已批准的云工具

#### 模型可见内容

确认前不注册云工具。确认后，选中的工具使用现有 `mcp__<provider>__<tool>` 命名空间及提供方返回的描述与 schema；不额外注册系统提示词。

#### Token 影响

启用的工具 schema 与返回结果通过现有 MCP 工具适配器占用 token；不保证固定的 token 开销。

#### KV Cache 影响

修改已批准的工具集合可能改变后续模型请求的工具 schema 前缀。本包不会改写历史消息。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 真实 AWS/Supabase 注册、登录和刷新需要实际账户，须由连接该账户的人手动验收。自动测试使用 mock 提供方响应，不使用真实凭据。
- 目前通过 Desktop 使用的 Web 插件页面操作。TypeScript 与 HTTP 回调实现与平台无关，但现有 Desktop 打包流程仅支持 macOS 和 Windows。原生 Linux 安装包及三平台浏览器登录验收仍未验证。
- 连接时读取工具列表；如服务端新增工具，需要重新连接并审核新的权限列表。
- 早期预览版凭据若缺少登录标识和已注册的重定向 URI，则不会恢复；重新连接账户即可创建经过校验的授权记录。
- 启动时会为已保存的登录重新发现可用工具，包括待确认的授权，但不会注册尚未确认的工具。恢复连接会等待 MCP 协商完成或 SDK 超时；登录过期后需要重新连接。
- MCP 客户端未声明支持表单或 URL elicitation。不能依赖提供方的破坏性 SQL 确认弹窗或 Edge Function 密钥输入对话框；本地工具审批策略与这些机制相互独立。

### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
