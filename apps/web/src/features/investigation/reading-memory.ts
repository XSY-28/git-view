import type { Blame, Diff, FileHistoryOptions, FileHistoryPage, SearchOptions, SearchPage } from '@git-view/contracts';
import type { Resource } from '../../state/resource';

export interface ReadingPosition {
  pageTop: number;
  scroll: Record<string, { top: number; left: number }>;
  restoreFocus?: string;
}
interface ReadingContext { context?: { sessionId: string; generation: number } }
export interface SearchReadingMemory extends ReadingContext {
  result?: Resource<SearchPage>;
  applied?: SearchOptions;
  selected?: string;
  position: ReadingPosition;
}
export interface FileReadingMemory extends ReadingContext {
  history?: Resource<FileHistoryPage>;
  diff?: Resource<Diff>;
  blame?: Resource<Blame>;
  applied?: FileHistoryOptions;
  selected?: string;
  content?: 'diff' | 'before' | 'after';
  position: ReadingPosition;
}
export interface InvestigationReadingMemory { search?: SearchReadingMemory; file?: FileReadingMemory }
export interface ReadingOrigin { tab: 'search' | 'file'; focus: string }
export type OpenInvestigationCommit = (oid: string, origin?: ReadingOrigin) => void;

/** An interrupted request is never restored as an ongoing or fresh read. */
export function restoredResource<T>(resource?: Resource<T>): Resource<T> {
  return resource ? { ...resource, loading: false, stale: resource.stale || resource.loading && Boolean(resource.value) } : { loading: false };
}
