# 2026-10-07 维护改进验收

## 结果

- 35 个未跟踪编号副本已归档到项目之外并移出项目：28 个字节相同，7 个内容不同。归档包含全部副本、整理前文本快照、7 份完整差异及 SHA-256 清单；最终复核 35/35 副本哈希一致，原副本路径全部不存在。
- TypeScript 配置解析确认编号副本从 27 个降为 0 个。没有用 exclude 隐藏它们。副本检查接入 typecheck，现有 CI 中的 typecheck 入口会执行检查；本次未运行远端 CI。
- 七类视觉节点在浏览器测试中的 214 处旧类名引用已迁移为角色或测试 ID 定位，最终旧引用为 0。其余样式选择器仍按实际问题渐进改进。
- 大范围“不能含中文”断言已替换为应用控件具体英文名称和选项检查。真实 Git 样本包含中文代码和 stash 内容，英文下仍显示原文。
- Resource 定义集中到 state/resource.ts，运行时读取转换和请求身份检查保持原有行为。状态模型与暂不拆分 App 的依据见 [维护契约决策](../decisions/0005-maintenance-contracts.md)。

## 执行证据

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过，含副本守卫的 1 项测试及实际目录扫描 |
| `pnpm test` | 31 个文件、224 项通过 |
| `pnpm build` | 通过；仍有大于 500 kB 的资源体积提示，无构建错误 |
| `pnpm test:e2e` | 80 项中 79 项通过；1 项新断言把现有英文 `commit ID` 误写成 `Commit ID`，导致失败 |
| `pnpm exec playwright test investigation.spec.ts -g 'cancels and retries'` | 修正断言后，该项单独复测通过（1/1）；不是声称重新完整跑了一遍 80 项 |
| 视觉类名重命名验证 | 通过（20/20），包括上面修正后的语言用例 |
| `git diff --check` | 通过 |
| 最终归档及构建检查 | 35 份副本哈希一致；七类旧选择器引用与大范围中文排除断言均为 0；普通构建恢复，临时类名不存在 |

## 类名重命名验证方法

本次归档中的 locator-resilience.mjs 通过 Vite 临时转换 JSX 类名、对应 CSS 和应用内部 DOM 查询，同时重命名 repository-title、commit-row、history-scroll、code-scroll、navigation-ref、navigation-recent、investigation-view，保留角色及测试 ID。

对这个临时构建运行 navigation、refresh-scroll、investigation、revision-comparison 四个 spec，共 20 项，全部通过。该方法验证本次迁移覆盖的类名，不代表所有剩余选择器均能承受任意 DOM 重构。转换只作用于构建输出，脚本在 finally 恢复普通 dist/web 并回收临时目录；最终也检查了恢复结果。

浏览器回归使用真实临时仓库，覆盖刷新后的滚动和展开状态、失败和取消后的旧内容、迟到成功与错误拒绝、仓库切换、比较分页与语言切换。源码测试的 Git 写入及浏览器测试的 Git 写入都限于各自的临时仓库。

## 范围

上述维护阶段完成源码与测试整理，当时没有暂存、提交或推送文件，也没有构建或安装新的桌面包。后续阅读返回与固定安装版走查见[阅读返回验收](2026-10-07-reading-return.md)；桌面安装路径与相关脚本未改变。

## GitHub 同步前复核

在合并上述维护与阅读返回修改、同步 README 后，重新执行完整检查：

| 检查 | 结果 |
|---|---|
| `pnpm check` | 通过：副本守卫 1 项及目录扫描、类型检查、31 个文件 225 项源码测试、Web/CLI/stdio 构建 |
| `pnpm test:install-desktop` | 27 项通过；系统注册与搜索服务使用替身 |
| `pnpm test:e2e` | 完整 88 项通过，Chromium，3.5 分钟；包含阅读返回新增 8 项 |
| 公开内容检查 | 43 个变更文件未发现个人绝对路径或凭据形式文本；26 个文档相对链接均指向拟发布文件 |
| README 的 GitHub Markdown 渲染 | 通过：7 节、4 张表、4 张图及折叠入口正常生成 |

构建仍有大于 500 kB 的资源体积提示。本次同步前复核未重复构建或安装桌面包、未重复原生窗口走查，也未复测 Spotlight；原生证据沿用阅读返回记录，不能由浏览器回归扩展为 Windows 原生验收或 Spotlight 验收。远端 CI 的结果以对应发布提交的 GitHub Actions 为准。
