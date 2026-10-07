import { QueryError } from '@git-view/contracts';
import { windowsHelper } from './filesystem.js';

// Windows writes require the installed native ACL/replacement/process bridge.
// Plain Node/stdio remains read-only if that component is unavailable.
export function supportsIndexWrites(platform: NodeJS.Platform = process.platform) {
  return platform !== 'win32' || !!windowsHelper();
}
export function indexWritesUnavailable() {
  return new QueryError('UNSUPPORTED_REPOSITORY', 'Windows 写入需要桌面原生组件，请使用完整安装包。');
}
export function requireIndexWrites(platform: NodeJS.Platform = process.platform): void {
  if (!supportsIndexWrites(platform)) throw indexWritesUnavailable();
}
