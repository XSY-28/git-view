# Git View

[![Source checks](https://github.com/XSY-28/git-view/actions/workflows/check.yml/badge.svg)](https://github.com/XSY-28/git-view/actions/workflows/check.yml) · [MIT License](LICENSE)

本地 Git 可视化工具，用于查看工作区、暂存区、提交历史、分支与标签。支持整文件暂存、普通提交和本地分支操作，每次写入先预览再确认。仓库内容在本机处理，无需远程服务。

界面支持 **English / 中文**，默认英文；语言选择在本机保存，仓库名、文件内容与提交说明保留原文。

![Git View 暖色界面与提交历史](docs/verification/screenshots/warm-theme-history.png)

当前为桌面预览版。macOS Apple silicon 的安装副本与原生界面已有实机验收；GitHub CI 检查 macOS ARM、macOS Intel 与 Windows。Windows 目前提供查看功能，写入尚未开放；其他平台的桌面安装和原生交互仍需实机验证。具体证据见 [2A 验收记录](docs/verification/v0.2-a.md)、[暂存验收](docs/verification/2026-10-06-stage-files.md)、[提交与分支验收](docs/verification/2026-10-06-commit-branches.md) 和 [语言切换验收](docs/verification/2026-10-06-language.md)。

从源码开始：

```sh
git clone https://github.com/XSY-28/git-view.git
cd git-view
```

## 桌面预览版

从源码构建（需要 Node 24.19.0、pnpm、Rust 与 macOS Xcode Command Line Tools）：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:desktop
pnpm install:desktop --dry-run
pnpm install:desktop
```

macOS 使用 `pnpm install:desktop` 安装到固定的 `~/Applications/Git View.app`，之后从 Spotlight 或该路径打开。安装前先退出 Git View；`--dry-run` 只检查构建与安装状态，不写文件。安装脚本核对应用身份、构建清单与文件哈希，将旧安装压成 ZIP 保存到 `~/Library/Application Support/Git View/backups/`，验证替换成功后注销并移除构建目录中的 `.app`，避免每次更新增加同名入口。构建命令本身不会修改安装目录；再次安装前需要重新构建。测试副本应在测试结束后注销并删除，旧版本请保留为 ZIP。流程与验收边界见 [安装验证说明](docs/verification/2026-10-06-desktop-install.md)。

运行时无需另装 Node、Swift 或 Rust，仍需系统 Git。当前为未公证的本地测试包，Windows/macOS Intel 尚未实机验收。

桌面 CLI 直接使用随包可执行文件：

```sh
"/absolute/path/Git View.app/Contents/MacOS/git-view-desktop" open --repo "/absolute/repository" --json
"/absolute/path/Git View.app/Contents/MacOS/git-view-desktop" inspect --repo "/absolute/repository" --json
```

`open` 启动或复用原生窗口，`inspect` 无窗口读取并退出。关闭原生窗口即可退出桌面宿主。两者共享原来的 Git 核心和结果契约；安装检查与架构取舍见 [桌面 ADR](docs/decisions/0002-desktop-host.md)。

## 浏览器备用入口（macOS）

已验证环境：macOS Apple silicon、Node.js 24.19.0、pnpm 11.7.0、系统 Git 2.54.0。安装 Node.js 24、pnpm 与系统 Git 后，在此目录运行。macOS 从源码构建还需要 Xcode Command Line Tools（或完整 Xcode），用于编译原生文件夹选择器；构建产物运行时不需要 Swift 编译器。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm open
```

`pnpm open` 打开当前目录所在的实际 worktree。点击顶部的 **仓库名称** 展开切换器，再选 **打开仓库…**，通过 macOS 原生文件夹窗口选择另一个仓库；也可直接按 `⌘/Ctrl+O`。选择仓库内的子目录也能识别根目录，取消会保留当前仓库，选到非仓库目录会显示提示。同一切换器集中显示最近仓库、同仓库的多个 worktree、当前完整路径与复制按钮，并保留“手动输入路径”备用入口。

重新构建后，如已有旧的本地进程运行，先执行 `pnpm stop`，再 `pnpm open`，使其加载新版本。直接指定其他仓库时，使用绝对路径并为含空格的路径加引号：

```sh
node dist/cli.mjs open --repo "/absolute/path/to/repository" --json
node dist/cli.mjs inspect --repo "/absolute/path/to/repository" --json
pnpm stop
```

构建后不依赖开发服务器。`open` 发起系统浏览器打开请求；`inspect` 返回带观测时间的结构化概览，不包含源码或完整 diff。两次读取不代表同一次原子快照。进程只监听 `127.0.0.1`；最近仓库和运行信息保存在本机 `~/.local/share/git-view`，可以用 `GIT_VIEW_HOME` 指定另一目录。30 分钟没有页面心跳或 CLI 请求后自动退出。

## 当前功能

- 按文件勾选暂存或取消暂存，预览中显示实际比较与明确文件范围；暂存整个当前文件，取消暂存保留工作文件。预览 60 秒失效，HEAD、index、内容或配置变化时拒绝旧预览；断线或重启后先核实持久回执，不自动重复执行。
- 首批写入支持常规 index 中的普通文件、链接本身及新增/删除/改名；冲突、进行中的操作、稀疏/split index、不支持的路径与内容转换会明确拒绝。整文件暂存暂不支持 text/eol/ident/working-tree-encoding 或 autocrlf 转换，不运行内容过滤器或 post-index-change hook。macOS Apple silicon 已验收；Windows 暂未开放写入，现有读取入口保持原语义。
- 顶部仓库切换器集中提供打开仓库、最近仓库、worktree 切换、完整路径及复制、手动路径；支持根目录和子目录识别，并继续使用 macOS 原生文件夹窗口。
- 分开查看已暂存、未暂存、未跟踪内容；同一文件的两份 diff 保留各自基准。
- 显示分支、HEAD、尚无提交、detached HEAD、冲突及进行中的操作。
- 常驻“历史范围”侧栏显示本地分支、标签和已有远程跟踪引用；新打开的工作区默认查看“当前 HEAD”。“全部引用”默认采用时间优先排序，也可切换为分支聚合；两者都保留父子关系，排序选择按工作区记忆。筛选只改变历史显示，不 checkout。顶部单独显示当前分支，与所选历史范围区分。
- 提交图按 200 条分页；HEAD 已加载时提供“定位 HEAD”，未加载时明确显示“查看 HEAD 历史”。关系图与提交说明分列，底部横向滚动只移动左侧关系图，图线不会进入文字列；排序切换会重新读取第一页，分页不会混合两种排序。见 [历史排序验收](docs/verification/2026-10-06-history-order.md) 和 [宽图分列验收](docs/verification/2026-10-06-history-columns.md)。
- 历史列表默认占满主区域；点击提交或按 Enter 打开详情，关闭按钮或 Esc 返回宽列表并保留选择和纵向位置。打开详情后可拖动分隔条，或用左右方向键、Shift 加速、Home/End 调整两列宽度；窄窗口通过面板标签切换。紧凑提交行显示标题、作者及引用，日期和完整 ID 可悬停查看。见 [复杂历史阅读验收](docs/verification/2026-10-06-history-reading.md)。
- 提交摘要默认显示标题、作者、日期、短 ID 与比较语义；完整 ID、父提交和完整基准按需展开。变化文件列表可收起，长列表独立滚动；首次提交和合并提交的第一父比较仍可核对。
- 单列/并排文本差异、真实行号和折行；比较两侧明确标注 HEAD、暂存区、工作区或提交。默认隐藏重复补丁头，保留路径、文件模式变化和行尾标记，原始补丁可展开查看与复制。
- 未跟踪文本使用单列预览和折行；当前改动与提交文件支持新旧路径筛选、上下方向键及 Home/End 导航。按 worktree 分开保存两种视图的筛选和选择；筛掉当前文件会清空详情，清除筛选后可重新选择。
- 文件监听自动更新，保留手动/焦点刷新。刷新按钮含义固定，短读取使用轻量反馈，慢读取再提供范围明确的取消；失败和取消保留旧结果并可重试。取消清除排队刷新，聚焦窗口不会立即重启；手动刷新或新的仓库变化可恢复。旧成功和旧错误不会覆盖当前选择，同一提交重试保留文件、展开状态和阅读位置。
- `⌘/Ctrl+O` 选择仓库，`⌘/Ctrl+R` 刷新，启动恢复最近仓库并明确报告失效路径。
- [Codex skill 安装包与卸载说明](integrations/codex/README.md)。安装会复制自包含构建产物，本次未修改全局 skills 目录。

二进制、非 UTF-8 内容、超过 1 MiB 或 10,000 行的预览会明确降级。实际涉及外部 clean/process 过滤器时不扫描工作区，保留可安全读取的暂存内容。首版明确拒绝裸仓库和 partial clone/promisor 仓库，不自动下载对象或修改 Git 配置。

## 提交与分支

- 在“当前改动”点击“提交…”填写说明，核对已暂存文件后确认。不会自动暂存未选内容；提交后显示实际 OID、parent/tree 和剩余修改。
- 点击顶部当前分支名称，选择创建或切换。创建从预览时的 HEAD 出发且不自动切换；切换只支持已有本地分支，要求没有暂存、未暂存或未跟踪改动。侧栏“历史范围”仍只筛选历史。
- 提交与分支操作保留 Git 的 hooks 和已配置签名程序，确认页需明确允许运行；它们可能改变实际提交或工作区。失败保留诊断，断线或重启后先核对原回执，不自动重试。
- 写入目前仅在 POSIX 开放，实机验收为 macOS Apple silicon；Windows 保留查看功能。冲突、进行中的 Git 操作、特殊 index/submodule、外部内容过滤器等继续明确拒绝。进程异常退出留下的应用锁需核对原回执及进程后处理，不删除外部 Git 锁。

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm test:install-desktop # macOS 安装流程测试；其他平台跳过
pnpm build
pnpm exec playwright install chrome
pnpm test:e2e
node scripts/benchmark.mjs
```

浏览器测试和基准使用本机 Chrome。所有测试 Git 写入都限制在新建临时目录。`pnpm test` 包含真实 Git 语义、只读指纹、请求时序、本地鉴权与持久化测试；浏览器和性能结果单独记录，不由单元测试推断。

原生选择窗口及其取消、错误处理的验收见 [文件夹选择功能验证](docs/verification/2026-10-06-folder-picker.md)。

需要手动观察部分暂存的示例时，`node scripts/create-demo.mjs` 会输出一个新建临时仓库路径；它包含已提交 V1、已暂存 V2 和工作区 V3。只读验证进程生命周期与安装副本可运行：

```sh
node scripts/verify-lifecycle.mjs --repo "/absolute/path/to/test-repository"
```

代码目录与依赖方向见 [施工基线](docs/decisions/0001-implementation-baseline.md)。依赖版本以 `pnpm-lock.yaml` 固定；源码通过 `packages/contracts` 的 Zod schema 共享传输约定。

## 架构与贡献

React 前端与 Tauri 桌面宿主共享 TypeScript Git 核心；读取、写入预览、执行队列与回执分别维护契约。查看 [施工基线](docs/decisions/0001-implementation-baseline.md)、[桌面架构](docs/decisions/0002-desktop-host.md) 和 [MVP 设计文档](docs/MVP-KICKOFF.md) 了解模块职责与设计边界。后续工作见 [实施计划](docs/superpowers/plans/2026-10-06-next-stages.md)。merge/rebase、历史重写和应用内推送尚未实现。

欢迎通过 [Issues](https://github.com/XSY-28/git-view/issues) 报告问题或提交 Pull Request。报告时请提供平台、版本、复现步骤及预期结果；涉及仓库内容的日志或截图请先移除私人信息。修改后运行 `pnpm check`，界面变更另运行 `pnpm test:e2e`，安装流程变更运行 `pnpm test:install-desktop`。测试仓库使用临时目录。

## 许可证

本项目源码采用 [MIT 许可证](LICENSE)。桌面包随附 Node.js 运行时的许可声明，见 [Node.js LICENSE](apps/desktop/licenses/node-v24.19.0-LICENSE)；第三方依赖保留各自许可证。
