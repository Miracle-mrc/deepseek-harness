---
description: "通过终端管理 AWS 与 Supabase 登录、连接状态、显式 MCP 工具权限及本地断开连接。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-cloud-connectors-cli

[English](README.md) | 中文

## 概述

在专用的 `cloud` profile 中启用此可选组合包，即可在终端中管理 AWS 与 Supabase 连接。它与使用同一 Harness 主目录的 Web 和 Desktop profile 共享授权及工具选择。它不启动模型或 agent（智能体），也不写入 Session 日志。登录和工具权限更改使用独立命令。

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

请先创建自定义 `cloud` profile 并启用安装中携带的组合包，无需下载或发布包：

```sh
dsh plugin --profile cloud enable --empty @deepseek-ai/dsh-experimental-cloud-connectors-cli
```

此完整应用声明 `dsh.bundle.standalone: true`，必须是 profile 中唯一选中的组合包，不能与 base、Web 或 Desktop 共用组合包栈。`--empty` 会在自定义 profile 不存在时初始化它，且不添加默认组合包；已有 profile 会被保留，并在写入前拒绝冲突的组合包选择。若 `cloud` 已选择其他组合包，请使用新的自定义 profile。普通 profile、主目录和 `--patch` 覆盖层仍然可用。通过标准启动器运行命令：

```sh
dsh cloud --help
dsh cloud login --help
dsh cloud login supabase
dsh cloud login aws --aws-profile dsh-cloud --aws-method login --region us-east-1
dsh cloud status
dsh cloud tools supabase
dsh cloud tools supabase --enable execute_sql,apply_migration
dsh cloud tools aws --all
dsh cloud tools aws --none
dsh cloud disconnect supabase
```

`login` 输出提供方的浏览器网址及公开验证码（若有），然后等待完成。AWS 默认使用命名配置文件 `dsh-cloud`、`login` 方式和 `us-east-1` MCP 区域。对于预先配置的 IAM Identity Center 配置文件，选择 `--aws-method sso`；选择 `--aws-method existing` 可复用当前配置文件凭据，无需浏览器登录。请在 Host 上安装最新 AWS CLI（命令行界面）v2；最低接受版本为 2.32.0，并且必须提供 MCP 令牌命令。[云连接参考](../cloud-connectors/README.zh.md#use-this-package)负责提供方前置条件与远程浏览器流程。

AWS `login` 请求私密浏览器响应时，请将其粘贴到隐藏的终端输入中。Supabase 可以自动完成 Host 回调；对于远程 Host 或 SSH 会话，请在提示时粘贴完整的失败回调网址。替换已保存的 AWS CLI 登录需要明确回答 yes 或 no。这些响应不应放入命令参数或 agent 对话。

需要非终端响应时，为 `login` 添加 `--secret-stdin`，并通过私密标准输入流逐行提供响应，每行以 LF 或 CRLF 结束。未指定此选项时，非终端 AWS 登录在需要私密响应或替换确认时会失败；Supabase 可以继续等待浏览器回调。CLI 不输出私密响应或提供方错误正文。请求响应时遇到输入结束、中断或输入失败，会取消并等待本次命令获准启动的尝试结束。浏览器回调完成后，终端命令无需额外按键即可退出。

不带选项的 `tools` 列出原始 MCP 工具名及启用状态。`--enable` 将选择替换为指定工具；`--all` 启用当前提供的全部工具；`--none` 禁用全部工具但保留登录。这些选项互斥。登录不会确认工具权限。每个已启用工具仍受提供方权限限制。

`status` 接受可选的 `aws` 或 `supabase` 参数。帮助命令不访问云服务；`status` 和 `tools` 在恢复已保存连接时可能访问提供方。`disconnect` 删除此 Harness 主目录中保存的授权，不会运行 `aws logout` 或撤销提供方凭据。需要隔离连接时，请通过启动器的标准 `DSH_HOME` 设置选择另一个主目录。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[组合包补丁](cordis.patch.yml)拥有完整终端应用：参数处理、凭据、授权、工具注册表及[共享云服务](../cloud-connectors/README.zh.md)。它不挂载模型、agent、Session 持久化或常驻应用服务。`restoreOnStart: false` 使帮助命令不依赖提供方 I/O；命令仅恢复所需提供方。

[参数解析器](src/args.ts)使用 `dsh-cmdline`；[命令执行器](src/run.ts)等待应用启动提交，再通过 `appExit` 请求退出。它在释放终端状态和进程监听器前等待所属取消操作结束。`pollIntervalMs` 设置等待登录期间的状态读取间隔，默认 500 毫秒；提供方请求时限由云服务负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [云连接](../cloud-connectors/README.zh.md)：身份验证、凭据存储、工具确认与提供方限制。
- [Web 与 Desktop 组合包](../cloud-connectors-bundle/README.zh.md)：通过插件页面使用同一连接。
- [命令行应用支持](../../boot/cmdline/README.zh.md)：profile 参数解析与关闭。

-----

<a id="model-experience"></a>
## 模型体验

### 终端连接命令

#### 模型看到的内容

此 profile 不启动模型。已保存工具权限会影响挂载 `cloudConnections` 且使用同一 Harness 主目录的 profile 之后发起的模型请求；这些影响由[云服务](../cloud-connectors/README.zh.md#model-experience)负责。

#### Token 影响

CLI 不添加模型 token。启用的云工具 schema 和结果会在使用它们的 profile 中消耗 token。

#### KV Cache 影响

CLI 不添加模型上下文。更改允许工具可能改变其他 profile 后续请求的工具 schema 前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

终端连接管理存在以下限制：

- 真实提供方登录、令牌刷新和云操作仍需账户用户手动验收。自动测试使用外部 mock，并覆盖私密输入与取消情况。
- Linux 已有无需密钥的构建后 CLI 验收覆盖。原生 macOS 与 Windows 上的 CLI、Web 和 Desktop 登录仍需手动验收；mock 流程无法验证这些平台的浏览器或账户行为。
- 浏览器位于另一台机器时，需要云服务的私密响应或手动回调支持；此 CLI 不创建公网回调中继。
- 本地凭据提供方无法防止以同一操作系统用户身份运行的其他进程读取凭据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
