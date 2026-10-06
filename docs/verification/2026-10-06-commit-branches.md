# 第二、三批：普通提交与本地分支

日期：2026-10-06。按已批准的顺序补齐普通提交、创建本地分支和独立切换分支；本次用户同时授权完成后上传代码。暂存与只读功能继续保留。

## 实现与实际语义

- “当前改动”新增提交入口；顶部当前分支名称打开创建/切换表单。侧栏引用仍只筛选历史。表单草稿在普通刷新后保留，切仓库时清空，成功提交后清空说明。
- 普通提交仅使用已暂存内容，支持首次提交。固定调用 `git commit --file=- --cleanup=verbatim --no-status`，说明走 stdin，不接受任意选项；无自动暂存、amend、空提交、推送或身份配置修改。
- 创建分支绑定预览时 HEAD，使用 `update-ref --no-deref --create-reflog` 的原子 create 操作，已有引用不覆盖且不顺便切换。切换固定调用 `switch --no-guess --no-recurse-submodules --no-overwrite-ignore -- <branch>`，只允许现有本地分支及干净工作区，不自动 stash，不覆盖忽略文件。
- 正常运行 hooks 和已配置签名程序。每次确认明确授权，服务端也检查授权标志；没有偷偷关闭原有检查。hook 改 index 后展示实际提交 OID、parents/tree、实际文件列表以及“与预览不同”；post-checkout 失败但 HEAD 已切换时如实报告已切换及诊断。
- contracts 用判别类型描述具体输入；共享 operations 协调器管理预览、队列、持久回执。repository-state 负责前提与目标检查，repository-runner 只执行三个固定命令，repository writer 负责实际结果核实。界面不拼命令，HTTP/stdio 的只读权限保持独立。
- 执行前核对 HEAD/index、配置、hook 内容、概览及目标分支，再写入持久意图；随后再次重验才启动命令。同 commonGitDir 写入串行，共享应用数据目录内另有 commonGitDir/worktree 锁。写入期间失效所有关联 worktree 的会话读取，包括此时新建的会话。
- 提交以唯一 reflog 标记和 parent 关系找回实际 OID，不仅凭退出码或当前 HEAD 猜测成功。命令临时启用 reflog，不修改仓库配置。意图与最终结果均持久化，同一操作 ID 不重发写命令。无法唯一证明时保留未知状态，不自动回滚或重试。
- 操作完成后重新建立监听基线并强制刷新，避免本次写入的迟到通知取消紧接着的预览。浏览器测试同时验证后续外部修改仍自动更新。

命令语义依据：[git commit](https://git-scm.com/docs/git-commit)、[git switch](https://git-scm.com/docs/git-switch)、[git update-ref](https://git-scm.com/docs/git-update-ref)、[Git hooks](https://git-scm.com/docs/githooks)。

## 已验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 25 个测试文件，181 项通过，54.18 秒 |
| `pnpm build` | 通过 |
| `pnpm test:e2e` | 65 项通过，2.6 分钟 |
| Rust 宿主测试 | 4 项通过，5.95 秒 |
| `pnpm build:desktop` | macOS arm64 成功，release 编译 36.99 秒，应用 241.60 MiB |
| 安装版原生窗口 | 普通提交、暂存后再提交、创建后不切换、独立切换均通过 |
| 安装版 inspect | PATH 仅系统目录时成功，无需外部 Node |

真实仓库测试覆盖 V1/V2/V3、首次提交、缺少身份、无暂存变化、空说明、过期 index、操作中状态、hook 改内容、hook 失败与签名失败。分支覆盖非法/重复名称、固定创建起点、脏工作区、目标移动、其他 worktree 占用、目标版本才启用的 smudge 探针、忽略文件保护与 post-checkout 失败。

恢复验证使用真实子进程：提交完成、最终结果保存前自发 SIGKILL，磁盘仅有执行意图；新协调器通过 reflog 找回原提交，parent/tree 正确，再次查询同 ID 不增加提交。另覆盖响应丢失后页面重载、关闭 reflog 的仓库配置、超时 hook 的进程组终止及禁止重试、关联 worktree 写锁与新会话隔离。只读指纹、旧成功/错误隔离、跨仓库迟到请求、历史分页、鉴权等原有测试全部回归。

浏览器新增 5 项专项流程测试。全量回归发现两个旧测试仍用 `.head-line strong` 定位分支，已改为核对新“分支操作”按钮；测试含义仍是历史筛选不能改变当前分支。[390px 提交确认截图](screenshots/commit-preview-narrow.png)已视觉核对，确认内容、hook 授权和操作按钮可见，无横向溢出。

## 原生窗口核对

新版安装到固定 `~/Applications/Git View.app`，构建时间 `2026-10-06T10:26:56.707Z`，安装器核对清单和全目录指纹，旧版压缩为 ZIP，移除构建目录的同名应用副本。使用独立测试仓库和应用数据目录，不改变用户日常最近仓库记录。

1. 初始 HEAD `f4f23733` 为 V1，index 为 V2，工作文件为 V3。原生提交预览只有 V1 → V2；确认后新提交 `dddb4505` 的 parent 为 `f4f23733`，tree/index 均为 V2，工作文件仍为 V3，回执显示未暂存 1。
2. 在界面选中剩余文件并暂存，核对 V2 → V3 后确认；再次普通提交得到 `3fd5006b`，parent 为 `dddb4505`，tree 为 V3，工作区干净。
3. 原生界面创建 `topic/native`，独立 Git 核对其 OID 为 `3fd5006b`，窗口仍显示 main。随后独立切换 baseline，实际 HEAD 为 `f4f23733`，工作文件回到 V1，main 和 topic/native 均仍为 `3fd5006b`，未发生历史重写。
4. 原生窗口显示“切换分支完成”、当前分支 baseline、历史 1 条、工作区干净。系统 PATH 下安装版 inspect 成功；退出窗口后宿主正常退出。

## 限制与尚未验证

- 实机目标为 macOS Apple silicon。Windows 明确拒绝写入、保留读取；POSIX 专属测试在 Windows 跳过。Linux/macOS Intel 实际运行和本次远程 CI 结果不从本机通过推断。
- 仍限制为常规仓库/index，不支持冲突、进行中的 merge/rebase 等操作、特殊 index、submodule 或非 UTF-8 路径。当前有效外部过滤器与目标 tree 的 filter 属性拒绝执行，未承诺 LFS 写入支持。
- 提交预览最多 200 个文件；说明最多 16,384 字符；执行默认 120 秒超时。超过预览大小的差异明确降级，实际操作范围不被悄悄缩减。
- 应用锁不能约束外部 Git、编辑器或 hook 的其他动作；执行后报告实际事实，不承诺跨外部进程事务。不同应用数据目录的实例依赖 Git 自身锁与核实。
- 超时会终止本次进程组，但不撤销 hook 已经造成的副作用。签名依赖图形代理/已配置程序；需要交互终端的签名流程未实机验收。
- 进程异常退出留下的应用锁不自动删除，应先查询原回执及进程状态再处理提示路径。成功回执描述当次执行结果，不保证仓库此后未被其他程序修改。

本次提交仅包含二、三批代码、测试、计划和验收文档；安装脚本、package.json 安装命令、Spotlight 文档与 README 安装段落是另一段对话原有改动，保留未提交。代码上传目标为现有 origin 的当前功能分支，远端提交号在最终交付回执核对。
