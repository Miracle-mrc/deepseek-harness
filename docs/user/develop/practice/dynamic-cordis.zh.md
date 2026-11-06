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

选择显示的 GitHub 账号拥有且可写的 fork，并输入 `main`、`master` 和该 fork 实际默认分支以外的分支。检查账号及 PR（Pull Request）目标 `<selected-fork>:<default-branch>`；显示的上游用于核实 fork 资格。预览覆盖最终 PR 的每个文件改动，以及 `creator-exports/saved/` 下的每个目标写入。**改动前**显示已审查的默认提交，**改动后**显示捕获的源码，**本次保存前的当前分支**显示写入将替换的不同分支文本。检查完整路径和精确文本，需要时打开转义空白字符。已有目标包含无关改动或不兼容历史时会被拒绝；[Host 发布参考](../../../../packages/boot/plugin-manager/README.zh.md#direct-github-publication)说明检查、受信任 Host 的权限、公开可见性、默认分支中的过期导出、签名及发布限制。

按路径搜索或逐页浏览列表，选中文件进行检查。对每个文件分别勾选**我已检查此文件是否含有私人信息**。**下一个未检查的文件**、搜索和翻页都不会批准文件；筛选不会改变待发布文件集合。**已检查文件：N/M**必须达到 M/M，才能启用单独的最终确认和**确认并打开 PR**。取消任一文件检查会清除最终授权；修改目标或获取新回执会重置全部检查。关闭并重新打开未提交的审查会保留逐文件检查结果，但清除最终授权。确认后将创建或复用已审查的提交及 PR，不会合并。如果 fork 为公开仓库，发布可能在 PR 合并前公开源码及可达历史；文件审查不涵盖历史提交内容。优先选择新分支，避免并发修改分支或默认分支设置，并在进行后续操作前于 GitHub 审查最终 PR。

检查时间较长时，可显式延长审查时间。Host 会重新核实同一份仍保留的回执及未变化的 GitHub 目标，再刷新配置的审查有效期，默认 15 分钟。已过期但尚未回收的回执仍可延长。精确文本、所选文件及逐文件检查结果保持不变；须再次进行最终授权。延长不会重新捕获本地文件或上传源码。正在提交或已尝试保存的操作保持原有重试流程。

身份验证使用 Host 现有的 `gh` 凭据存储。先恢复原先显示的账号及 fork 的访问权限，再显式重试同一保存。结果未知或仍待处理的已提交状态会保留已批准回执，并锁定新的保存；重试失败不会抹去已知提交。回执丢失时，请在 GitHub 检查原账号、fork、分支及 PR，手动完成后再开始其他保存。回执已回收或 Host 重启后，需要重新预览并完整检查，不会转移检查结果或自动批准。无法延长时，可使用本地下载离线检查并手动发布。

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
