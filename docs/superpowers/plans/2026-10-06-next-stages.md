# Git 可视化工具：后续两个阶段实施计划

> **供施工 agent 使用：** 按任务使用 `subagent-driven-development` 或 `executing-plans` 推进，并使用复选框记录实际结果。本文跟踪计划与实际进展。2026-10-06 用户已要求开始下一阶段施工，本轮交付 2A 本机预览；未勾选项目仍待验证或实施，2B/第三阶段未计为完成。

**Goal：** 在现有只读 MVP 上吸收 oil-git 的查看体验与交付工程，完善当前状态、历史和任务前后比较，再提供可核对结果的基础 Git 操作。

**Architecture：** 保留 React、TypeScript contracts/core 和系统 Git 适配器。桌面化优先验证 Tauri 薄壳与随安装包携带 Node 运行时的查询子进程，使用受控 IPC/stdio 复用现有核心，不复制一套 Rust Git 业务。任务基线独立保存，第三阶段新增独立写用例；只读接口继续保持只读。

**Tech Stack：** 当前 Node.js 24、TypeScript、React、Zod、系统 Git；桌面候选 Tauri 2。版本以现有 lockfile 和后续桌面原型的兼容记录为准，不为跟随参考项目而整体升级依赖。

**Spec：** [MVP 开工文档](../../MVP-KICKOFF.md)、[当前实现基线](../../decisions/0001-implementation-baseline.md)、[首轮验收](../../verification/2026-10-05.md)、[原生目录选择验收](../../verification/2026-10-06-folder-picker.md)。

## 1. 依据、范围与完成标准

2026-10-06 读取“Git plan”讨论并核对本地文档后，保留以下两个产品阶段：

1. **第二阶段 V0.2：查看、比较与历史调查。** 延续任务起点基线、前后比较、分支比较、文件历史和搜索；吸收 oil-git 的日常查看体验与桌面交付方式。
2. **第三阶段 V0.3：基础 Git 操作。** 暂存、取消暂存、提交、创建和切换分支，逐项交付操作预览、前置检查和结果核实。

早期讨论还提出 blame、stash/reflog 查看和自动刷新，本文将它们明确归入 V0.2。MCP、DSH 仍是同一核心的轻适配；自动 hooks 时间线、多 agent 归因、复杂历史重写不提前进入这两个阶段。

**本次调整新增：** 查看体验、可安装桌面版、标准 LFS 安全读取和安装后 CI。**保持：** 两阶段主线、可核对的比较基准与来源、先读后写、真实仓库验证。**本次技术建议：** Tauri + Node 子进程是待原型验证的默认路线，不是用户已经选择 Rust 重写，也不预先宣称包体更小或运行更快。

**2026-10-06 产品方向修订：** 用户要求将产品作为日常 Git 工具，移除面向新手的固定问答、概念讲解和教学提示。界面保留操作必需的状态、比较基准、来源、读取限制和错误反馈。旧 `explanations` 数据契约可为兼容现有调用方保留，不再要求界面展示或为新增能力扩展教学问答。

**现有界面的优化安排：** 用户随后确认分三轮整理现有查看器。第一轮已合并仓库入口、压缩顶部与提交详情、明确历史范围和当前分支；第二轮已调整差异呈现与文件筛选、键盘导航，见 [界面优化计划](2026-10-06-interface-refinement.md) 与 [第二轮验收](../../verification/2026-10-06-interface-round2.md)。界面第三轮已统一刷新反馈、取消与恢复，并完成浏览器回归和原生窗口核对，见 [第三轮验收](../../verification/2026-10-06-interface-round3.md)；这三个界面轮次独立于产品 2A/2B/V0.3，不扩大产品阶段或写操作范围。

本计划替代 MVP 文档第 13 节原有的后续任务排序；F05 的教学界面要求及相关教学验收已撤销，其余功能、事实正确性和现有只读验收仍有效。第二阶段新增的文件预览/LFS能力只在对应测试通过后扩大原来的降级范围。第三阶段增加的写能力须独立声明，不追溯改变只读入口的含义。

## 2. 全局约束

