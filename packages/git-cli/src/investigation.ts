import { type HeadState, type RepositoryIdentity } from '@git-view/contracts';
import { createImmutableReader } from './immutable.js';
import { InvestigationStore } from './investigation-store.js';
import { createInvestigationHistory } from './investigation-history.js';
import { createInvestigationBlame } from './investigation-blame.js';
import { createInvestigationRecords } from './investigation-records.js';
import type { ReadLimits } from './limits.js';

export function createInvestigationReader(limits: ReadLimits, rejectPromisor: (root: string, gitDir: string, signal?: AbortSignal) => Promise<void>, readHead: (repo: RepositoryIdentity, signal?: AbortSignal) => Promise<HeadState>) {
  const reader = createImmutableReader(limits, rejectPromisor);
  const store = new InvestigationStore(limits.historyPageSize, limits.historyCursorCount);
  const history = createInvestigationHistory(reader, store, limits, readHead);
  const records = createInvestigationRecords(reader, store, limits);
  return { searchCommits: history.searchCommits, listFileHistory: history.listFileHistory, readFileHistoryChange: history.readFileHistoryChange, blameFileHistory: createInvestigationBlame(reader, history, limits), ...records };
}
