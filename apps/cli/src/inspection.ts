import type { Overview } from '@git-view/contracts';
export function summarizeOverview(overview: Overview) {
  const groups = Object.fromEntries(Object.entries(overview.changes).map(([group, entries]) => [group, entries.map(entry => ({ id: entry.id, path: entry.path, oldPath: entry.oldPath, kind: entry.kind, comparison: entry.comparison, supported: entry.supported }))]));
  return { schemaVersion: 1, ok: true, action: 'inspect', repository: { worktreeId: overview.repository.worktreeId, worktreeRoot: overview.repository.worktreeRoot }, head: overview.head, operation: overview.operation, complete: overview.complete, warnings: overview.warnings, counts: Object.fromEntries(Object.entries(overview.changes).map(([group, entries]) => [group, entries.length])), files: groups, explanations: overview.explanations, observation: overview.stamp };
}
