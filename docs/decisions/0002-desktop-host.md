# ADR 0002：Tauri 薄壳与随包 Node 查询进程

日期：2026-10-06。状态：macOS Apple silicon 原型验证通过，采用此宿主；验收结果见本文最后一节及 `docs/verification/v0.2-a.md`。

## 目标与边界

安装后的用户无需另装 Node 即可双击窗口、选择仓库，并通过原生 CLI `open` / `inspect` 调用现有只读核心。系统 Git 仍是依赖。浏览器入口继续保留；桌面宿主不复制 Git 语义，不暴露通用文件系统或 shell 能力给渲染层。

## 决策

采用 Tauri 2 原生窗口，打包同一构建机器的 Node 24 可执行文件和 esbuild 产物 `stdio.mjs`、`inspect.mjs`。渲染层调用 `query(message)`；Rust 仅管理窗口、原生目录对话框、固定查询子进程的 stdin/stdout、单实例与退出。

- Rust 的资源路径、协议版本、限额与超时集中在 `src/config.rs`；应用身份、窗口尺寸和资源映射集中在 Tauri 配置。没有 Rust Git runner。
- macOS 窗口开启 `acceptFirstMouse`，允许首次点击同时激活窗口并执行只读选择。此配置单独复测仍未解决首次点击无选择的问题，不能据此宣称根因已修复。后续观察到焦点刷新在旧结果上方插入加载提示，导致文件行在按下和抬起之间位移；网页改为保留旧结果布局并固定后台状态位置，定向 E2E 验证了 pending 时边界框不变及旧坐标抬起可完成选择。最终原生安装副本已复测，首次点击可完成选择并显示正确比较；请求身份门禁继续保留。
- 子进程固定执行随包 `runtime/node` 与 `app/stdio.mjs`，不从 PATH 找 Node。stdout 为逐行 JSON；stderr 不转发给页面，避免诊断意外泄露本地内容。
- 请求信封为 `{id,operation:'request',request}`、`{id,operation:'session',sessionId}`、`{id,operation:'cancel',targetId}` 或 `{id,operation:'watch',sessionId}`。结果为 `{id,response}`，共享 TypeScript schema 在 Node 边界验证业务输入输出。
- pending 映射按信封 ID 关联；Rust 子进程代次隔离旧退出回写。stdout 断开、非法 JSON、协议版本不兼容或子进程退出会拒绝该代全部未完成请求；下一次查询重新启动进程。超时请求移出 pending 并发送对应 cancel，晚到结果不回写。
- `pick-folder` 只在 Rust 调用原生 dialog，返回共享 FolderChoice。取消返回 `{cancelled:true}`，不触发仓库切换。渲染层没有 dialog/fs/shell 插件权限。
- CLI `open` 派生同一原生可执行文件的独立 GUI 进程并立即返回，防止 harness 被窗口寿命阻塞。首次打开路径通过一次性 `initial_repository()` 交付；已运行实例使用 `open-repository` 事件并聚焦窗口。页面先注册事件再取初始路径，避免启动事件丢失。CLI 的 `open --json` 是打开请求收据，明确 `rendered:'unverified'`，实际读取由窗口验证。
- `inspect` 在创建任何 Tauri builder、窗口或 dialog 前直接执行随包 Node 的无窗口入口，然后退出。启动 URL 不携带 HTTP token。
- 单实例使用官方插件的 semver 隔离，不兼容产品版本分别启动；macOS 创建 socket 前设置 umask 077，限制当前用户访问。窗口退出或协议失败先关闭子进程 stdin，让 Node 的 EOF 处理取消读取并清理 watcher；最多等待 2 秒后回收进程树。Unix 使用独立进程组，Windows 使用 `KILL_ON_JOB_CLOSE` Job Object。Windows 路径尚无实际运行证据。

## 取舍

Electron 同样可以复用 TypeScript 核心，并且避免 Rust 桥接与两种工具链；代价是同时分发 Chromium 和 Node。Tauri 使用系统 webview，但随包 Node 仍有体积与进程成本，并且需要真实验证原生对话框、退出和资源定位。当前实现选择先验证 Tauri 最小链路；没有同时维护 Electron 外壳，也没有据此声称更快、更小或更省内存。

