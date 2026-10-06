import type { Explanation, RawOverview } from '@git-view/contracts';

/** Rules consume one observation. They never infer task attribution or read Git. */
export function explain(overview: RawOverview, observationId: string): Explanation[] {
  const { head, changes, complete, operation } = overview;
  const shared = { ruleVersion: 1 as const, observationId };
  const location = head.kind === 'unborn' ? `当前分支是 ${head.branch}，尚无首次提交。`
    : head.kind === 'detached' ? `HEAD 直接指向提交 ${head.oid}（detached HEAD），当前不在分支上。`
      : `当前分支是 ${head.branch}，HEAD 指向提交 ${head.oid}。`;
  const overlapping = changes.staged.filter(entry => changes.unstaged.some(other => other.rawPath === entry.rawPath));
  const counts = `已暂存 ${changes.staged.length} 项，未暂存 ${changes.unstaged.length} 项，未跟踪 ${changes.untracked.length} 项。`;
  const statusAnswer = counts + (overlapping.length ? ` ${overlapping.map(entry => entry.path).join('、')} 同时出现在两组：暂存区相对 HEAD 有变化，工作区相对暂存区又有变化；两份比较的基准不同。` : '')
    + (changes.conflicts.length ? ` 存在 ${changes.conflicts.length} 个未解决冲突。` : '')
    + (!complete ? ' 读取结果不完整，以上不是完整变化清单。' : '')
    + (complete && Object.values(changes).every(group => group.length === 0) ? ' 当前未发现未提交改动；仍可查看最近提交，不能据此判断 AI 是否修改过项目。' : '');
  const blocked = !complete || operation.length > 0 || changes.conflicts.length > 0;
  const prediction = blocked ? '当前不能可靠预测下一次普通提交：' + [!complete ? '观测不完整' : '', operation.length ? `正在进行 ${operation.join('、')}` : '', changes.conflicts.length ? '存在未解决冲突' : ''].filter(Boolean).join('；') + '。请先查看状态说明，再重新读取。'
    : changes.staged.length ? `按当前暂存内容，下一次普通提交预计包含 ${changes.staged.length} 项相对 HEAD 的候选变化：${changes.staged.map(entry => entry.path).join('、')}。提交记录完整树快照；未暂存的后续修改与未跟踪文件不会自动加入。`
      : '暂存区没有相对 HEAD 的候选变化；普通提交通常不会产生新提交。未暂存或未跟踪内容不会自动加入。';
  const changeEvidence = [...changes.staged, ...changes.unstaged, ...changes.untracked, ...changes.conflicts].map(entry => ({ label: `${entry.comparison === 'head-index' ? '已暂存' : entry.comparison === 'untracked-preview' ? '未跟踪预览' : '未暂存'} · ${entry.path}`, target: 'change' as const, entryId: entry.id, comparison: entry.comparison }));
  return [
    { ...shared, questionId: 'location', question: '我现在在哪里？', answer: location, conditions: ['只描述本次读取的实际 worktree 与 HEAD。'], evidence: [{ label: '查看 HEAD 与完整提交 ID', target: 'head' }, { label: '查看提交历史', target: 'history' }] },
    { ...shared, questionId: 'changes', question: '哪些变化已暂存？', answer: statusAnswer, conditions: ['已暂存比较 HEAD → index；未暂存比较 index → worktree；未跟踪是文本预览。'], evidence: changeEvidence.length ? changeEvidence : [{ label: '查看读取状态', target: 'status' }] },
    { ...shared, questionId: 'next-commit', question: '下一次普通提交会包含什么？', answer: prediction, conditions: ['不额外指定路径，不使用 -a、--allow-empty，提交 hooks 没有改变暂存区。', '这是带时间的观测；外部修改后需要刷新。'], evidence: blocked ? [{ label: '查看限制与操作状态', target: 'status' }] : changes.staged.length ? changeEvidence.filter(item => item.comparison === 'head-index') : [{ label: '查看暂存区状态', target: 'status' }] },
  ];
}