- 第二阶段不执行用户仓库的暂存、提交、checkout、fetch、stash、备份提交、配置修复或初始化。
- 窗口、CLI、Codex、DSH 使用同一核心和契约；UI 不直接拼接或执行 Git 命令。宿主事件不进入 Git 事实模型。
- 继续按 worktree 建立状态身份；共享 refs 的操作还必须识别 common Git directory。成功、错误、取消、超时和结束回写都必须检查请求身份。
- 文件、提交、比较基准与读取时间必须能核对；错误、截断、缺失对象和过期结果不能变成“干净”或空列表。
- 自动刷新只提供失效信号，读取前后复核负责一致性；检测到变化时有界重试，持续变化明确提示。取消不作为正确性保证。
- 任务基线存于仓库外，不建立隐藏 Git 提交或修改 refs/index；“这段时间的变化”不等于“某个 AI 独自产生的修改”。
- 源码和基线默认只保留在本机，不隐式发送给模型或云服务；`inspect` 默认返回概览及证据标识，不返回完整源码。
- Git 开发操作遵守用户约定：先查看变化文件并解释目的，再按授权操作；只暂存已检查的具体文件，不使用全量暂存。测试写 Git 只使用新建临时夹具。
- macOS Apple silicon 先验收；macOS Intel、Windows 分别记录构建、安装 CLI、原生 GUI 的证据。某一层通过不代替另一层；缺少目标机器时标为待验证。
- 不把截图、测试数量、mock UI、源码中存在 CI 配置当作完整产品验收。性能需按相同夹具和条件比较，不推断优于 oil-git。

## 3. oil-git 经验如何纳入

