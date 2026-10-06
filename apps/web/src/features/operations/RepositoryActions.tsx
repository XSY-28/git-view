import { useI18n } from '../../i18n/index';
import { useEffect, useId, useRef, useState } from 'react';
import { OPERATION_LIMITS, type Navigation, type Overview } from '@git-view/contracts';
import type { Operations } from './useOperations';

export function RepositoryActions({ operations, overview, navigation, mode, label }: { operations: Operations; overview?: Overview; navigation?: Navigation; mode: 'commit' | 'branch'; label?: string }) {
  const { t, locale } = useI18n();
  const fieldId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState('');
  const [branch, setBranch] = useState('');
  const [target, setTarget] = useState('');
  const [branchMode, setBranchMode] = useState<'create-branch' | 'switch-branch'>('create-branch');
  useEffect(() => { setMessage(''); setBranch(''); setTarget(''); dialog.current?.close(); }, [overview?.repository.worktreeId]);
  useEffect(() => { if (operations.state.receipt?.kind === 'commit' && operations.state.receipt.status === 'succeeded') setMessage(''); }, [operations.state.receipt]);
  const pending = operations.state.phase === 'previewing';
  const disabled = operations.blocked || (mode === 'commit' && !overview?.changes.staged.length);
  async function preview() {
    if (!overview) return;
    const input = mode === 'commit' ? { kind: 'commit' as const, message, fingerprint: overview.fingerprint }
      : { kind: branchMode, branch: branchMode === 'create-branch' ? branch : target, fingerprint: overview.fingerprint };
    if (await operations.preview(input)) dialog.current?.close();
  }
  return <><button className={mode === 'branch' ? 'branch-action' : 'commit-action'} aria-label={mode === 'branch' ? t('分支操作') : t('提交暂存内容')} disabled={disabled} title={mode === 'commit' && !overview?.changes.staged.length ? t('暂存区没有变化') : undefined} onClick={() => dialog.current?.showModal()}>{label ?? (mode === 'commit' ? t('提交…') : t('分支…'))}</button>
    <dialog ref={dialog} className="repository-action-dialog" aria-label={mode === 'commit' ? t('提交暂存内容') : t('分支操作')} onCancel={() => operations.dismissPreview()}>
      <form onSubmit={event => { event.preventDefault(); void preview(); }}>
        <header><h2>{mode === 'commit' ? t('提交暂存内容') : t('分支操作')}</h2><button type="button" aria-label={t("关闭操作表单")} onClick={() => { operations.dismissPreview(); dialog.current?.close(); }}>×</button></header>
        {mode === 'commit' ? <><p>{overview?.changes.staged.length ?? 0} {t(" 个已暂存文件 · ")}{overview?.head.kind === 'detached' ? 'detached HEAD' : overview?.head.branch}</p><label htmlFor={fieldId}>{t("提交说明")}</label><textarea id={fieldId} autoFocus value={message} maxLength={OPERATION_LIMITS.messageLength} onChange={event => setMessage(event.target.value)} rows={5} required/></>
          : <><div className="branch-mode" role="group" aria-label={t("分支动作")}><button type="button" aria-pressed={branchMode === 'create-branch'} onClick={() => setBranchMode('create-branch')}>{t("创建分支")}</button><button type="button" aria-pressed={branchMode === 'switch-branch'} onClick={() => setBranchMode('switch-branch')}>{t("切换分支")}</button></div>
            {branchMode === 'create-branch' ? <><label htmlFor={fieldId}>{t("新分支名称")}</label><input id={fieldId} autoFocus value={branch} onChange={event => setBranch(event.target.value)} maxLength={512} required/><p>{t("从当前 HEAD 创建，当前分支保持不变。")}</p></>
              : <><label htmlFor={fieldId}>{t("目标本地分支")}</label><select id={fieldId} value={target} onChange={event => setTarget(event.target.value)} required><option value="">{t("选择分支")}</option>{navigation?.refs.filter(ref => ref.kind === 'local' && !ref.current).map(ref => <option key={ref.name} value={ref.name.replace(/^refs\/heads\//, '')}>{ref.name.replace(/^refs\/heads\//, '')}</option>)}</select><p>{t("需要干净的工作区。切换会更新 HEAD 和工作文件。")}</p></>}
          </>}
        {operations.state.error && <p className="form-error" role="alert">{t(operations.state.error)}</p>}
        <footer><button type="button" onClick={() => { operations.dismissPreview(); dialog.current?.close(); }}>{t("取消")}</button><button className="button primary" type="submit" disabled={pending || operations.blocked || (mode === 'commit' ? !message.trim() : branchMode === 'create-branch' ? !branch.trim() : !target)}>{pending ? t('正在预览…') : t('预览操作')}</button></footer>
      </form>
    </dialog></>;
}
