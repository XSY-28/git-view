# Git View 应用图标

`icon-warm.png` 是暖色桌面图标的高分辨率母版，沿用原有 Git 分支图形。PNG、ICNS 和 ICO 发布资源位于 `../src-tauri/icons/`。界面配色统一维护于 `../../web/src/theme.css`。

2026-10-06 使用内置 `image_gen` 编辑原有 `src-tauri/icons/icon.png`；背景保留不透明。提示词：

> Use case: precise-object-edit. Edit target: the attached existing Git View application icon. Change ONLY its two flat colors: replace the dark navy square background with uniform warm ivory #F6F2E9, and replace the cyan Git branch glyph with uniform terracotta #A35438. Keep the exact existing silhouette, positions, line widths, three circular nodes, diagonal branch and small gap, overall margins and square composition. Crisp flat solid-color application icon, no gradients, no shadows, no texture, no extra symbols, no text. Do not add a Claude star or change the graphic. Output a square high-resolution PNG suitable as the master desktop icon.

图标格式通过项目固定版本的 Tauri CLI 生成：

```sh
pnpm exec tauri icon apps/desktop/artwork/icon-warm.png --output /private/tmp/git-view-warm-icons
```

只取其中 `icon.png`、`icon.icns`、`icon.ico` 更新现有发布资源；其他平台的额外尺寸不纳入仓库。
