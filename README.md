# Git 可视化工具

本地 Git 可视化工具，用于查看工作区、暂存区、提交历史和仓库引用。

已实现第一轮 MVP 和第二阶段第一批（2A）：只读桌面窗口、仓库导航、并排差异和自动刷新。macOS Apple silicon 的安装副本、CLI 与原生界面已运行验证；其他平台和 Codex skill 自动发现的证据边界见 [2A 验收记录](docs/verification/v0.2-a.md)。

界面以仓库切换、历史范围、文件列表和差异查看为主体。已完成入口与布局、差异与文件导航、刷新与反馈三轮调整，见 [第一轮验收](docs/verification/2026-10-06-interface-round1.md)、[第二轮验收](docs/verification/2026-10-06-interface-round2.md) 和 [第三轮验收](docs/verification/2026-10-06-interface-round3.md)。此前的教学界面移除记录见 [界面调整验收](docs/verification/2026-10-06-tool-ui.md)。

当前采用奶油白、浅米色与陶土色主题，界面色值集中于 [theme.css](apps/web/src/theme.css)，桌面图标同步调整。截图及验证结果见 [暖色主题验收](docs/verification/2026-10-06-warm-theme.md)。

请从 [MVP 开工文档](docs/MVP-KICKOFF.md) 开始。文档包含：

- 首版功能、明确后置的需求与用户流程。
- 推荐架构、替代方案、模块职责和未来需求的扩展方式。
- Codex 轻量接入及后续 MCP、DSH 的位置。
- 施工里程碑、验收场景、测试方法及研究来源。

第一版范围是本地只读查看与一个 Codex 入口，任务前后基线和 Git 写操作放在后续阶段。

接下来的工作见 [第二、第三阶段实施计划](docs/superpowers/plans/2026-10-06-next-stages.md)：第二阶段吸收 oil-git 的导航、差异查看和桌面交付经验，再加入任务前后比较与历史调查；第三阶段逐项加入暂存、取消暂存、提交、创建和切换分支。下面列出已实现的 2A 能力；2B 与第三阶段仍待施工。

现有查看器的交互调整按 [三轮界面优化计划](docs/superpowers/plans/2026-10-06-interface-refinement.md) 单独跟踪。第一轮整理布局和入口，第二轮优化差异查看与文件导航，第三轮统一刷新反馈并回归验收；界面轮次不等同于上述产品阶段。

## 桌面预览版

从源码构建（需要 Node 24.19.0、pnpm、Rust 与 macOS Xcode Command Line Tools）：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:desktop
```

双击 `apps/desktop/src-tauri/target/release/bundle/macos/Git View.app`，使用原生窗口选择仓库。可将 `.app` 复制到自己的应用目录；运行时无需另装 Node、Swift 或 Rust，仍需系统 Git。当前为未公证的本地测试包，Windows/macOS Intel 尚未实机验收。

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

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm build
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
