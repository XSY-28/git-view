# 安装 Git View 预览包

在 [GitHub Releases](https://github.com/XSY-28/git-view/releases/latest) 下载对应平台的安装包与同版本 `.sha256` 文件，无需登录 GitHub。开发构建也可从 [打包工作流](https://github.com/XSY-28/git-view/actions/workflows/package.yml) 的成功运行中下载 Artifacts ZIP（需要登录 GitHub）。当前目标平台为 macOS 13.5 及以上的 Apple silicon（arm64）和 Windows x64，尚不提供 Intel Mac、Windows ARM 或 Linux 安装包。macOS 下限由包内 [Node 24 的平台要求](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md#platform-list)决定。

## macOS Apple silicon

1. 确认系统 Git 可用，在终端执行 `git --version`。如果系统提示安装 Command Line Tools，按提示完成；使用安装包不需要 Node、pnpm、Rust 或完整 Xcode。
2. 下载 `Git-View_0.3.0_macos-arm64.dmg`。可在下载目录执行 `shasum -a 256 -c Git-View_0.3.0_macos-arm64.dmg.sha256` 核对文件。
3. 退出正在运行的 Git View，打开 DMG，双击 `Install Git View.command`。安装无需管理员权限，固定安装到 `~/Applications/Git View.app`，完成后自动打开应用。
4. 安装完成后弹出 DMG。不要把另一份 Git View.app 放在 `/Applications`，也不要保留解压的备份应用；这样能避免多个同名搜索入口。

安装程序从磁盘映像中解压到临时目录，用包内 Node 启动项目现有安装脚本。它校验应用身份和资源哈希、备份旧安装、检查运行状态、安装到固定路径、回收临时应用、清理注册并刷新搜索服务。磁盘映像中只保留压缩的应用，不会出现可被 Spotlight 注册的第二份 `.app`。

已有版本备份到 `~/Library/Application Support/Git View/backups`，格式为 ZIP。安装中发生错误时保留现有恢复机制；错误会显示在终端中。注册与搜索进程检查不能证明 Spotlight 面板结果正确，需要重新搜索确认。安装程序不会自动停止你正在使用的应用。

当前包未做 Apple Developer ID 签名或公证。系统拦截时，先确认下载来源，再用“系统设置 → 隐私与安全性 → 仍要打开”。安装命令和应用可能分别触发检查；不要通过关闭 Gatekeeper 绕过。

卸载时先退出应用，再删除 `~/Applications/Git View.app`。若也想删除设置和备份，另行删除 `~/.local/share/git-view` 和上述备份目录；不要删除你自己的 Git 仓库。

## Windows x64

1. 安装 [Git for Windows](https://gitforwindows.org/)，确保新开的终端中 `git --version` 能成功。
2. 下载 `Git-View_0.3.0_windows-x64-setup.exe`。用 PowerShell 执行 `Get-FileHash .\Git-View_0.3.0_windows-x64-setup.exe -Algorithm SHA256`，与同版本 `.sha256` 文件中的哈希比较。
3. 运行安装向导。应用安装到当前用户目录，不要求管理员权限；缺少 Microsoft WebView2 时安装程序会下载运行时，因此首次安装可能需要联网。
4. 从开始菜单打开 Git View，点击顶部打开仓库按钮选择本地仓库，或展开“手动输入路径”填入仓库的完整路径。

Windows 桌面应用支持查看和预览确认后的暂存、取消暂存、提交、创建和切换本地分支。写入使用安装包内的原生组件；仅使用 Node CLI 不提供 Windows 写入。Git 内置 CRLF/text/eol 转换受支持；外部过滤器、ident、working-tree-encoding 和未启用符号链接的含符号链接仓库仍会拒绝写入。浏览器 HTTP 备用入口暂不支持 Windows，请使用桌面应用。

当前 EXE 未做代码签名，Windows 可能显示未知发布者或 SmartScreen 提示。仅在核对 GitHub 下载来源和哈希后使用系统提供的“更多信息 → 仍要运行”入口，不要关闭 SmartScreen。若设备的组织策略禁止未知发布者，需要遵循该设备的策略。

卸载使用“设置 → 应用 → 已安装的应用 → Git View → 卸载”。应用设置默认在用户主目录的 `.local\share\git-view`，卸载不会自动删除你的仓库。

## 构建与验收边界

包构建工作流分别在 macOS ARM 与 Windows x64 runner 上执行类型检查、适用的真实 Git 测试和 Rust 宿主测试，再构建安装包。

- macOS：验证 DMG 完整性和挂载、执行包内安装程序 dry-run，并对从 DMG 解压出的内容验证内置 Node、中文/空格路径、仓库只读指纹和 stdio 退出。原生 GUI 在本机固定安装路径验收。
- Windows：运行真正的 NSIS 静默安装到包含中文和空格的目录，对安装结果做包内运行检查；启动安装后的 release 应用，用 WebView2 调试连接驱动真实窗口和 Tauri IPC，检查打开中文路径仓库、暂存/未暂存差异、历史差异、CRLF 文件的暂存与取消暂存、提交、创建与切换分支、正常关闭与 Node 子进程回收，最后卸载。

这些检查的通过与失败以该版本对应的 GitHub Actions 和随包验证报告为准。Windows runner 是 CI 系统，不能替代所有 Windows 10/11 实体电脑上的验收；SmartScreen、Gatekeeper、人工安装向导和原生系统目录选择对话框也需要目标设备复测。当前安装包没有自动更新机制。
