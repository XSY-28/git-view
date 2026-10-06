# 本地桌面更新

本项目曾因构建、GUI 测试副本和搜索缓存出现多个 Git View 入口。修改桌面版本后，遵循以下流程：

- 本机迭代使用 `pnpm update:desktop` 完成构建和安装；已构建时可用 `pnpm install:desktop`。先退出运行中的 Git View，不绕过安装脚本手动复制应用。
- 正式安装固定为 `~/Applications/Git View.app`。旧版本保留为 ZIP，不在可搜索目录保留备份 `.app`。
- GUI 验收使用固定安装路径，不复制同名、同 bundle ID 的测试应用到其他目录。临时文件测试由 `finally` 或测试清理钩子回收；安装单元测试的系统注册和搜索进程操作使用替身。
- 安装脚本必须在清理构建副本后检查注册唯一并刷新搜索服务。运行相关测试；仅有注册表、文件索引或新 PID 不能证明搜索界面已恢复，未做真实界面复测时明确标为未验证。

CI 或仅生成发布包时使用 `pnpm build:desktop`，不安装到 CI 用户目录。安装与恢复细节见 `docs/verification/2026-10-06-desktop-install.md`。
