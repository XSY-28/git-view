import { type Diff, type FileHistoryOptions, type SearchOptions } from '@git-view/contracts';
export type InvestigationTab = 'search' | 'file' | 'stash' | 'reflog';
export interface InvestigationMemory { tab: InvestigationTab; search?: SearchOptions; file?: FileHistoryOptions; reflogRef?: string }
export const defaultInvestigation = (): InvestigationMemory => ({ tab: 'search' });
export function fileHistoryLocation(diff: Diff, fallbackOid?: string): FileHistoryOptions | undefined {
  if (!diff.entry.supported) return;
  const isOid = (value?: string) => Boolean(value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value));
  const committedTarget = isOid(diff.target);
  const oid = committedTarget ? diff.target : isOid(diff.base) ? diff.base : fallbackOid;
  if (!isOid(oid)) return;
  try {
    // Committed history includes a deletion itself. Uncommitted renames need
    // the old path because the new name is not yet present in the HEAD tree.
    const raw = committedTarget ? diff.entry.rawPath : diff.entry.rawOldPath ?? diff.entry.rawPath;
    const path = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(raw), char => char.charCodeAt(0)));
    return { endpoint: { kind: 'commit', oid: oid! }, path };
  } catch { return; }
}
