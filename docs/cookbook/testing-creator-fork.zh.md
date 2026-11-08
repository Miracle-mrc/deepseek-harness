---
description: "通过 fixture 和明确授权的一次性 GitHub 目标验证 Creator fork 发布。"
---

# Cookbook: 测试 Creator fork 发布

[English](testing-creator-fork.md) | 中文

## Summary

本流程区分确定性 fixture 证据与真实 GitHub 验收。维护者先运行现有测试；随后由人工授权指定的一次性 fork，并通过正常 Creator UI 检查发布。本指南不授权任何真实目标。凭据隔离仍是未解决要求：当前 Host 接受调用者声明，持有 Host 凭据的工具可在 UI 之外发布。[权限分离提案](../../.agents/notes/proposed/architecture/2026-11-08-creator-publication-privilege-separation.zh.md)尚未实现。

## Table of Contents

- [1. 记录授权](#authorization)
- [2. 运行确定性 fixture](#fixtures)
- [3. 准备专用 Host 和基线](#baseline)
- [4. 只审查，不发布](#review)
- [5. 发布并更新批准的 branch](#publish)
- [6. 检查冲突和恢复](#recovery)
- [7. 检查认证、规则与签名](#policies)
- [8. 单独审查合并保障](#governance)
- [9. 记录结果](#result)
- [Dev Note](#dev-note)

-----

<a id="authorization"></a>
## 1. 记录授权

在决策 owner 批准本次受限试验的安全假设，或要求先完成权限分离之前，停止真实操作。专用账户本身不能修复隔离缺口。绝不能把本产品仓库或其 upstream 当作一次性写入目标。

记录操作者、专用账户、一次性 upstream 和个人 fork、数值 ID、允许的 branch 名称、公开 fixture 源码、允许的 Git 对象、ref 和 PR 写入、时间范围及清理负责人。故障注入和第二操作者变更需要单独授权。允许发布测试 PR 不代表允许创建仓库、更改策略或默认 branch、切换账户、删除 branch、force-push 或 merge。未经批准的操作保持未执行。

<a id="fixtures"></a>
## 2. 运行确定性 fixture

在已安装依赖的贡献者 checkout 中运行 Host 与 controller/component 测试：

```sh
pnpm exec vitest run packages/boot/plugin-manager/tests/creator-fork.spec.ts packages/boot/plugin-manager/tests/fork-github.spec.ts
pnpm exec vitest run packages/client/ui-agent-preset/tests/fork-publish.client.spec.tsx packages/client/ui-agent-preset/tests/fork-publish-store.client.spec.ts
```

准备当前完整构建以及 Chromium/WebKit 前提条件后，运行组合浏览器 fixture：

```sh
DSH_SNAPSHOT=replay pnpm run test:web:built apps/web/tests/creator-source-export.e2e.ts
```

这些测试模拟 GitHub，不能建立真实登录、签名、ruleset 兼容性或模型凭据隔离保证。[Host 测试](../../packages/boot/plugin-manager/tests/creator-fork.spec.ts)覆盖新建和已有 branch、实际默认名称、不可变 receipt、完整 PR diff、归属、竞态和响应丢失。[传输测试](../../packages/boot/plugin-manager/tests/fork-github.spec.ts)检查净化后的 API 和策略失败。[Client 测试](../../packages/client/ui-agent-preset/tests/fork-publish.client.spec.tsx)及浏览器 fixture 覆盖明确逐文件审查、隐私提示、延期和恢复。保留无效对照和质量阈值。

<a id="baseline"></a>
## 3. 准备专用 Host 和基线

在专用 profile 中仅使用一次性公开源码，并加入小型 Unicode/BOM/CRLF 样本。审查完整捕获文件集及任何保留的 branch 历史。通过受支持的命名 `dsh` profile 启动，使用操作者审查过的 patch，将 Plugin Manager 的 `fork.upstreamRepository` 指向已授权的一次性网络。记录 profile 和 patch；调用时 overlay 不会导出。使用正常 GitHub CLI 传输，不把凭据写入配置、源码或命令参数。

若登录准备已获授权，由人工通过[正常登录流程](https://cli.github.com/manual/gh_auth_login)准备 Host 现有 GitHub CLI 登录。产品没有浏览器 token 输入流程。绝不打印 token、设备码、已认证启动 URL 或原始 CLI 诊断。不要注销共享账户、暴露 token 存储或扩大 scope 来绕过拒绝。CLI 存储可能退回明文文件；成功登录不能证明隔离。

首次修改前，记录账户、仓库及网络身份、fork 实际默认名称和 OID、upstream 默认名称和 OID、目标不存在或 head 状态，以及适用规则和签名要求。选择不存在且唯一的 branch，排除 `main`、`master`、`HEAD` 和 fork 实际默认 branch。普通验收期间保持默认设置和双方默认 head 稳定。

<a id="review"></a>
## 4. 只审查，不发布

打开 **Plugins → Add plugin → Save to My Fork → Save directly to GitHub**。打开界面不能触发 GitHub 请求。明确加载仓库，核对显示的账户，仅选择已授权、归该账户所有且可写的 fork。若未出现，停止。预览只能读取：不得上传源码、创建 Git 对象、改变 ref 或创建 PR。

检查 PR 目标为所选 fork 的实际默认 branch。查看每个完整路径和精确 Before/After 值。Before 来自已审查的默认 commit；可选的 Current branch before this save 展示写入将替换的目标文本。必审文件集包括全部最终 PR 变更及仅恢复目标的写入。阅读公开源码和历史警告：预览不审查全部历史 commit 中的私人信息。

多文件场景下验证 0/M 和 1/M 不能启用最终确认。搜索、分页、选择和 Next unreviewed file 均不能勾选文件。逐个检查每份文件，再给出独立最终确认。取消某文件或编辑目标必须撤销最终授权；目标编辑要求完整重新审查。

对于长时间未提交的审查，关闭后重新打开并明确延期。保留同一 receipt、字节、选择和逐文件勾选；清除最终同意。延期仅执行重新验证读取。过期但仍保留的 receipt 可以延期；已回收或卸载的 receipt 需要新预览和完整审查。已尝试保存的操作使用既有恢复流程。这些 Client 行为不能证明任意 owner 调用者获得人工授权。

<a id="publish"></a>
## 5. 发布并更新批准的 branch

审查全部文件并给出最终同意后，仅确认一次。独立检查 GitHub：新非默认 branch 的 parent/tree 和精确 UTF-8 字节符合审查；唯一 PR 的 head/base 仓库均为已授权 fork，并指向已审查的实际默认 branch。保持未合并。对照基线核查默认名称、OID、upstream OID 和无关文件。PR 创建成功之前，源码就可能已经公开。

已有 branch 场景选择刚创建且 PR 仍打开的 branch，修改一份已有公开 fixture 文件，并对该纯导出后代 branch 重新预览。再次审查完整默认相对 diff 及所有目标写入，包括之前提交的导出文本。确认复用 PR；符合条件且结果已正确的 head 不需要空 commit。无关叶节点变更、behind/diverged 历史及额外保留导出文件必须阻止预览。不要自动删除或重写它们；[发布参考](../../packages/boot/plugin-manager/README.zh.md#direct-github-publication)说明何时需要人工 Git 发布。

<a id="recovery"></a>
## 6. 检查冲突和恢复

仅在第二操作者写入已单独授权时，于预览后移动已有目标，再确认旧 receipt。验证拒绝或协调保留该操作者的 head。对不存在目标，在预览与确认之间创建它，验证排他创建不会覆盖它。除非另行授权更改默认设置或 head，否则相关漂移仅在 fixture 中测试。head CAS 不保护默认元数据；假设默认设置稳定，并检查最终 PR。

按已批准的传输故障计划，在明确确认后中断响应。不要假设远程效果不存在。保留 Host/browser 状态，检查原 branch 和 PR，恢复同一账户访问，再重试同一保存。验证精确字节和目标、唯一挂接的保存 commit 及对应 PR，不重新捕获或产生重复 branch/PR 结果。响应丢失可能要求重复准备 REST 对象；不可达对象不等于重复挂接的保存。已知 commit 必须在后续失败后仍保持已知。

未解决效果必须继续锁定目标编辑和新保存。若单独授权的专用 Host 重启丢失 receipt，应检查原账户、fork、branch 和 PR，并在再次保存前人工完成；不得把旧审查标记转移到新 receipt。不要终止共享 Host 或 session 来制造该场景。清理需要独立授权。

<a id="policies"></a>
## 7. 检查认证、规则与签名

使用专用未认证或未授权 fixture，或另行授权的测试账户、策略。验证净化后的拒绝、保留的效果，以及不会自动扩大凭据或绕过保护。403/422 不能唯一诊断签名失败；应检查实际仓库规则。

分别测试新 ref 和已有 branch 发布。REST commit 准备不提供签名；GraphQL 签名仍有条件限制。检查实际验证状态及[签名要求](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-signed-commits)。不支持时停止，并使用批准的人工签名 Git 工作流。不得伪造签名或减弱规则。

报告没有 branch/PR 效果的失败并不证明没有上传源码：REST 准备可能留下不可达对象。记录 none/unknown/committed 效果，并在恢复前检查 GitHub。即使后续操作失败，公开历史和部分发布仍有隐私风险。

<a id="governance"></a>
## 8. 单独审查合并保障

读取当前默认 branch 摘要、活动及有效规则、正式批准和精确 head 检查。保护详情返回 403 表示不可访问，不是 404，也不能证明未保护。独立 agent review 和 Auto Review 不是提交到 GitHub 的批准。记录无法获取的元数据，不请求扩大 administration scope。

经 owner 批准后，可考虑针对现有默认 branch 的一条活动规则：最新 push 的独立批准、撤销过期批准、解决讨论、基于最新 base、禁止 force-push 和删除，以及不设宽泛的管理员或 App 绕过。保持 auto-merge 关闭。候选 PR 聚合 context 为 `all checks passed`、`windows checks passed` 和 `python checks passed`，并绑定已验证的 GitHub Actions 来源。取消 guard 可能跳过聚合检查；GitHub 可能接受跳过的必需 context。仅依赖聚合检查前，应验证取消行为，并选择稳定的必需子检查或另行批准的失败关闭判定设计。在此之前，人工要求最终 SHA 的每个相关 lane 实际成功。固定 check 来源不能让 PR 自行修改的 workflow 自动可信。

[触发器](../../.github/workflows/fork-preview.yml)仍按路径过滤时，不要全局要求 `preview / fork preview checks passed`。对触发打包的 PR，要求其最终 head 实际打包证据，包括受支持 Desktop 和原生平台。全局要求它需要另行批准始终报告结果的检查设计。GitHub 说明了[被过滤的必需检查](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks)；跳过的策略 job 不是已执行验收测试。

由 owner 检查已安装 upstream-sync App 的真实身份、branch、权限、模式和绕过设置。连接器自身的安装元数据不能证明其他 App 的配置。优先使用保留 fork commit、经过审查的侧 branch/PR 同步；直接默认 branch 写入与 PR-only 保护冲突。不得把宽泛或 PR-only 绕过描述为仍强制检查。任何同步变更均需单独批准。保持默认 branch 和 upstream 关系不变；不启用破坏性 reset 或强制同步。

不要把 merge queue 当作仅需 Settings 的更改：当前核心 workflow 需要为队列检查修改 trigger 和事件 guard。仅在检查普通 PR 与实际同步路径后应用已批准保障；随后重新读取活动规则及批准。本流程不授权任何 Settings 更改或 merge。

<a id="result"></a>
## 9. 记录结果

记录授权决定、精确测试 SHA/build/profile、专用账户与仓库和网络 ID、批准的 branch 和动作、基线和最终 OID、receipt 与明确同意、效果、精确字节比较、实际 PR 身份、规则与签名结果及 UTC 时间。使用无 secret 证据；绝不包含凭据、设备码、私人源码或已认证 URL。

所有未执行真实用例标记为 NOT RUN。fixture 结果不能关闭真实 API 兼容性或隔离阻塞项。任何验收决定都必须说明威胁模型和剩余限制。在单独独立 review 和 merge 决策之前保持 PR 打开。

<a id="dev-note"></a>
## Dev Note

None.
