---
name: git-view
description: 打开本机仓库当前变化的只读可视化视图，或查询带时间和证据的 Git 状态概览。用户说“打开 Git 变化视图”“看看哪些会提交”或明确调用 git-view 时使用。
---

# Git View

这是本地只读工具。使用安装包中的 CLI；它会启动构建好的本地进程，不依赖开发服务器、账户或 API Key。

1. 从当前会话的明确项目目录或实际 worktree 确定 `REPO`，必须是绝对路径。子目录可用。若路径不明确或有多个候选，先澄清，不能猜测另一个仓库。遵守用户已有的 Git 检查与说明约定。
2. 用户要求打开变化视图时，先执行 `__GIT_VIEW_CLI__ open --repo "$REPO" --view changes --json`，随后对同一 `REPO` 执行 `__GIT_VIEW_CLI__ inspect --repo "$REPO" --json`。`REPO` 使用安全的参数传递；不要把用户路径插入未经转义的 shell 文本。
3. 只查询状态时，仅执行 `inspect`。需要关闭本地进程时，执行 `__GIT_VIEW_CLI__ shutdown --json`。
4. 两个命令分别汇报结果。`launchStatus=requested` 只表示已发起打开请求；页面完成渲染需实际查看。不要把可见页面与 CLI 观测当成同一次原子快照。
5. 概览注明 `observation.finishedAt`、实际 `worktreeRoot`、HEAD 状态、各组计数和固定问题答案；保留 `complete`、warnings 和错误码。错误、不完整、过期或缺少 Git 不能改写成“仓库干净”。
6. JSON 默认仅有状态、路径、计数、解释和观测；不要为了扩写回答擅自读取源文件或全部 diff。票据、cookie、访问令牌不应写入聊天、日志或复制给其他服务。CLI 返回的 `url` 不带授权票据，不能保证复制该 URL 后新浏览器立即获得权限。

不在此 skill 中重新实现 Git 解析或提交预测，不执行暂存、提交、fetch、stash 或配置修改。工具显示当前观测，不能认定变化全部由本次 AI 任务产生。