参考版本固定为 [`94c0a6978b7755aab3db34a716832b181d1b3029`](https://github.com/oil-oil/oil-git/commit/94c0a6978b7755aab3db34a716832b181d1b3029)。此次依据是源码、使用文档和发布记录阅读，不是本机对照运行。

| 可借鉴部分 | 本项目安排 | 明确边界 |
| --- | --- | --- |
| 常驻历史范围侧栏、切视图保留选择和滚动位置 | 2A-02 | 仓库及 worktree 切换集中到顶部切换器；窄窗口在历史范围、列表和差异面板之间切换，不设置教学解释区 |
| 并排/统一文本 diff、真实行号和换行 | 2A-03 | 现有统一 diff 与行号已实现；新增并排对齐、模式切换与位置保持，不重复报为从零开发 |
| 分支/标签筛选、worktree 选择、上游计数 | 2A-02、2B-01 | 筛选不是 checkout；计数基于本地跟踪记录，不 fetch |
| 原生桌面窗口、安装包、自包含 CLI | 2A-01、2A-04 | 复用当前核心；安装后无需另装 Node，但仍要求系统 Git |
| 图片预览、LFS 与更丰富文件类型 | 2B-03 | 首批 PNG/JPEG/WebP 基础并排；标准 LFS 指针/本地内容比较，不下载、不运行仓库过滤器 |
| 读取一致性、请求乱序、安装后检查 | 全部任务，集中在 2A-04 | 现有门禁继续保留；新增查询/桌面入口各自验证，不能只照搬机制名称 |
| 文件历史、行来源、stash 查看 | 2B-01 | blame 不等同于整段逻辑的作者；stash 只查看，不 apply/pop/drop |
| 主题、中英切换、音视频、图片滑动/叠加/像素比较 | 第二阶段增强队列 | 不阻塞 V0.2 核心交付；先记录真实使用需求，避免挤占任务比较与基本操作的开发 |

允许学习实现方法；如实际复制或改编源码、图标或其他资源，逐项核对相应许可证并保留必要说明。借鉴不意味着合并两个完整后端。

## 4. 架构与文件落点

以下新路径是施工落点，尚未创建实现。每个新增用例在 contracts 定义 schema，再由核心组织语义，传输层负责校验与授权。

| 职责 | 现有入口 | 计划新增或拆分 |
| --- | --- | --- |
| 仓库事实、比较与错误契约 | `packages/contracts/src/index.ts` | 按 navigation、history、baseline、operations 拆 schema，入口继续导出；Zod 仍是单一来源 |
| 只读查询调度 | `packages/core/src/index.ts` | 新增 `navigation.ts`、`investigation.ts`；只在新增查询需要时拆分 |
| 系统 Git 与路径/对象读取 | `packages/git-cli/src/index.ts`、`runner.ts`、`parse.ts` | 新增对应查询文件、`lfs.ts`；测试覆盖后迁移代码，保留系统 Git 语义 |
| 页面状态及展示 | `apps/web/src/App.tsx`、`state/api.ts` | `state/repository-controller.ts`、`state/transport.ts`，按 navigation、comparison、baseline、operations 新增功能目录 |
| 桌面宿主 | 当前 `apps/local/`、`apps/cli/` | `apps/desktop/`、`apps/local/src/stdio.ts`、`apps/cli/src/transport.ts`；窗口与进程生命周期不进入 core |
| 基线保存与比较 | 尚无 | `packages/baseline/src/`；存储目录权限与清理逻辑独立于最近仓库列表 |
| 写用例与执行 | 尚无 | `packages/operations/src/`、`packages/git-write/src/`；不向现有只读 runner 添加任意写命令出口 |
| 安装及持续验证 | `scripts/build.mjs`、`scripts/verify-lifecycle.mjs` | `scripts/verify-installed.mjs`、`.github/workflows/check.yml`、`.github/workflows/package.yml` |

传输抽离只为已有浏览器与新增桌面两个真实调用方服务：浏览器继续使用现有鉴权 HTTP；桌面使用壳转发的窄 IPC/stdio，不把 HTTP 令牌交给渲染层。JSON 请求与结果遵守共享 schema，请求取消有对应 requestId。业务逻辑不因 IPC/HTTP 分叉。

桌面 CLI `open` 连接已运行桌面实例或启动它；`inspect` 可独立冷启动无窗口读取，沿用同一核心。桌面与 CLI 的实例复用、受限本地 IPC、退出及协议不匹配恢复在 2A-01 一起验证，不能只让 GUI 工作而破坏 harness 入口。

## 5. 第二阶段 V0.2：查看、比较与历史调查

分 2A、2B 两批交付，每批都能独立演示。它们属于同一个产品阶段。两批均以仓库导航、列表与比较结果为主体，保持比较基准和读取状态可核对。

### 2A-01：验证并交付桌面宿主

**目标：** 双击安装后的应用即可选仓库；CLI 能复用窗口，查询结果与现有浏览器一致。

**文件：** 新增 `apps/desktop/`、`apps/local/src/stdio.ts`、`apps/cli/src/transport.ts`；调整 `apps/web/src/state/api.ts`、`scripts/build.mjs`；新增 `tests/integration/desktop-transport.test.ts`、`docs/decisions/0002-desktop-host.md`。

- [ ] 先做最小垂直原型：装包 → 启动窗口 → 原生目录选择 → 同一核心读取真实仓库 → 关闭并清理子进程；同时运行安装后的 `open` 与无窗口 `inspect`。
- [x] 首选 Tauri 2 + 随包 Node 子进程，固定子进程入口，stdio 仅接受已定义请求，不给前端通用 shell/file-system 能力。渲染层不获得任意命令执行权限。
- [ ] 记录与 Electron 复用现有 TS 核心方案的取舍：安装/退出正确性、开发复杂度、包体、启动与空闲内存。Tauri 未通过生命周期或分发门槛时，依据证据写 ADR 再切换；不同时长期维护两套桌面壳。Rust 全量重写不列入本轮。
- [ ] 验证 Windows 路径、Git 发现、CLI 启动器、旧协议恢复；现有 macOS Swift picker 留给浏览器入口，桌面用宿主原生对话框。

**验收：** 新建临时安装目录不依赖源码目录、开发服务器、外部 Node；路径含中文/空格；取消不换仓库；CLI 重复 open 复用实例；查询子进程异常可重启；正常退出无遗留子进程；无窗口 inspect 不拉起 GUI。平台和实际版本写入 ADR，不用“理论上跨平台”作为结果。

### 2A-02：仓库导航与连续的查看状态

**文件：** 新增 `packages/core/src/navigation.ts`、`apps/web/src/features/navigation/RepositorySidebar.tsx`、`apps/web/src/state/repository-controller.ts`；修改 contracts、Git 适配器、App 与 storage；新增 `tests/integration/navigation.test.ts`、`tests/e2e/navigation.spec.ts`。

- [x] 增加本地分支、标签、已有远程跟踪引用和 worktree 选择；切 worktree 仍走 canonical 身份解析，不共用 index/HEAD 状态。
- [x] 固定历史范围侧栏；仓库/worktree 切换与最近仓库集中到顶部切换器，当前分支单独标记。当前变化、历史视图分别保留有效选择、筛选和滚动位置。状态按 worktree + view + comparison 身份保存，失效时解释原因。
- [x] 增加引用筛选、最近项目恢复和 `⌘/Ctrl+O`、`⌘/Ctrl+R`。首次恢复失败显示原路径与重选入口，不默默打开另一个仓库。
- [x] 扩展 history 的 scope/queryKey/cursor，筛选条件和固定 tip OID 都属于查询身份；不能把旧全仓库游标用于新筛选。

**验收：** 分支筛选前后 HEAD/index 不变；切 linked worktree 不串内容；历史翻页后切筛选不混入旧结果；窄窗口、键盘导航可用；从历史返回部分暂存文件仍能区分两份比较。

### 2A-03：文本 diff 与外部修改后的刷新

**文件：** 修改 `apps/web/src/features/changes/DiffView.tsx`、`diff-lines.ts`；新增 `features/comparison/SideBySideDiff.tsx`、`apps/local/src/watch.ts`；修改 core/adapter 一致性检查及请求门禁；新增 `tests/integration/refresh.test.ts`、`tests/e2e/comparison.spec.ts`。

- [x] 在现有真实行号基础上增加并排/统一切换、对应行对齐、自动换行与位置保持。折行只改变展示，不能生成新的 Git 行号。
- [x] 继续展示 HEAD→index、index→worktree、空树→首次提交等基准；截断时不把可见行统计冒充整份差异统计。
- [x] 监听工作树及 Git 元数据失效，合并短时间重复事件；焦点刷新和手动刷新继续兜底。监听失败明确提示，不能声称自动更新仍有效。
- [x] 读取前后复核观测身份；持续外部修改时最多重试 2 次，仍不稳定显示“仓库正在变化”并保留过期结果。选择器或写操作进行时不被刷新抢占。

**验收：** V1 已提交、V2 已暂存、V3 在工作区的两份 diff 在两种模式中一致；中文、制表符、空行、文件末尾无换行正确；快速换文件的旧成功与旧错误均丢弃；外部编辑/暂存/提交后刷新正确，监听事件漏失后焦点刷新能恢复。

### 2A-04：可复现安装与 CI

**文件：** `.github/workflows/check.yml`、`.github/workflows/package.yml`、`scripts/verify-installed.mjs`、`integrations/codex/README.md`；新增 `docs/verification/v0.2-a.md`。

- [ ] 保留当前类型检查、真实 Git、浏览器与只读指纹测试，并增加桌面传输/安装检查。补上现有 MVP 的错误场景、Codex 实际发现与触发缺口，逐项记证据，不一次勾满旧验收表。
- [ ] 按 macOS ARM、macOS Intel、Windows 建源码检查；源码检查通过后再打包，并对安装产物运行 CLI、中文路径、异常退出和仓库指纹验证。
- [ ] 在真实 Mac 上完整走查原生窗口、目录选择、取消、重启恢复和安装后 Codex 调用。其他平台分别列出 GUI 是否已测。
- [ ] 记录发布标签与构建提交、依赖版本、校验和、签名/公证状态和卸载范围。仅在实际完成后声明系统信任或正式发布；缺少签名材料不伪装为已签名包。

**2A 退出标准：** 桌面安装后的打开→查看→刷新→退出流程通过；导航与文本比较可用；新增接口继续通过只读及乱序检查；安装、CLI、GUI 的证据分开。用户此时可持续使用改进后的查看器，2B 可以独立迭代。

### 2B-01：历史调查、分支比较与只读补充视图

**文件：** 新增 `packages/core/src/investigation.ts`、`packages/git-cli/src/history.ts`、`apps/web/src/features/history/FileHistory.tsx`、`BranchComparison.tsx`、`RepositoryRecords.tsx`；扩展 contracts；新增 `tests/integration/investigation.test.ts`、`tests/e2e/investigation.spec.ts`。

- [ ] 支持按提交标题、作者、完整/短哈希、文件路径查询；使用固定 tips 分页，不因翻页时分支移动而混合历史。
- [ ] 文件历史首版跟踪单一路径的普通重命名；合并历史中的歧义显示范围，不承诺自动追踪所有复制/改名。blame 针对选定不可变提交及正确一侧的行号，不向未提交新增行伪造作者。
- [ ] 分支比较同时给各自独有提交、可确定的共同祖先和明确标注的内容比较。A/B 先解析成固定 OID；端点树比较与共同祖先→目标分支比较分开，多个 merge-base 或历史缺失时不随意挑一个制造确定结论。
- [ ] 展示 stash/reflog 的本地记录与详情；stash 默认只比较其工作区快照和第一父基准，其他父/未跟踪内容须独立标明。reflog 不等同于完整命令审计，过期/不存在均有解释。
- [ ] 显示相对本地记录上游的 ahead/behind；没有上游或对象缺失不能显示为 0，不主动 fetch。

**验收：** 分叉、merge、重命名、浅历史、分支移动夹具能核对；选分支只改变查询；blame 行号随比较一侧正确对应；stash/reflog 查看前后 refs/index/工作文件无变化；搜索结果过期时不错误跳转。

### 2B-02：显式任务基线与前后比较

**文件：** 新增 `packages/baseline/src/index.ts`、`capture.ts`、`store.ts`、`compare.ts`；新增 `apps/web/src/features/baseline/BaselinePanel.tsx`；扩展 contracts、core 和 CLI；新增 `tests/integration/baseline.test.ts`、`tests/e2e/baseline.spec.ts`。

- [ ] 提供“记录起点”“记录终点并比较”和基线列表；同时显示基线创建时间、worktree、HEAD、原有脏状态、覆盖范围与排除原因。
- [ ] 捕获 HEAD 身份、index 内容与模式、工作文件内容、未跟踪文件策略；不能只记录 HEAD 或复用上一次 UI 概览。跟踪文件仍按 index 纳入；默认包含未忽略的未跟踪普通文件，忽略规则不用于排除已跟踪文件。不跟随符号链接读取外部目标，记录链接本身。
- [ ] 内容在应用数据目录独立保存，不依赖未来仍存在的工作文件或 Git 可被 GC 的对象；HEAD 只作为身份和历史引用，未保存的完整提交树不能冒充可离线恢复的快照。
- [ ] 建立基线与结束点时前后复核，持续变化返回不完整/失败；原本已有的 staged/unstaged 修改继续单列。输出分别比较 index 起点→终点、工作区起点→终点及未跟踪集合变化，不能把“只有暂存状态变化”当内容修改。
- [ ] 不支持的外部过滤器、不可寻址路径、缺失对象及超限内容记录为覆盖缺口；原始字节前后变化与 Git 规范化后的变化分开表述。安全转换无法确认时不提供正常 Git 内容比较或确定结论。
- [ ] 初始存储默认值：单文件 5 MiB、单次捕获 100 MiB、每 worktree 保留最多 20 份且最长 7 天、总量 500 MiB。超限明确列出未覆盖项；不静默删减后标完整。创建前显示会保存本地内容及保留规则，删除基线只删除应用副本。
- [ ] 目录 0700、文件 0600；Windows 使用当前用户受限权限。通过临时目录与原子完成标记保存；损坏、取消、重启中断不能显示为可用完整基线。
- [ ] 比较结果只描述起点到终点的变化；没有完整来源证据不归因到 AI、命令或作者；基线不是备份/撤销承诺。

**验收：** 起点已有 V1/V2/V3，期间混合用户和 AI 模拟编辑、暂存/取消暂存、提交、新增未跟踪、删除、改名，再生成终点；界面准确区分原有状态与期间净差异。加入超限、过滤器、缺失内容、清理、进程中断夹具；比较及捕获前后仓库内容指纹不变。未覆盖内容必须在比较结果中标明。

### 2B-03：图片基础预览与标准 LFS

**文件：** 新增 `packages/git-cli/src/lfs.ts`、`packages/core/src/preview.ts`、`apps/web/src/features/comparison/ImageComparison.tsx`；扩展 contracts、传输与内容读取；新增 `tests/integration/preview.test.ts`、`tests/integration/lfs.test.ts`。

- [ ] 对 PNG/JPEG/WebP 实现两侧或新增/删除单侧图片预览。两侧内容必须来自选定比较的真实版本，不能拿当前工作文件代替暂存/提交内容。
- [ ] 新增内容端点只接受已授权会话内的版本/条目标识，不接受任意磁盘路径；检查 MIME、字节数和尺寸，拒绝可执行 HTML/SVG 内容与外部资源加载。初始每侧 8 MiB、1600 万像素，解码失败明确降级。
- [ ] 独立实现标准 LFS 指针解析与本地展开内容的只读等价比较；不执行仓库配置的 `filter.lfs.*`，不下载内容或写 LFS 对象库。自定义 LFS 转换、扩展及无法证明等价的情况继续返回不支持。
- [ ] 不改变现有其他二进制、非 UTF-8、特殊路径的明确降级；UTF-16 和其他媒体留在增强队列，不能靠浏览器猜编码生成假 diff。

**验收：** 图片已提交/已暂存/工作区三版本各不相同，展示准确；超大/畸形图片无无限内存开销；LFS 指针和展开内容的相等/变化/缺失情况正确，配置恶意过滤器时探针不执行，仓库与 LFS 存储指纹不变。

### 2B-04：比较结果与宿主接入

**文件：** 修改 contracts、core 中的比较契约与查询入口、`apps/cli/`、`integrations/codex/`；新增 `integrations/mcp/`、`integrations/dsh/`、`docs/verification/v0.2-b.md`。

- [ ] 基线与分支比较输出明确端点、来源标识、统计及覆盖限制；当前状态与任务期间变化分区展示，可定位到相应文件或提交。
- [ ] CLI 增加显式基线起止与比较入口；Codex 接入同一用例。基线内容采集必须由用户开始任务的动作或明确宿主流程触发，不从聊天标题自动推断任务起点。
- [ ] 以 DSH 作为第二个真实调用方验证少量只读/基线 MCP 工具；宿主只传路径、任务标识和请求，不复制 Git 判断。DSH 正式施工前核对当时安装版本与文档。
- [ ] 手动起止流程先闭环；自动 hooks、跨宿主时间线和因果归因继续后置。两个宿主返回相同证据身份和不完整语义，不能把分开的读取称为同一次原子观测。
- [ ] 使用部分暂存、分支比较、带原有改动的任务基线三类实际工作流试用；记录任务完成率、耗时、交互阻碍与复用情况，和工程结果分开报告。

**V0.2 核心完成：** 2A、2B 的必做任务有运行证据；安装后真实流程可用；基线覆盖与降级可解释；旧功能及只读承诺无回归；Codex/DSH 接入各自有真实宿主证据。某个宿主尚未验证时可以交付已有查看/比较能力，但该项及 V0.2 总体验收保持未完成，不能把“适配代码已写”报作完成。

**第二阶段增强队列：** 音视频、UTF-16、图片滑动/叠加/像素比较、主题和中英切换可独立排期，不阻塞上述核心交付。完整跨平台 GUI、签名与公证按实际目标平台收证；缺少证据的平台保持测试版说明。

## 6. 第三阶段 V0.3：基础 Git 操作

进入前先完成 V0.2 核心并复核比较结果、只读隔离与错误恢复；试用结果用于选择先完善哪个操作。第三阶段写入只来自用户明确选择的具体操作，Codex/MCP 不自动取得写权限。

### 3-01：写用例边界、预览与结果回执

**文件：** 新增 `packages/operations/src/index.ts`、`preview.ts`、`queue.ts`、`receipts.ts`，`packages/git-write/src/index.ts`；新增 `apps/web/src/features/operations/OperationPreview.tsx`；扩展 contracts；新增 `tests/integration/operations.test.ts`。

- [ ] 采用具体操作集合：stage-files、unstage-files、commit、create-branch、switch-branch。接口不接受任意 Git 命令、shell 字符串或任意选项。
- [ ] 预览产生一次性 previewId，绑定 worktree、操作、明确路径、HEAD/index/相关文件及引用前置指纹、影响说明和过期时间；初始有效期 60 秒。执行只接受 previewId 与 operationId，不接受客户端重新提交的路径或参数覆盖预览。
- [ ] 同一 worktree 串行写；影响共享引用的操作还需按 commonGitDir 协调。预览不长期占锁，执行前再次读取核验；任一前提改变就返回过期并重新预览。
- [ ] 外部 Git 不受应用锁控制：依赖 Git 本身锁/引用检查，并在执行后核实真实结果，不承诺跨外部编辑器的原子事务。写期间暂停本会话自动刷新，完成后整体失效旧观测。
- [ ] 在仓库外持久化 operationId 与执行状态。重试同一个 ID 返回已知回执；超时、断线或重启状态不明时先重读核对，不能直接重复提交。无法唯一判定则显示“结果待核实”，保留用户处理入口。
- [ ] 写执行器单独声明 hooks、签名和内容过滤器策略。首批拒绝会触发外部 clean/smudge/process 转换的写入，覆盖当前及目标版本属性；不能将只读 LFS 支持推断为安全写支持。commit 的正常 hooks/签名及 switch 的 post-checkout hook 仅在用户明确了解并信任本地仓库后执行，预览说明可能的影响；不静默禁用 Git 原有检查。

**验收：** 预览后外部改文件、暂存、移动分支都被拒绝；两次点击只执行一次；两个 worktree 对共享 ref 的操作不会在本进程竞态；hook 改 index、提交成功但响应丢失、子进程超时均有可核对回执，不自动重试或强制回滚。

### 3-02：按文件暂存与取消暂存

**文件：** `packages/operations/src/stage.ts`、`packages/git-write/src/stage.ts`、`apps/web/src/features/operations/StageActions.tsx`；新增 `tests/integration/stage.test.ts`。

- [ ] 首批只做用户勾选文件的完整暂存/取消暂存；按行、按 hunk 暂存单独后置。重命名绑定源/目标双方，路径以参数数组和明确 pathspec 传递。
- [ ] 操作前展示具体文件、比较基准和目标内容；禁止隐式全量暂存。
- [ ] 取消暂存只改变 index，保留工作文件；覆盖 unborn、新增、删除和改名，不用清理工作区的命令替代。

**验收：** V1/V2/V3 场景中暂存后 index 为 V3，取消暂存后工作文件仍为 V3；未选文件不变；空仓库、新增/删除、中文/换行/前导连字符路径正确；冲突首版禁止普通 stage 操作并解释限制。

### 3-03：普通提交

**文件：** `packages/operations/src/commit.ts`、`packages/git-write/src/commit.ts`、`apps/web/src/features/operations/CommitForm.tsx`；新增 `tests/integration/commit.test.ts`。

- [ ] 以预览中用户已确认的暂存内容启动普通提交，要求非空说明；不自动 stage，不提供 `-a`、amend、空提交或推送。启用 hooks 时明确告知它们可能改变实际结果，不能承诺提交 tree 必然等于预览 tree。
- [ ] 提交前显示候选文件、分支/HEAD 与限制，重验 index/HEAD；冲突或合并/rebase 等中间状态首版拒绝普通提交，指向外部处理。
- [ ] 提交后读取实际新 OID、父提交、tree 与剩余工作区变化。hooks 改变内容时显示实际结果与预览差异，不能仍宣称严格提交了原预览；hook/签名失败保留诊断，不代改 Git 用户配置或自动重试。

**验收：** 首次提交和普通提交的 parent/tree 正确；V3 未暂存部分保留；无暂存变化被说明；用户身份缺失、hook 失败、签名失败、响应丢失均不会变成假成功或重复提交。

### 3-04：创建和切换分支

**文件：** `packages/operations/src/branches.ts`、`packages/git-write/src/branches.ts`、`apps/web/src/features/operations/BranchActions.tsx`；新增 `tests/integration/branch-write.test.ts`。

- [ ] 创建分支与切换分支分成独立操作，默认从固定 OID 创建，不顺便切换。名称按 Git 规则验证；已存在引用不覆盖。
- [ ] 首批切换仅允许到已存在的本地分支；已有未提交内容、冲突、进行中的操作、目标被另一 worktree 使用时拒绝，解释原因，不自动 stash、不强制丢弃。
- [ ] 执行前检查目标 tree 的属性及有效外部 smudge/process 配置，不能仅检查当前工作区属性；无法证明安全时拒绝。post-checkout 失败仍需读取真实 HEAD 和文件状态，允许回执为“分支已切换，后续 hook 失败”，不能按退出码直接判定没有切换。
- [ ] 预览区分“筛选此分支历史”和“切换实际工作区”；执行后核对 HEAD/工作树，丢弃旧选择与缓存，展示变化前后的事实。

**验收：** 分支筛选始终只读；创建成功但未切换的语义明确；目标分支在预览后移动、名称非法、占用 worktree、脏工作区均正确处理；仅目标版本激活的 smudge/process 探针不执行；post-checkout 返回失败但已切换时如实报告且不重试；不删除/重置既有分支。

### 3-05：整体验收与操作反馈

**文件：** 新增 `tests/e2e/operations.spec.ts`、`docs/verification/v0.3.md`；更新 README、安装/宿主权限说明与操作反馈。

- [ ] 完成“部分暂存 → 预览 → 暂存选定文件 → 普通提交 → 新提交及剩余修改可见”和“干净工作区 → 创建分支 → 独立切换”的真实临时仓库流程。
- [ ] 分开回归纯查看前后仓库指纹不变，以及每个写操作仅发生预期改变；不能因加入写能力放弃只读测试。
- [ ] 故障恢复明确区分已成功、已失败、未开始和结果未知；每种操作说明实际恢复方式，不提供通用“一键撤销一切”的承诺。
- [ ] 走查选定文件、操作预览、执行与结果回执的实际工作流；核对取消暂存保留工作文件、引用筛选不切换分支，记录阻碍操作的问题。

**V0.3 完成：** 五类操作逐项通过真实 Git、并发/故障、原生 GUI 与只读回归；前后说明对应实际结果；没有隐式全量暂存、强制切分支、历史重写、自动推送或结果不明时盲重试。

## 7. 验证入口与执行顺序

当前已有命令可直接作为回归入口；新增安装检查脚本的命令在对应任务交付时写入该脚本与 README，不把尚不存在的命令说成已可运行。

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
node scripts/benchmark.mjs
```

基准沿用 MVP 的 10,000 提交、5,000 跟踪文件、200 变化文件；桌面增加安装产物启动和空闲内存记录，浏览器与桌面分别报告。基线采集另外报告文件数、总字节、磁盘缓存条件和耗时，不能与普通刷新混算。

建议施工顺序：

1. 盘点旧验收缺口，完成 2A-01 的单路径桌面原型；以原型证据固化 ADR 和安装测试入口。
2. 2A-02 与 2A-03 在约定契约后可并行，随后完成 2A-04，交付可日常使用的只读版本。
3. 2B-01 与 2B-02 可分工；2B-03 的文件读取共用底层边界，合并后由 2B-04 验证比较结果及两个宿主的一致性。
4. 第三阶段先完成 3-01，再依次交付 3-02、3-03、3-04，最后进行 3-05；每类操作单独验收，不一次开放全部按钮。

## 8. 后置项与来源

本计划不加入：冲突编辑、merge/rebase 执行、历史重写、push/fetch、自动撤销、自动 hooks 时间线、多 agent 作者归因、云同步、GitHub PR/CI 管理、内置 AI 聊天。它们保留在后续产品决策中。

- oil-git：[固定版本使用说明](https://github.com/oil-oil/oil-git/blob/94c0a6978b7755aab3db34a716832b181d1b3029/docs/zh-CN/usage.md)、[状态管理](https://github.com/oil-oil/oil-git/blob/94c0a6978b7755aab3db34a716832b181d1b3029/src/useRepository.ts)、[Git 读取](https://github.com/oil-oil/oil-git/blob/94c0a6978b7755aab3db34a716832b181d1b3029/src-tauri/src/git.rs)、[CI](https://github.com/oil-oil/oil-git/blob/94c0a6978b7755aab3db34a716832b181d1b3029/.github/workflows/build.yml)。参考实现不是我们的测试结果。
- 桌面方案依据：[Tauri sidecar](https://v2.tauri.app/develop/sidecar/)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)。文档支持可行性，不代替本项目安装与生命周期原型。
- 写操作边界依据：[Git 内容过滤器](https://git-scm.com/docs/gitattributes)、[Git hooks](https://git-scm.com/docs/githooks)。过滤器和 hooks 的作用必须按具体操作检查，不能沿用只读命令的假设。
- 本地已验证基线：66 项单元/集成测试、7 项浏览器测试与真实 macOS 目录选择；详见前述验收记录。这些数字不包含本文尚未实现的功能。

2026-10-06 施工进展：2A 导航、文本比较、自动刷新及 macOS 桌面本机链路已实现并验证，详见 [2A 证据](../../verification/v0.2-a.md)。2A-01 的跨平台/完整性能对照与 2A-04 的远程 CI、Codex 自动发现仍未全部验收，所以保留相关复合复选框；2B 和第三阶段未施工。