继续采用 Tauri 的条件是：临时安装副本可独立运行、无外部 Node/开发服务器依赖、CLI 和 GUI 共享语义、原生取消/复用/重启恢复/正常退出验证通过。任一分发或生命周期问题无法合理修复时，记录失败证据后再评估 Electron。整套 Git 核心改写为 Rust 不属于本次范围。

## 构建与安装检查

```sh
pnpm build
node scripts/build-desktop.mjs
node scripts/verify-installed.mjs --app "apps/desktop/src-tauri/target/release/bundle/macos/Git View.app" --output /tmp/git-view-installed-verification.json
```

构建脚本先准备固定资源，再运行锁定的 Tauri CLI。Rust 已按 Cargo.lock 固定；本机工具链缓存位于忽略的 `.tooling/`，未修改全局 shell profile。已有全局/CI Rust 时使用其环境。

安装检查复制到临时中文/空格目录，只在临时仓库建立 V1/V2/V3 部分暂存夹具，检查无窗口 inspect、错误仓库、随包 stdio/EOF 清理和仓库内容指纹。自动检查不替代原生 GUI 验收。应用状态默认存于用户私有应用目录，卸载时仅移除安装副本及用户明确指定的应用状态目录，不删除仓库。

源码和包构建 CI 为 macOS ARM、macOS Intel、Windows 分别配置；源码检查后才打包，包检查再运行同一安装脚本。macOS 保留完整单元/集成及浏览器 E2E；Windows 跑 core/Git/stdio 与 Rust，并明确排除 POSIX 权限模型的旧 HTTP transport 集成测试。Windows 浏览器 HTTP fallback 当前不支持，不通过删除权限检查来降级鉴权；桌面 stdio 无网络 token，走自己的真实测试。当前 CI 文件存在不代表这些 runner 已运行。Windows 的 NSIS 产物与 portable CLI 检查分别记录，不能将便携副本运行解释为 NSIS 安装/原生窗口已验证。

构建资源内 `build-info.json` 记录版本、平台、Node 和 SHA-256。包为开发测试产物，没有 Developer ID 签名、公证、系统信任或正式发布声明；Tauri 的本地 ad-hoc 签名若存在只用于本机执行。

## 本次证据

- 已验证：Apple silicon 上 Rust 1.99.0 的 `cargo check` 成功，Tauri 2.12.1、dialog 2.8.1、single-instance 2.5.2 已进入 Cargo.lock。
- 已验证：最终原生 `.app` 打包成功（239.68 MiB），安装副本的 Node 许可声明、资源 SHA-256、独立 inspect、中文/空格路径、V1/V2/V3 部分暂存计数、无效仓库错误、仓库内容指纹和 stdio EOF 清理均通过，报告为 `docs/verification/installed-v0.2-a.json`。原始本机 Node 为 universal 二进制，不能用这一结果推断 Tauri 比 Electron 更小。
- 已验证：4 个 Rust 进程监督测试覆盖并发乱序身份、崩溃拒绝未完成请求及重启、非法 JSON/旧协议拒绝、stop 回收；真实 Git 的 `hash-object --stdin` 保持运行后关宿主，在正常 EOF 及 Node 故意忽略 EOF 两种路径中均无遗留 Git。它们验证宿主机制，不代替窗口走查。
- 已核对：本机产物仅 linker ad-hoc 签名，`TeamIdentifier` 未设置，无 Developer ID、公证或 sealed resources。
- 已验证：临时安装副本的原生 GUI、目录选择/取消、重复 open 复用窗口、外部修改自动更新、查询进程崩溃后重新打开恢复、重启最近仓库和正常退出清理；详细过程见 v0.2-a 验收记录。
- macOS Intel、Windows 源码/安装/GUI、Developer ID 签名、公证、发布：未验证或未执行。

参考：[Tauri 配置](https://v2.tauri.app/reference/config/)、[单实例插件](https://v2.tauri.app/plugin/single-instance/)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)。参考文档说明机制；上面的运行结论只依赖本项目实际证据。

最终原生首击复测（2026-10-06）：仅开启 `acceptFirstMouse` 时仍复现，主因是焦点刷新插入状态条使目标行在鼠标按下/抬起之间移位。最终网页改为固定状态槽，并保留已有历史列表；真实安装副本首次点击已选中目标并显示正确 V2→V4。该结果与纯浏览器的旧坐标点击回归互相补充。
