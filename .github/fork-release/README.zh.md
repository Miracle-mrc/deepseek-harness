---
description: "在 Miracle-mrc fork 中构建无签名的 Desktop 与 Python 预览版本，校验源码和本地 wheel 包，并准备 GitHub 预发布草稿。"
---

# Fork 预览版本发布

[English](README.md) | 中文

## 概要

Miracle-mrc fork 将无签名的 Windows x64、macOS Intel/Apple Silicon 安装包与 Python SDK 及五种原生运行时 wheel 包一起构建。相关 pull request 会运行打包冒烟检查。从 `master` 手动运行发布工作流时，它会重新构建已校验的候选 tag，并向此 fork 的预发布草稿上传十一个文件。

## 目录

- [范围与验证](#scope-and-verification)
- [Pull request 预览](#pull-request-previews)
- [候选版本源码](#candidate-sources)
- [准备预发布草稿](#prepare-a-draft-prerelease)
- [产物与恢复](#artifacts-and-recovery)
- [开发备注](#dev-note)

<a id="scope-and-verification"></a>
## 范围与验证

本参考文档仅适用于 `Miracle-mrc/deepseek-harness`。Fork 工作流使用 GitHub 托管的 runner，无需仓库发布密钥。它们不会向 npm 或 PyPI 发布包、上传到 COS，或调用上游 Desktop 发布流程。AWS 与 Supabase 部署不属于此发布路径。

Desktop 打包使用常规无签名打包命令，并传入 `--fork-preview`。预览身份将应用与标准 Desktop 发行版隔离，且预览版本不包含自动更新元数据和强制策略配置。安装包没有生产签名或 macOS 公证。Windows SmartScreen 与 macOS Gatekeeper 出现警告属于预期行为。

GitHub Actions 负责原生构建和已安装运行时的验证。本地工作流与辅助脚本测试校验源码规则、产物集合和失败处理；它们不能证明 Windows/macOS 安装行为或正式签名版本已经就绪。

<a id="pull-request-previews"></a>
## Pull request 预览

[打包冒烟工作流](../workflows/fork-preview.yml) 会针对其路径过滤器中列出的 Desktop、CLI、Python、原生代码、发布、构建工作流和依赖锁文件变更运行。无关文档和包源码编辑不会启动这八个原生打包目标。常规技术 CI 独立运行。

[共享构建器](../workflows/fork-preview-build.yml) 在公开的原生 runner 上生成以下安装包：

| 安装包 | Runner | 模式 |
|---|---|---|
| Windows x64 EXE | `windows-2025` | 无签名 |
| macOS Apple Silicon DMG | `macos-latest` | 无签名 |
| macOS Intel DMG | `macos-15-intel` | 无签名 |

现有的 [Python 原生构建器](../workflows/build-exe-for-python-sdk.yml) 以 `release: true` 和 `ci: false` 构建一个 SDK wheel 包及 Linux x64/ARM64、macOS ARM64/x64 和 Windows x64 运行时 wheel 包。不向构建器传入密钥。每个原生目标在准备 SDK 声明的外部依赖后，使用 `--no-index` 安装本地 SDK 和匹配的运行时 wheel 包。共享工作流还会在 Python 3.10 和 3.14 上运行已安装的 SDK，通过 Twine 与标准 wheel 校验器检查全部六个 wheel 包，并拒绝不完整的产物集合。

成功的 PR 运行将 `fork-preview-bundle` 保留七天。其清单记录实际校验的提交，候选 tag 为空。任何必需构建失败或跳过，都会阻止最终预览结论成功。

<a id="candidate-sources"></a>
## 候选版本源码

发布候选版本使用预先存在的 `fork-v<productVersion>-miracle.<N>` tag，其中 `<N>` 是正整数。产品版本取自该 tag 对应的根 `package.json`；Python wheel 版本保持标准的 PEP 440 写法。候选编号只改变 tag，不改变产品或 Python 包版本。

[源码校验器](../../scripts/fork-preview-release.py) 要求 tag 提交可从 fork 当前的 `master` 到达，并且唯一对应一个合入该分支的 PR。Tag 对应的源码树必须与该 PR 最终 head 的树相同。合并前先将 PR 与 master 同步，并取得成功的技术检查；若合并引入了不同内容，就无法通过此路径发布。

`ci.yml`、`ci-windows.yml` 和 `ci-python.yml` 最新的 `pull_request` 运行必须在该 PR 最终 head 上成功，并使用预期的工作流路径与仓库。`ci-master.yml` 最新的 push 运行也必须在 tag 对应的确切提交上成功。较新的失败或未完成尝试会阻止发布。当前发布 dispatch 和无关的可选检查不能作为源码验证证据。

候选 tag 按操作规则保持不可变。使用仓库 tag 保护来限制修改，并为新的候选版本分配新编号。工作流会比较远端与本地的 tag 对象，在构建前记录解析后的提交和 tag 对象，并在创建草稿前再次检查两者。任何已经拥有 release（包括草稿）的候选版本都会被拒绝。

<a id="prepare-a-draft-prerelease"></a>
## 准备预发布草稿

仓库操作员负责 tag 和 Actions 步骤；原生构建及 GitHub 发布需要真实的 Actions 运行，本地辅助脚本测试不会执行这些操作。

1. 合并包含 fork 预览支持的 PR，并确保最终受检的 PR head 已与 master 同步。等待其 master push 验证成功。
2. 按规定格式，在该已检查的 master 提交上创建新的候选 tag。保持 tag 指向的提交和 tag 对象不变。
3. 打开 **Actions → Fork draft release → Run workflow**，选择 `master` 分支，并在 `source_tag` 中填写候选 tag。选择其他工作流分支或仓库无法进入构建路径。
4. 等待源码校验、三个无签名 Desktop 构建、五个原生 Python 构建、Python 兼容性检查和产物校验完成。只有最后的发布 job 获得 `contents: write`。
5. 在决定是否发布前，检查此 fork 中生成的预发布草稿、清单、校验和及安装包行为。工作流将 release 保持为草稿，并标记为预发布。

<a id="artifacts-and-recovery"></a>
## 产物与恢复

草稿恰好上传三个安装包、六个 wheel 包、`manifest.json` 和 `SHA256SUMS`。安装包文件名包含 `miracle-preview`、产品版本、原生目标和 `unsigned`。Python wheel 文件名与发行包名称保持标准形式；从同一产物集合中安装候选 SDK 和匹配的运行时。

清单标识仓库、tag、提交、产品版本和 wheel 版本，并记录每个产物的大小及 SHA256。`SHA256SUMS` 覆盖九个二进制产物与清单。最后的 job 会下载已校验的产物集合，并在上传前重新检查其确切文件名、wheel 元数据、身份和哈希。

源码校验失败会在原生构建前停止。构建或兼容性检查失败会阻止产物发布；失败的 Desktop job 会将打包诊断保留七天。重跑前先解决缺失或失败的技术检查。源码树不一致时，需要一个重新同步且检查通过的 PR；移动现有候选 tag 不能作为恢复方式。

如果草稿已经存在，请检查并保留该候选版本，避免尝试覆盖。重新构建的发布版本使用新的候选编号。不同候选 tag 复用产品版本是有意设计，清单和校验和用于区分它们的字节内容。

<a id="dev-note"></a>
## 开发备注

无。
