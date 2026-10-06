import { QueryError } from '@git-view/contracts';

// Shared by all coordinators in this process, including different local services.
const tails = new Map<string, Promise<void>>();
const waiting = new Map<string, number>();

export async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  if ((waiting.get(key) ?? 0) >= 32) throw new QueryError('REPOSITORY_BUSY', '仓库操作队列已满，请等待当前操作结束。', true);
  waiting.set(key, (waiting.get(key) ?? 0) + 1);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  tails.set(key, tail);
  await previous;
  try { return await work(); }
  finally {
    release();
    const count = waiting.get(key)! - 1;
    if (count) waiting.set(key, count); else waiting.delete(key);
    if (tails.get(key) === tail) tails.delete(key);
  }
}
