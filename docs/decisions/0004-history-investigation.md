# 历史调查的固定对象与本地记录

2026-10-07。第五批提供提交搜索、文件历史、行来源和 stash/reflog 查看。各入口复用只读 Git 核心，不新增命令执行器或写权限。

## 查询语义

| 入口 | 查询对象与范围 |
| --- | --- |
| 提交搜索 | HEAD、一个完整引用或本地分支/标签/远程跟踪引用的固定 tips；按标题、原始作者姓名/邮箱、提交 ID 前缀或精确路径查询 |
| 文件历史 | 固定提交的第一父链，跟踪单一路径的普通重命名；每条记录保存当时的新旧路径及实际第一父基准 |
| 行来源 | 所选记录比较前或后的完整文件；使用该侧的固定提交和路径，展示最终行号及原始提交中的路径、行号 |
| stash | 本地 stash 引用记录所指对象；分别比较第一父基准 → 工作区快照、基准 → 暂存区快照、空树 → 未跟踪快照 |
| reflog | files ref storage 的本地原始日志；保留 old/new OID、操作者、记录时间和消息，允许查看新提交或比较两端 |

标题和作者按字面字符串忽略大小写匹配，标题搜索不把正文匹配当成标题结果。文件路径是精确的仓库内相对路径，保留空格、制表符及换行，不解释为 glob 或 revision 表达式。搜索路径不自动追踪旧名；文件历史承担重命名追踪。

`immutable.ts` 集中处理受限端点解析、原始提交对象、浅历史边界、树差异与 blob 存在性。比较、历史调查及打开提交详情共用该边界，禁用 refs/replace，不以当前工作文件补齐对象内容，也不运行内容过滤器、textconv、外部 diff 或隐式下载。首次提交使用空树基准，删除文件仅提供比较前的行来源。

行来源使用 Git 的实际祖先追踪，不把文件历史列表的第一父范围误当作作者来源范围。元数据使用提交原始作者，避免工作区 `.mailmap` 改写显示身份。它描述 Git 记录的最后一次行来源，不推断逻辑作者或工具归因。

本地 reflog 读取 HEAD 时使用当前 worktree 的 Git 目录；普通引用和 stash 使用 common Git 目录。文件必须是 Git 目录内的普通文件，读取前后核对变化，不接受任意路径。未启用/过期的日志、缺失对象和非提交对象明确保留其状态。序号是观测时的名称；记录身份根据原始记录生成，追加记录不改变既有记录身份。

## 状态和预算

- contracts 定义七个窄查询、输入校验和结果；不暴露任意 Git 参数。新结果进入已有 stdio 与本地 HTTP 接口。
- Git 适配器按固定观测保存分页，游标绑定查询、worktree 和观测。预算集中于 `ReadLimits` 与 `INVESTIGATION_LIMITS`：默认每页 200 条、最多 20,000 条候选记录；最多 16 份观测，单份 8 MiB、合计 32 MiB。命令输出沿用 16 MiB 上限。
- core 只授权当前会话实际收到的文件/记录和 stash 详情中的条目。刷新、仓库写入和会话关闭清除授权；迟到结果不能重新写入授权缓存。
- UI 按 search/file/records 拆开，共用 `useInvestigationReads`、RequestGate、ReadFeedback、ChangeList 和 DiffView。RevisionPicker 在版本比较与文件历史之间复用。
- 请求成功、错误、分页均核对 session/generation/queryKey/requestId。刷新重新加载此前已展开的页数，保持仍存在的选择；取消或失败保留带过期状态的旧内容。用户已取消时，焦点刷新不擅自恢复查询。
- 输入按 worktree 保存，结果不跨会话复用。从差异进入文件历史使用差异的固定版本及原始路径；从 reflog 比较使用记录中的两端 OID。

## 明确的限制

文件历史只覆盖第一父链的普通重命名，不承诺所有合并来源及复制追踪。浅历史及候选数量上限通过 `complete` 和警告展示。行来源限于已提交的普通 UTF-8 文本，最多 1 MiB/10,000 行；符号链接、二进制和不可用对象不伪造内容。

reftable 等引用存储暂不支持本地记录查看，会明确报错。reflog 不是完整命令审计，记录仍存在不保证其对象永远存在。stash 只查看保存的版本，不提供 apply/pop/drop。上游 ahead/behind、任务起止基线、图片/LFS 预览和历史重写不属于第五批。

语义依据：[Git log](https://git-scm.com/docs/git-log)、[Git blame](https://git-scm.com/docs/git-blame)、[Git stash](https://git-scm.com/docs/git-stash)、[Git reflog](https://git-scm.com/docs/git-reflog)。本机证据见[第五批验证](../verification/2026-10-07-history-investigation.md)。
