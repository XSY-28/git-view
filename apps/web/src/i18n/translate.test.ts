import { describe, expect, it } from 'vitest';
import { translate } from './translate';

describe('application message localization', () => {
  it('localizes navigation, comparisons, and host feedback in English', () => {
    expect(translate('提交历史', 'en')).toBe('History');
    expect(translate('暂存区 → 工作区', 'en')).toBe('Index → Working tree');
    expect(translate('文本预览超过 1048576 字节，未展开。', 'en')).toBe('The text preview exceeds 1048576 bytes. Content is unavailable.');
    expect(translate('读取已取消，可重新读取。', 'zh-CN')).toBe('读取已取消，可重新读取。');
  });
  it('localizes delayed read feedback, retained errors, and diagnostic codes', () => {
    expect(translate('正在读取提交历史…', 'en')).toBe('Reading History…');
    expect(translate('已取消文件差异读取。 显示上次结果。', 'en')).toBe('Cancelled reading file diff. Showing previous results.');
    expect(translate('仓库路径不存在或无法访问。（NOT_REPOSITORY） 显示上次结果。', 'en')).toBe('The repository path does not exist or cannot be accessed. (NOT_REPOSITORY) Showing previous results.');
    expect(translate('确认取消暂存', 'en')).toBe('Confirm Unstage');
  });
  it('leaves unknown diagnostics and Chinese messages untouched', () => {
    expect(translate('fatal: unknown revision', 'en')).toBe('fatal: unknown revision');
    expect(translate('切换仓库：我的项目', 'zh-CN')).toBe('切换仓库：我的项目');
  });
  it('preserves user paths and ref names even when they match a translated label', () => {
    expect(translate('切换仓库：{0}', 'en', ['当前分支'])).toBe('Switch repository: 当前分支');
    expect(translate('选择{0} {1}', 'en', ['Stage', '暂存'])).toBe('Select Stage 暂存');
    expect(translate('暂存：二进制内容不展开为文本。', 'en')).toBe('暂存: Binary content is not displayed as text.');
  });
});
