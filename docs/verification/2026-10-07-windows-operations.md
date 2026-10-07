# Windows 仓库操作与 0.3.0 安装包验收

0.3.0 为 Windows x64 桌面应用增加整文件暂存、取消暂存、普通提交、创建本地分支及切换分支。所有操作仍先预览，再由用户确认；提交和分支操作另须明确允许仓库 hooks 与签名程序。

## 实现与验证对象

- Windows 回执目录使用当前用户、SYSTEM 和 Administrators 的受限 ACL，拒绝重解析路径和额外的允许访问规则。使用原生文件替换发布回执和 index，不调用 POSIX 目录 fsync。
- Git 内置 autocrlf/text/eol 转换使用预览时捕获的配置和属性，在隔离的临时 Git 元数据中运行；拒绝外部过滤器、ident 和 working-tree-encoding。
- Git/hooks/签名程序在启动执行前加入 Windows Job Object；超时、输出超限和宿主退出时回收进程树。
- 真实仓库测试检查 CRLF 与中文路径、未选中内容保留、重复请求、过期预览、锁冲突、权限拒绝、提交及分支操作，以及进程被强制终止后的结果恢复。
- 安装验收用 NSIS 实际安装，再通过 WebView2 驱动安装后的 release 原生窗口，完成查看、五种写入操作和正常退出；检查实际 Git 内容与分支状态，最后卸载。

## 验收证据

最终构建的来源提交、安装包 SHA256 和各检查结果以同版本发布资产中的 `release-verification.json`、平台包报告及原生窗口报告为准。源码和安装包工作流：[Source checks](https://github.com/XSY-28/git-view/actions/workflows/check.yml)、[Desktop packages](https://github.com/XSY-28/git-view/actions/workflows/package.yml)。

## 边界

Windows CI runner 的真实安装和原生窗口验收不能替代所有 Windows 10/11 实体电脑测试。Windows ARM、Intel Mac 和 Linux 安装包、签名、公证、自动更新、人工系统警告与文件夹选择器验收均不在本次结果中。Windows 浏览器 HTTP 备用入口仍不支持；独立 Node CLI 缺少桌面原生组件时拒绝 Windows 写入。

上述恢复测试针对进程中断，不能证明断电下的持久性。合并、变基、挑选、冲突解决、推送与拉取没有加入本批写入功能。此前 0.2.0 的“Windows 仅查看”说明仍属于该旧版本。
