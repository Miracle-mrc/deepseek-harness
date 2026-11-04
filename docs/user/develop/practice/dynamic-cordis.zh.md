# 通过提示词配置持久化插件

[English](dynamic-cordis.md) | 中文

标准模式和创造模式提供 [Plugin Manager](../../../../packages/boot/plugin-manager/README.zh.md)；创造模式还提供只读[运行时检查](../../../../packages/extensions/tool-cordis/README.zh.md)。插件配置属于当前 profile，影响其会话，并在进程重启后保留。

## 连接 MCP 服务器

启动 Web profile 并选择创造模式。准备一个可访问且提供 `ping` 的 Streamable HTTP MCP 服务器，将其实际端点填入以下提示词：

> 将 `<endpoint>` 处的 MCP 服务器配置到当前 profile，命名为 `demo`。立即启用它的工具，然后调用它的 ping 工具并告诉我结果。

agent 编写纯配置组合包，在 patch 中插入 `@deepseek-ai/dsh-mcp-client`，再通过 `plugin_manager install_bundle` 安装。启用 HMR 时，工具会出现在同一个运行中的会话里。同时检查管理结果（`application: applied`）和成功的 `mcp__demo__ping` 调用。返回 `restart-required` 的已保存条目尚未激活；失败条目需要修复配置。

修改配置前先读取组合包 patch。使用 Plugin Manager 停用条目或移除组合包。可接受的配置及连接失败行为见 [MCP client 参考](../../../../packages/mcp/mcp-client/README.zh.md)。

## Save to My Fork

Creator 可用时，打开 **插件 → 添加插件 → Save to My Fork**。按 `owner/repository` 格式填写 GitHub 仓库，并选择 `master` 或 `main` 以外的目标分支。这些值只是导出标签：DSH 不验证仓库访问权限，也不创建分支、提交或推送。检查生成文件的路径和内容，确认人工审查要求，然后下载已捕获的 JSON 导出文件。修改目标后必须重新预览。

导出保留当前 profile 的有序组合包选择和 profile patch。支持的本地组合包包含源文件、Cordis patch 和文本资源；注册表依赖保留为包引用。这涵盖插件配置、自定义插件、MCP 定义以及以组合包实现的 UI 扩展。导出不包含凭据、会话、home 和调用覆盖层，也不包含临时动态 Cordis 实验。不支持或可疑的文件会阻止准备；修正后重试。保守的秘密检测无法确认任意源码可安全发布：暂存前逐一审查文件。

在 fork 的检出目录中，将下载文件写入一个新目录：

```sh
node scripts/prepare-creator-export.ts /path/to/download.json /path/to/new-customizations
```

提取器验证每个路径，并拒绝已经存在的目标目录，包括之前提取的目录。它不执行 Git 命令。将生成的源文件保存在 fork 的专用目录中。创建选定的分支，检查文件，再仅暂存这些文件并审查 `git diff --cached`。提交或推送前确认 Git remote 指向自己的 fork。身份验证失败需要在本地 Git/GitHub 配置中处理；导出本身不需要 GitHub token。

在另一台机器上恢复时，克隆 fork 并完成[源码检出环境准备](../../../development.zh.md#setup-tutorial)，包括构建。执行导出的插件前先审查源码。在各个导出的本地组合包目录中安装依赖并执行必要的构建脚本，再从 `profiles/saved` 安装 profile 依赖。通过常规 CLI 启动，并将导出目录作为 Harness home：

启动前，将 `DSH_HOME` 环境变量设为导出目录。POSIX shell 使用 `export DSH_HOME=/path/to/new-customizations`；PowerShell 使用 `$env:DSH_HOME="C:\path\to\new-customizations"`。

```sh
pnpm --dir /path/to/new-customizations/profiles/saved install
pnpm dsh --profile saved
```

保持 `profiles/saved` 和 `bundles` 的相对位置，以便解析本地依赖。每个恢复的安装都使用全新且私有的 Harness home；单独配置凭据，并通过现有流程重新连接 AWS、Supabase 和需要身份验证的 MCP 服务器。使用前确认预期的组合包和工具已加载。导出不传递授权或 Team 运行状态。

自动发现仓库、GitHub 授权、创建分支、提交、推送、拉取请求以及任意应用修改均留待后续阶段。Phase 1 仅准备源文件，供用户自行进行 Git 审查和发布。
