# Git View

[中文](README.md) · [English](README.en.md)

[![Source checks](https://github.com/XSY-28/git-view/actions/workflows/check.yml/badge.svg)](https://github.com/XSY-28/git-view/actions/workflows/check.yml) · [MIT License](LICENSE)

Git View 是一个本地 Git 图形工具，用于查看文件差异、浏览提交历史、比较版本，以及阅读项目演化文章。支持整文件暂存、提交和本地分支操作，写入前需要预览确认。

支持中文和英文界面，通过本机 Git 读取仓库，无需连接远程服务。目前为桌面预览版，提供 macOS Apple silicon 和 Windows x64 安装包。

![提交历史与文件差异，浏览器中的演示仓库](docs/verification/screenshots/history-simplification-browser.png)

## 功能

| 视图 | 功能 |
| --- | --- |
| 当前改动 | 分开查看已暂存、未暂存改动和未跟踪文件；差异支持单列、并排和折行。 |
| 历史 | 浏览提交关系图，直接查看作者日期，按分支或标签筛选，查看每次提交的文件差异。 |
| 版本比较 | 比较两个分支、标签或提交，查看两侧独有提交；可选择两端直接比较或从共同祖先比较到 B。 |
| 重大变更 | 为当前仓库导入一篇 Markdown 演化文章，阅读目录、表格、Mermaid 图表和本地配图；图表支持放大。 |
| 历史查询 | 按提交标题、作者、提交 ID 或文件路径搜索；查看文件历史、行来源（`git blame`）、stash 和 reflog。 |
| 仓库操作 | 按文件暂存或取消暂存，提交已暂存内容，创建和切换本地分支。 |

在历史侧栏选择分支只会筛选历史。创建或切换分支使用顶部的当前分支入口；创建后仍留在原分支，切换要求工作区干净。

历史列表会直接显示日期，方便对照文章中的时间。这里用的是作者日期，按本机时区显示；悬停可以看完整时间。提交仍按原来的关系排列，不会因为加了日期就重新排序。

## 用文章了解项目的演化

一个项目发展到今天，可能已经很复杂了。但回头看，它往往是在不断遇到问题、做出选择的过程中，逐渐变成现在这个样子的。我想了解的就是：当时遇到了什么问题，为什么要这样改，又付出了什么代价。

所以我加了“重大变更”这一栏。可以先让 AI 根据 Git 历史整理一篇文章，再把文章导入 Git View。先读懂主要变化，需要对照时再切到历史页，不必一开始就逐行看代码。文章的内容和判断仍需要核实，Git View 负责把它显示出来。

建议搭配 **[“航母是怎样建成的”](https://github.com/XSY-28/learning-skills#how-an-aircraft-carrier-is-built)** skill（`evolutionary-understanding`）使用：让 skill 根据项目的 Git 历史梳理关键设计变化，解释当时的问题、选择和代价，再将输出保存为 Markdown，导入“重大变更”。skill 负责整理和解释，Git View 负责阅读展示；也可以导入自己编写或通过其他方式整理的文章。

![在 Git View 中阅读 DSH 的演化文章](docs/verification/screenshots/major-changes-native-article.png)

用法很简单：

1. 打开仓库，进入“重大变更”，点击“导入文章”。
2. 选择 Markdown 文件；如果有配图，就选择文章和图片所在的文件夹。文件夹里有多篇文章时，再选主文章。
3. 按目录阅读。表格和 Mermaid 图表会正常显示，图片和图表可以点开、放大。

文章与配图会保存到本机，原文件移走或应用重启后仍然能读。每个仓库先放一篇文章，后面要更新就用“替换文章”；切换到历史再回来，会保留阅读位置。这里有一篇 [DSH 的例子](docs/examples/dsh-evolution.md)，可以直接下载试读。

> “重大变更”和历史列表日期已在当前源码中实现，公开的 v0.3.0 安装包还不包含这两项功能。现在使用需要[从源码构建](#从源码构建macos)。

<details>
<summary>文章格式与限制</summary>

使用 UTF-8 Markdown，标准标题生成目录，Mermaid 代码块在本机绘图。配图支持 PNG、JPEG、GIF、WebP 和 SVG，使用资料文件夹内的相对路径；网络图片需要先保存到本地。正文上限 512 KiB，单图上限 4 MiB，配图总大小上限 6 MiB。

关联的 worktree 共用文章。缺失图片或图表语法错误会单独提示，不影响继续读正文；导入失败时保留原文章。文章里的日期按原文展示，不自动绑定到某次提交。

文章阅读已在 macOS 正式安装应用中检查，Windows 实机尚未复测。具体过程见[验收记录](docs/verification/2026-10-28-major-changes.md)。

</details>

## 安装

在 [GitHub Releases](https://github.com/XSY-28/git-view/releases/latest) 下载当前版本的安装包和 `.sha256` 校验文件，无需登录 GitHub。两种包都自带 Node 运行时，使用时只需系统 Git，无需另装 Node、pnpm 或 Rust。

- **macOS Apple silicon**：下载 `macos-arm64.dmg`，打开后先退出 Git View，再双击 **Install Git View.command**。安装位置固定为 `~/Applications/Git View.app`，旧版本保留为 ZIP；完成后弹出磁盘映像。不要再复制一份到 `/Applications`。
- **Windows x64**：下载 `windows-x64-setup.exe`，运行安装向导，再从开始菜单打开。需要 Git for Windows 与 WebView2；缺少 WebView2 时安装程序会下载运行时。Windows 桌面应用支持暂存、取消暂存、提交、创建和切换分支。

当前包尚未代码签名或 Apple 公证，系统可能提示无法验证发布者。确认下载来源后，使用系统提供的“仍要运行”或“隐私与安全性 → 仍要打开”入口，不要关闭系统安全机制。完整步骤与校验、卸载说明见[安装包说明](docs/INSTALL.md)。

### 从源码构建（macOS）

构建需要 Git、Node.js **24.19.0**、pnpm **11.7.0**、Rust 和 Xcode Command Line Tools。CI 使用 Rust 1.99.0。

先退出正在运行的 Git View，然后执行：

```sh
git clone https://github.com/XSY-28/git-view.git
cd git-view
pnpm install --frozen-lockfile
pnpm build
pnpm build:desktop
pnpm install:desktop --dry-run
pnpm install:desktop
open "$HOME/Applications/Git View.app"
```

`--dry-run` 只检查安装条件。应用固定安装到 `~/Applications/Git View.app`，旧版本保存为 ZIP；安装器会清理本次构建副本。

安装后的应用自带 Node 运行时，仍需系统 Git。运行应用不需要另装 Node、Rust 或 Swift。

> ⚠️ 桌面包目前未公证。

打开应用后，按 `⌘O` 或点击 **打开仓库… / Open repository…**，选择本地 Git 仓库。也可以在仓库切换器中手动输入绝对路径。

点击文件查看差异，勾选文件后才会加入暂存操作的范围。已暂存改动比较 HEAD 与暂存区，未暂存改动比较暂存区与工作文件。提交只使用暂存区内容。

<details>
<summary>演示仓库</summary>

在项目根目录运行：

```sh
node scripts/create-demo.mjs
```

脚本在临时目录创建仓库并输出绝对路径，不修改已有仓库。将输出路径填入应用的手动路径入口即可打开。

演示中的 `hello.txt` 已暂存后又被修改，因此会同时出现在已暂存和未暂存列表中，两项分别显示各自的差异。

</details>

## 更新

安装包用户退出 Git View 后，下载新版本并重新安装即可。macOS 会将旧版本备份为 ZIP。

从源码更新的 macOS 用户退出 Git View 后，在项目根目录运行：

```sh
pnpm update:desktop
open "$HOME/Applications/Git View.app"
```

`update:desktop` 完成构建和安装；如果已经构建，可使用 `pnpm install:desktop`。备份恢复及 Spotlight 重复入口的处理见[桌面安装说明](docs/verification/2026-10-06-desktop-install.md)。

## 支持范围

macOS Apple silicon 已有桌面实机验证。Windows 通过 CI 验证实际安装、原生窗口及仓库操作；Windows 10/11 实体电脑尚未复测。详见[安装包验收记录](docs/verification/2026-10-07-windows-operations.md)。

- 暂不提供 push、merge、rebase 或历史重写。远程跟踪引用来自本地仓库，不会自动获取远端更新。
- 暂存按整个文件操作，不支持选择差异行或片段。写入限常规仓库和 index；冲突、进行中的 Git 操作、submodule、特殊 index 或外部内容过滤器会被拒绝。支持 Git 内置的 `text`、`eol` 和 autocrlf 换行转换；暂不支持 `ident` 和 `working-tree-encoding` 转换。
- 提交保留仓库的 hooks 和签名设置，切换分支会运行已配置的 hook；确认页会要求授权。预览后仓库状态改变时，需要重新预览。
- 二进制、非 UTF-8、超过 1 MiB 或 10,000 行的内容不展开文本预览。不支持裸仓库、partial clone/promisor 仓库；使用外部 clean/process 过滤器时不扫描工作区。

文件历史沿第一父链追踪普通重命名，行来源对应已提交版本。reflog 仅支持 files 引用存储；stash 和 reflog 提供查看，不提供恢复或删除操作。共同祖先比较要求能确定唯一共同祖先。

具体边界与验证结果见[暂存](docs/verification/2026-10-06-stage-files.md)、[提交与分支](docs/verification/2026-10-06-commit-branches.md)、[版本比较](docs/verification/2026-10-06-revision-comparison.md)和[历史查询](docs/verification/2026-10-07-history-investigation.md)文档。CI 通过不代表所有平台的原生界面都已验收。

## 浏览器与 CLI

macOS 上也可以使用浏览器入口。它需要本机 Node.js 24、Git 和浏览器；在项目根目录安装依赖并执行 `pnpm build` 后运行：

```sh
node dist/cli.mjs open --repo "/absolute/path/to/your/repository" --json
```

将路径替换为实际仓库的绝对路径。`pnpm open` 打开当前项目仓库；服务只监听 `127.0.0.1`。更新构建后先执行 `pnpm stop`，再重新打开。

只查询仓库概览：

```sh
node dist/cli.mjs inspect --repo "/absolute/path/to/your/repository" --json
```

桌面 CLI 和 Codex 接入见[本地入口说明](integrations/codex/README.md)。语言设置、最近仓库和运行信息默认保存在 `~/.local/share/git-view`，可用 `GIT_VIEW_HOME` 指定其他目录。

## 开发

在项目根目录安装依赖后运行：

```sh
pnpm check
pnpm exec playwright install chrome
pnpm test:e2e
pnpm test:install-desktop
```

`pnpm check` 包含编号副本检查、类型检查、源码测试和构建。安装测试适用于 macOS；测试仓库使用临时目录，系统注册与搜索服务操作使用替身。

桌面开发使用上述 `pnpm update:desktop` 安装，并从固定路径打开应用。CI 或仅生成发布包时使用 `pnpm build:desktop`。

实现说明见[核心架构](docs/decisions/0001-implementation-baseline.md)、[桌面宿主](docs/decisions/0002-desktop-host.md)和[维护约定](docs/decisions/0005-maintenance-contracts.md)。

欢迎通过 [Issues](https://github.com/XSY-28/git-view/issues) 报告问题，或提交 Pull Request。问题报告请包含平台、版本、复现步骤和预期结果，日志与截图中请移除私人信息。

## 许可证

[MIT](LICENSE)。桌面包随附 [Node.js 运行时许可](apps/desktop/licenses/node-v24.19.0-LICENSE)，第三方依赖保留各自许可证。
