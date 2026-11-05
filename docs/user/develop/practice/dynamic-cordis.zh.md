# 通过提示词配置持久化插件

[English](dynamic-cordis.md) | 中文

标准模式和创造模式提供 [Plugin Manager](../../../../packages/boot/plugin-manager/README.zh.md)；创造模式还提供只读[运行时检查](../../../../packages/extensions/tool-cordis/README.zh.md)。插件配置属于当前 profile，影响其会话，并在进程重启后保留。

## 连接 MCP 服务器

启动 Web profile 并选择创造模式。准备一个可访问且提供 `ping` 的 Streamable HTTP MCP 服务器，将其实际端点填入以下提示词：

> 将 `<endpoint>` 处的 MCP 服务器配置到当前 profile，命名为 `demo`。立即启用它的工具，然后调用它的 ping 工具并告诉我结果。

agent 编写纯配置组合包，在 patch 中插入 `@deepseek-ai/dsh-mcp-client`，再通过 `plugin_manager install_bundle` 安装。启用 HMR 时，工具会出现在同一个运行中的会话里。同时检查管理结果（`application: applied`）和成功的 `mcp__demo__ping` 调用。返回 `restart-required` 的已保存条目尚未激活；失败条目需要修复配置。

修改配置前先读取组合包 patch。使用 Plugin Manager 停用条目或移除组合包。可接受的配置及连接失败行为见 [MCP client 参考](../../../../packages/mcp/mcp-client/README.zh.md)。

## Save to My Fork

Creator 可用时，打开 **插件 → 添加插件 → Save to My Fork**。本地源码下载仍无需连接 GitHub：填写目标标签、检查捕获的文件、确认审查后下载 JSON。要直接发布，选择**直接保存到 GitHub**，然后显式加载 Host 现有 GitHub 登录可访问的仓库。打开任一对话框都不会请求 GitHub。

选择显示的 GitHub 账号拥有且可写的 fork，并输入 `main`、`master` 和该 fork 实际默认分支以外的分支。配置的上游用于核实允许的 fork 网络，默认为 `deepseek-ai/deepseek-harness`；部署所有者可在 Plugin Manager 中设置 `fork.upstreamRepository`。检查精确的修改前后文本（包括转义空白字符）、`creator-exports/saved/` 下的每个目标路径、账号以及 PR 目标 `<selected-fork>:<default-branch>`。新分支从所选 fork 的实际默认分支开始；已有分支保留其历史。修改目标后需要重新预览并确认。仅在审查全部文件后确认**确认提交并打开 PR**。DSH 创建或更新该分支，并打开或复用指向同一 fork 中已审查默认分支的 PR，永不合并。

身份验证使用 Host 现有的 `gh` 凭据存储，不会将 token 复制到配置或导出文件。身份验证或仓库访问失败时，通过现有流程修复 Host 的 GitHub 登录或权限，再显式重试。账号变化、意外的 fork、分支头变化和不安全的目标路径会阻止发布。超时后分支可能已经提交：对话框说明结果未知还是已提交，重试会先核实同一回执对应的结果再继续。核实尚未完成时，不要启动第二次保存。未提交的预览默认 15 分钟后过期；Host 重启会丢弃内存中的回执，因此再次保存前应先检查 fork 分支和已有 PR。

如果匹配的 PR 已关闭或合并，请通过链接在 GitHub 上查看原请求；此次保存不会创建替代请求。你可以修改目标或预览新的保存，也可以手动重新打开原 PR 后再重试原请求。写入结果未知时，目标修改和新预览会保持锁定，直到完成核实。

导出保留当前 profile 的有序组合包选择和 profile patch。支持的本地组合包包含源文件、Cordis patch 和文本资源；注册表依赖保留为包引用。这涵盖插件配置、自定义插件、MCP 定义以及以组合包实现的 UI 扩展。导出不包含凭据、会话、home 和调用覆盖层，也不包含临时动态 Cordis 实验。不支持或可疑的文件会阻止准备；修正后重试。保守的秘密检测无法确认任意源码可安全发布：暂存前逐一审查文件。

在 fork 的检出目录中，将下载文件写入一个新目录：

```sh
node scripts/prepare-creator-export.ts /path/to/download.json /path/to/new-customizations
```

提取器验证每个路径，并拒绝已经存在的目标目录，包括之前提取的目录。它不执行 Git 命令。将生成的源文件保存在 fork 的专用目录中。创建选定的分支，检查文件，再仅暂存这些文件并审查 `git diff --cached`。提交或推送前确认 Git remote 指向自己的 fork。身份验证失败需要在本地 Git/GitHub 配置中处理；导出本身不需要 GitHub token。

在另一台机器上恢复时，克隆 fork 并完成[源码检出环境准备](../../../development.zh.md#setup-tutorial)，包括构建。导出的源码不可信。先在每个导出的本地组合包目录中运行 `pnpm install --ignore-scripts`，再禁用脚本安装 profile 依赖：

```sh
pnpm --dir /path/to/new-customizations/profiles/saved install --ignore-scripts
```

批准构建前，检查导出包及其已安装依赖中的生命周期脚本。在各个相关组合包或 profile 目录中，仅将已审查的依赖标识记录到 pnpm 的 `allowBuilds` 策略中；对于待批准的构建，可使用 `pnpm approve-builds`，批准操作可能立即执行脚本。同时审查包自身的安装钩子后，再显式运行 `pnpm rebuild` 和必要的插件构建命令。重建既可能执行已批准的依赖脚本，也可能执行项目生命周期脚本。首次禁用脚本安装并不能证明插件代码可安全执行。完成审查后，才通过常规 CLI 启动：

启动前，将 `DSH_HOME` 环境变量设为导出目录。POSIX shell 使用 `export DSH_HOME=/path/to/new-customizations`；PowerShell 使用 `$env:DSH_HOME="C:\path\to\new-customizations"`。

```sh
pnpm dsh --profile saved
```

保持 `profiles/saved` 和 `bundles` 的相对位置，以便解析本地依赖。每个恢复的安装都使用全新且私有的 Harness home；单独配置凭据，并通过现有流程重新连接 AWS、Supabase 和需要身份验证的 MCP 服务器。使用前确认预期的组合包和工具已加载。导出不传递授权或 Team 运行状态。

直接保存与本地下载使用相同的源码捕获及恢复布局。直接保存的副本以 `creator-exports/saved/` 作为导出的 Harness home。此流程不提供任意应用修改、凭据传输或自动合并。
