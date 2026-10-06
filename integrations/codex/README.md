# Codex 本地入口

当前安装器仍提供浏览器入口的 skill + 构建后的 CLI。安装目录自包含 CLI、HTTP 进程、网页及 macOS 原生文件夹选择器；仍需本机 Node.js 24、系统 Git 和浏览器，不依赖 Vite 开发服务器。不注册开机服务。

在项目根目录先构建，再安装。macOS 从源码构建需要 Xcode Command Line Tools（或完整 Xcode）；安装后的运行过程不需要 Swift 编译器，构建产物应与运行机器的架构一致。

```sh
pnpm install --frozen-lockfile
pnpm build
node integrations/codex/install.mjs
```

默认目录为 `~/.codex/skills/git-view`，安装器不会覆盖已有目录。可指定 `--dest /absolute/temporary/skill-directory` 测试安装。重开 Codex 会话，让它发现 `git-view` skill。入口按明确的当前 worktree 执行 `open`，再执行 `inspect`；纯状态查询只执行 `inspect`。

终端直接使用：

```sh
node dist/cli.mjs open --repo /absolute/repository --view changes --json
node dist/cli.mjs inspect --repo /absolute/repository --json
node dist/cli.mjs shutdown --json
```

`--repo` 必须是绝对路径，允许仓库子目录；包含空格时按 shell 规则引用。`open` 返回不带授权票据的 URL；`launchStatus=requested` 表示系统接受了打开请求，不代表页面已渲染。`--no-browser` 仅用于无界面验证，会返回 `launchStatus=skipped`，不签发票据。

首次页面使用 fragment 中 60 秒内有效的一次性票据换取 HttpOnly、SameSite=Strict cookie。票据立即由前端清除；禁止将含票据的实际启动地址粘贴给模型或写入日志。页面刷新沿用 cookie，实例重启后重新执行 `open`。只有 `inspect` 时不会打开浏览器。stdout 的 JSON 不包含源码或 diff；错误退出非零，保留错误码。

应用数据默认在 `~/.local/share/git-view`，可用 `GIT_VIEW_HOME` 指定测试目录。目录权限为 0700，运行时令牌与最近列表文件为 0600。最近列表只含本机 worktree 路径、身份和打开时间，不保存源码。没有页面心跳或 CLI 请求 30 分钟后进程退出。

卸载：先执行已安装目录下的 `bin/git-view shutdown --json`，再仅删除已确认的 `~/.codex/skills/git-view` 目录。需要一并删除最近记录时，再删除 `~/.local/share/git-view`；不要删除其他 skills。更新前也应先关闭旧实例并删除旧安装目录后重装。

此文件说明安装流程；真实 Codex 会话发现、调用和浏览器可见结果的验证状态见项目 `docs/verification/`，不能用安装成功代替端到端验收。


## 桌面 CLI 接入

2A 新增的原生包另有独立 CLI，不需要外部 Node：

```sh
"/absolute/path/Git View.app/Contents/MacOS/git-view-desktop" open --repo "/absolute/repository" --view changes --json
"/absolute/path/Git View.app/Contents/MacOS/git-view-desktop" inspect --repo "/absolute/repository" --json
```

`open` 复用原生窗口并立即给出请求收据；`inspect` 在创建 GUI 之前读取同一核心并退出。不向渲染层发 HTTP 票据，也不发送源码到模型。关闭窗口退出桌面宿主；旧安装 skill 中的 `shutdown` 仅适用于上述浏览器进程，不能直接替换为原生 CLI 后继续调用该命令。

本轮在 Codex 当前会话直接调用临时安装副本，验证 CLI、原生 GUI 和子进程恢复；没有向全局 skills 写入安装，也没有验证新会话的自动发现/触发。下一次 skill 安装器适配应显式区分宿主及退出方式，保持此项未完成，不能把 CLI 返回成功等同完整 Codex 集成。详见 [2A 验收](../../docs/verification/v0.2-a.md)。
