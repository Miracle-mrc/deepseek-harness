# Agent Note: Creator 发布权限分离

Status: proposed

[English](2026-11-08-creator-publication-privilege-separation.md) | 中文

## Problem

Creator 的逐文件检查和最终确认保护第一方 Client 工作流。它们不能向 Host 证明人工授权：owner Remote 调用者和受信任的进程内插件能够调用 `publish(id, true)`。能够读取 Host 可用 GitHub 凭据的不受信任进程也能绕过 CreatorFork 发布。

随附的[沙箱模式](../../../../packages/sandbox/sandbox/src/index.ts)控制文件操作效果。Linux profile 允许读取根文件系统，macOS 允许所限制文件写入以外的操作，Windows 明确不限制读取和网络。[文件系统 provider](../../../../packages/fs/fs-sandbox/README.zh.md)同样保留读取能力。因此，清理环境变量不能隔离凭据文件、helper、agent、钥匙串或已认证 IPC。单独增加同一用户下的进程并不构成隔离。

另一条路径利用持久化的浏览器会话签名记录。持有者能够签署绑定 authority 的浏览器 cookie；[Connection](../../../../packages/client/connection/src/rpc-host.ts)将该 cookie 接纳为 owner Peer。调用者可自行获得不可变源码 receipt 并声明确认，无须运行 Client controller。Host/Origin 检查和 cookie 签名仍按设计工作；它们不能区分本人和持有相同权限的进程。真实利用还需要可访问的 Host、可用 GitHub 账户及 fork；这些前提尚未通过真实账户验证。

现有[审批机制](../../implemented/feature/2026-07-06-approval-seam.zh.md)与 [Windows 文件写入策略](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)继续承担原有职责。本提案既不取代这些决定，也不声称它们现有的保证包括凭据隔离。[凭据快照与注册决定](../../implemented/architecture/2026-07-30-credential-boundaries-and-atomic-registration.zh.md)也继续有效；其延后的钥匙串 provider 本身不能提供此处要求的排除保证。

## Proposal

在 owner 批准独立的权限分离设计之前，不扩展 Phase 2 沙箱实现。保留本地下载和已明确说明的受信任 Host 发布工作流；继续将更强的隔离要求列为阻塞项。

最小可行设计将经过审查的发布 broker 及其 owner 确认通道置于所有不受信任模型能力的文件系统、进程、钥匙串、IPC、网络和 UI 自动化权限之外。远程执行环境或独立 OS 安全身份可以提供这种分离；普通的同用户 helper 不行。broker 只能通过 owner 授权的凭据迁移或受保护凭据中介复用现有 GitHub 登录，绝不能向 executor 返回可复用凭据。

### Trusted and untrusted code

broker、确认 renderer 和明确安装的 Host 插件属于受信任计算基础。模型生成的程序、Bash/pwsh/PTY 后代进程、PTC 程序及任意原生 MCP server 需要隔离的执行环境。模型文件系统和搜索工具也必须使用该环境的 provider。每项附加工具都需要经过审查的能力策略；仅更改 shell 执行仍会留下其他读取者和网络客户端。

模型可写的源码、配置、hook 和插件目录不能经由 HMR、依赖安装或后续执行，悄然成为 broker 或受信任 renderer 的代码。提升为受信任 Host 代码需要独立 owner 授权。若部署允许模型控制的 computer/browser 工具操作审批 UI，就不能声称这些控件能够证明人工确认。

### Receipt-bound authorization

broker 保留不可变源码字节和规范化 manifest，将内容摘要绑定到账户 ID、仓库和网络 ID、目标路径、branch、实际默认 branch、base/head OID、过期时间及 operation ID。受信任 owner 通道展示同一份保留的 receipt，并记录明确的逐文件审查和最终授权。调用者布尔值或 executor 可读的 token 均不充分。

发布在重新检查身份及 head 后，仅消费针对该 operation 的精确授权。并发调用合并；重试协调同一 operation 及已知远程效果，而不是重新生成批准或把重放当成另一次保存。源码、目标、账户或 receipt 改变时必须重新审查。持久化 journal 恢复必须保留 committed 和 unknown 效果，不得在普通日志中持久化凭据或源码。

### Required implementation changes

实现 broker 的凭据、receipt 和 journal 所有者及类型化最小权限协议；增加模型工具无法访问的 owner 确认传输；由该所有者处理源码捕获及 GitHub 修改。替换或约束所有模型执行和文件 provider、原始网络访问、browser/computer 自动化及原生扩展路径。阻止访问 owner cookie 和受信任可执行文件、配置路径，包括其他文件名、继承 handle、进程检查及钥匙串或 agent 端点。不支持的平台或缺少隔离时，必须拒绝更强模式。

Linux、macOS 和 Windows 需要各自的原生执行保证和对抗性证据。现有文件系统和子进程机制能够承载 provider，但随附 provider 和 SSH 组合不能建立完整的 Web/Desktop 保证。凭据迁移、远程 workspace 捕获、插件开发及 AWS/Supabase 集成需要明确兼容方案，不能依赖扩大环境权限。

## Alternatives considered

**清理环境变量或隐藏常见 gh 路径。** 文件凭据、可配置存储、helper、钥匙串、owner cookie 和继承通道仍是其他权限来源。名称黑名单不能建立所要求的排除保证。

**增加 nonce、复选框或通用 owner-RPC 审批。** 持有 owner 权限的进程能够提交相同输入或回答同一审批通道。只有独立受保护的 owner 通道才能提供所要求的授权。

**同用户 broker 加窄化 RPC API。** 这能减少误用，但无法阻止恶意 executor 通过文件、进程或 IPC 复用凭据。只有强制隔离层保护它之后才有效。

**存在发布凭据时禁用所有通用模型能力。** 独立审查的 allowlist 部署能够缩小受信任执行集合，但会移除正常 Creator 开发及工具行为。这不是对现有 profile 兼容的静默更改，UI 开关也不能撤销凭据或已运行的进程。

## Acceptance criteria

- 在 Linux、macOS 和 Windows 上，通过每个随附模型执行与文件系统路径运行虚假凭据对抗测试。必须拒绝 secret 读取、helper/钥匙串/IPC 复用、owner cookie 获取及 broker 之外的已认证写入。
- 拒绝伪造、过期、篡改或重放的授权；账户、receipt、源码和目标变更；未授权审批回复；以及模型驱动 UI 自动化的批准。包括正常授权发布和刻意无效的对照。
- 保留精确审查字节、默认 branch 和 fork 检查、head-CAS 冲突、幂等重试、超时或响应丢失恢复及部分效果报告。不承诺原子保护 GitHub 默认 branch 元数据。
- 验证重启恢复、生命周期清理，以及日志、导出数据、工具结果和错误均不携带 secret。运行完整相关回归和打包矩阵，不降低检查要求。
- 在安全设计实现后，完成[经人工授权的一次性 fork 验收](../../../../docs/cookbook/testing-creator-fork.zh.md)。fixture 成功不能关闭真实兼容性验证。

## Risks

这是尚未实现的重大安全架构更改。OS 账户、容器或远程 executor 增加部署、文件传输和打包成本。远程 owner 审批改变部署和离线行为；保留 UI 自动化时可能需要硬件证明用户在场。附加的类型化中介可能限制正常 Git、插件和云工作流。受信任但恶意的 Host 或插件代码、被攻破的 OS 管理员，以及 owner 主动提供给不受信任代码的凭据，均处于拟议保证之外，必须明确说明。

Phase 2 中没有任何测试建立了新的跨平台排除保证。保留安全阻塞项，并在实现前要求明确的架构决定。
