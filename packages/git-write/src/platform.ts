import { QueryError } from '@git-view/contracts';

// The first writer relies on POSIX file modes, directory fsync and atomic
// replacement. Keep read-only hosts usable until a Windows writer is verified.
export function supportsIndexWrites(platform: NodeJS.Platform = process.platform) {
  return platform !== 'win32';
}
export function indexWritesUnavailable() {
  return new QueryError('UNSUPPORTED_REPOSITORY', 'Windows 暂未开放 Git 写入；仓库查看仍可使用。');
}
export function requireIndexWrites(platform: NodeJS.Platform = process.platform): void {
  if (!supportsIndexWrites(platform)) throw indexWritesUnavailable();
}
