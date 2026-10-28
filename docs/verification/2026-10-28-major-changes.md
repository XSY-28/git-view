# 重大变更阅读与历史日期验收

2026-10-28，macOS Apple silicon。本次按用户批准的方案增加独立文章标签页，并更新正式安装。

## 已验证

- `pnpm check`：最终源码类型检查、34 个测试文件 / 239 项测试与构建通过。
- `pnpm exec playwright test tests/e2e/articles.spec.ts tests/e2e/history-layout.spec.ts tests/e2e/reading-return.spec.ts tests/e2e/language.spec.ts`：16 项通过。最后两次图表修正后，文章两个端到端用例重新通过，类型检查和构建重新通过。
- `pnpm test:install-desktop`：27 项通过，安装单元测试使用系统注册和搜索进程替身。
- `pnpm update:desktop`：正式安装到 `~/Applications/Git View.app`；最终构建时间 `2026-10-28T08:07:58.431Z`（北京时间 16:07:58），宿主版本 0.3.0。旧安装由脚本归档为 ZIP，构建 `.app` 已清理，搜索服务刷新成功。未创建 GUI 测试副本。
- 在正式安装应用中，通过原生文件选择器为 本地 DSH 仓库 导入 `docs/examples/dsh-evolution.md`。有完整正文、表格、来源链接、9 个二级章节及 1 张 Mermaid 架构图，导入无警告；示例没有独立位图附件。
- 退出、更新并重新打开正式应用，DSH 文章仍可读；目录跳转、图表完整适配、100% → 125% 放大及关闭弹窗正常。文章链接可通过系统浏览器打开对应 GitHub 提交页，验收用浏览器标签已关闭。
- 历史行直接显示 `2026-10-17`，与本地 DSH HEAD `687f282e86` 的作者时间 `2026-10-17T15:22:43+08:00` 一致；无需展开详情。DSH 工作区保持干净。

存储测试验证移除来源后重启仍保留文章及中文相对路径图片、不同仓库隔离、主文选择、无效替换保留旧文、越界/缺失/外部图片警告。浏览器还验证图表错误不阻断正文、禁止原文 HTML/脚本执行、阅读位置恢复及窄窗口日期可见。

## 检查中发现并修复

1. Markdown 对中文图片路径编码，初版资源匹配失败；增加对应解码匹配，真实中文 SVG 导入和来源删除后重载通过。
2. 独立代码审查指出内联 Markdown 组件在导航和放大时被重新创建，导致图表重复加载。行为断言修复前记录到 12 次加载重现，稳定组件类型后为 0；审查复核关闭此问题。
3. 原生检查发现竖长架构图默认铺满宽度，难以看全；正文限制图表高度，弹窗初始按可用宽高适配整图，再允许放大。重新安装后观察到完整图与正常缩放。

## 实机截图

- [文章正文与目录](screenshots/major-changes-native-article.png)
- [正文中的架构图](screenshots/major-changes-native-diagram.png)
- [完整适配的图表弹窗](screenshots/major-changes-native-zoom.png)
- [直接显示日期的提交历史](screenshots/major-changes-native-dates.png)

## 边界

本轮未在 Windows 实机上重测，也未复测 Spotlight 搜索界面；安装脚本报告搜索进程刷新不等同于搜索 UI 验收。远程图片不自动下载，需先保存为资料目录内的相对图片。DSH 文章来自用户指定聊天，保留了原研究结论和验证边界，本次只调整标题并验证展示，没有重新进行 DSH 历史研究。文章截至 10 月 28 日的固定版本，本地 DSH checkout 截至 10 月 17 日，二者不自动绑定。

## 后续：替换文章弹窗焦点外框

按用户反馈，仅覆盖文章导入/替换弹窗按钮的 focus-visible 样式，去掉全局红色 outline，以已有浅色背景和中性边线表示焦点。文章两个端到端测试、27项安装测试通过；通过 pnpm update:desktop 再次更新正式安装，原生打开“替换文章”确认自动聚焦“选择 Markdown”时无红色外框。[实机截图](screenshots/major-changes-native-import-focus.png)。本次仍未复测 Spotlight 搜索界面。
