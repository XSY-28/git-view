# 暖色主题验收

日期：2026-10-06。按用户要求参考 [Claude](https://claude.com/) 的暖黄白色调，具体色值为本项目自定义。此次只调整颜色和应用图标，保留现有布局与 Git 读取行为。

## 变更

- 在 [theme.css](../../apps/web/src/theme.css) 集中定义背景、面板、边框、文本、强调色、状态色及历史图颜色。奶油白背景、浅米色侧栏与陶土色图标贯穿仓库选择、差异、历史和读取反馈。
- 界面 SVG、复选框、选中态与 HEAD 标记使用主题变量。历史图仅替换颜色来源，布局与连线逻辑保持原实现。
- 增删差异、错误和警告保留各自的语义色，避免所有信息都变成同一种强调色。
- 桌面图标通过内置 imagegen 编辑现有位图，再由项目固定版本的 Tauri CLI 生成 PNG、ICNS 和 ICO。高分辨率[母版及完整提示词](../../apps/desktop/artwork/README.md)已保存。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过；`index-BkBsFav9.js` / `index-DNroTRJw.css` |
| `pnpm test:e2e` | 41 项全部通过，1.3 分钟 |
| `pnpm build:desktop` | macOS Apple silicon 构建成功；编译 30.58 秒，应用包 241.50 MiB |
| 发布资源 | 最终可执行文件包含上述 JS/CSS；包内 ICNS 与更新后的源资源逐字节一致 |

浏览器回归使用真实临时仓库，覆盖差异查看、历史导航、刷新反馈、键盘与窄窗口等原有流程。Git 测试写入仅发生于临时夹具，开发仓库未执行暂存、提交或推送。本次未重跑核心单元测试。

人工核对桌面与 390px 窄窗口截图：主题已覆盖主要界面，增删内容仍清晰区分，未观察到页面横向溢出。针对性对比度计算结果：选中背景上的次要文字、强调文字、警告及错误文字为 4.61–4.66；选中背景上的图标为 3.11；HEAD 标记文字为 6.04；增删差异文字分别为 5.52 和 5.13。这是指定色对核对，不代表完整无障碍审计。

最终应用复制到 `/private/tmp/git-view-warm-gui/Git View.app`，使用独立 `GIT_VIEW_HOME` 打开真实演示仓库。原生窗口中实际核对了当前修改、提交历史、初始提交差异、历史节点、HEAD 标记和复选框；WKWebView 正常显示暖色主题。测试窗口退出后进程返回 0。其他操作系统和架构未作实机核对。

## 截图

- [当前修改](screenshots/warm-theme-current-changes.png)
- [提交历史](screenshots/warm-theme-history.png)
- [窄窗口](screenshots/warm-theme-mobile.png)
