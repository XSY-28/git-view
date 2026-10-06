import { useEffect, useRef, useState } from 'react';
import { DiffView } from '../changes/DiffView';
import { operationLabel, type Operations } from './useOperations';
import './operations.css';

export function OperationSelection({ operations }: { operations: Operations }) {
  const { state } = operations;
  if (!state.entryIds.length || !state.kind) return null;
  return <div className="operation-selection" role="group" aria-label="所选文件操作"><span>已选 {state.entryIds.length} 项</span><button className="operation-primary" data-operation-preview disabled={operations.blocked} onClick={() => void operations.preview()}>预览{operationLabel(state.kind)}</button><button disabled={state.phase === 'executing'} onClick={() => operations.invalidate()}>清除</button>{state.phase === 'previewing' && <span role="status">正在预览…</span>}</div>;
}

export function OperationFeedback({ operations }: { operations: Operations }) {
  const { state } = operations; const receipt = state.receipt;
  const [confirmForget, setConfirmForget] = useState(false);
  useEffect(() => { setConfirmForget(false); }, [receipt?.operationId, receipt?.status]);
  const discovering = state.phase === 'discovering'; const discoveryFailed = state.phase === 'discovery-failed';
  if (!receipt && !state.error && !discovering) return null;
  const busy = state.phase === 'executing' || state.phase === 'checking' || discovering;
  const pending = receipt?.status === 'unknown' || receipt?.status === 'running';
  return <div className={`operation-feedback ${receipt?.status || ''}`} role="status">
    <div><strong>{discovering ? '正在核实历史操作…' : busy ? (state.phase === 'checking' ? '正在核实结果…' : '正在执行…') : receipt ? `${operationLabel(receipt.kind)}${receipt.status === 'succeeded' ? '完成' : receipt.status === 'failed' ? '失败' : receipt.status === 'running' ? '仍在执行' : '结果待核实'}` : '操作提示'}</strong><span>{state.error || receipt?.message}</span>{receipt && <small>{receipt.paths.join('、')}</small>}{receipt?.result && <div className="operation-result">{receipt.result.createdOid && <div>新提交 / 引用目标 <code>{receipt.result.createdOid}</code></div>}{receipt.result.treeOid && <div>Tree <code>{receipt.result.treeOid}</code></div>}{receipt.result.parents && <div>Parents <code>{receipt.result.parents.join(', ') || '无（首次提交）'}</code></div>}{receipt.result.targetBranch && <div>目标分支 {receipt.result.targetBranch}</div>}{receipt.result.remaining && <div>剩余：已暂存 {receipt.result.remaining.staged} · 未暂存 {receipt.result.remaining.unstaged} · 未跟踪 {receipt.result.remaining.untracked} · 冲突 {receipt.result.remaining.conflicts}</div>}{receipt.result.previewMatched === false && <strong>实际提交与预览内容不同</strong>}{receipt.result.changedPaths && <details><summary>实际提交文件</summary>{receipt.result.changedPaths.map(path => <div key={path}>{path}</div>)}</details>}{receipt.result.diagnostic && <details><summary>Git 输出</summary><pre>{receipt.result.diagnostic}</pre></details>}</div>}</div>
    {discoveryFailed && <button onClick={() => void operations.discover()}>重新检查操作</button>}
    {!busy && !discoveryFailed && pending && <button onClick={() => void operations.recover()}>核实结果</button>}
    {!busy && !discoveryFailed && receipt?.status === 'unknown' && (confirmForget ? <div className="operation-forget"><span>结果仍未确定；清除后可重新选择操作。</span><button onClick={() => { operations.forgetReceipt(); setConfirmForget(false); }}>确认清除此回执</button><button onClick={() => setConfirmForget(false)}>保留</button></div> : <button onClick={() => setConfirmForget(true)}>清除此回执…</button>)}
    {Boolean(state.remainingCount) && <span>另有 {state.remainingCount} 项待核实</span>}
    {!busy && !discoveryFailed && !pending && Boolean(state.remainingCount) && <button onClick={operations.nextReceipt}>查看其他待核实操作</button>}
    {!busy && !discoveryFailed && receipt && !pending && <button aria-label="关闭操作结果" onClick={operations.forgetReceipt}>×</button>}
  </div>;
}

export function OperationDialog({ operations }: { operations: Operations }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { state } = operations; const preview = state.preview;
  const [selected, setSelected] = useState(0);
  const busy = state.phase === 'executing';
  const [allowHooks, setAllowHooks] = useState(false);
  useEffect(() => {
    if (!preview) { dialog.current?.close(); return; }
    setSelected(0); setAllowHooks(false); const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); requestAnimationFrame(() => { const target = document.querySelector<HTMLElement>('[data-operation-preview]') || previous; if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true }); }); };
  }, [preview?.previewId]);
  const diff = preview?.diffs.find(item => item.entry.id === preview.files[selected]?.id);
  return <dialog ref={dialog} className="operation-dialog" aria-labelledby="operation-dialog-title" aria-describedby="operation-dialog-description" onCancel={event => { event.preventDefault(); if (!busy) operations.dismissPreview(); }}>
    {preview && <><header><div><h2 id="operation-dialog-title">确认{operationLabel(preview.kind)}{preview.files.length > 0 ? ` · ${preview.files.length} 个文件` : ''}</h2><p id="operation-dialog-description">{({ 'stage-files': '将所选文件的全部当前改动写入暂存区。', 'unstage-files': '将所选文件移出暂存区，保留工作区文件。', commit: '以当前暂存区启动普通提交。', 'create-branch': '从下面的固定提交创建分支，当前分支保持不变。', 'switch-branch': '切换 HEAD 并更新工作区文件。' })[preview.kind]}</p></div><button aria-label="关闭操作预览" disabled={busy} onClick={operations.dismissPreview}>×</button></header>
      {preview.context && <div className="operation-context"><dl><dt>当前分支</dt><dd>{preview.context.branch ?? 'detached HEAD'}</dd><dt>当前 HEAD</dt><dd><code>{preview.context.headOid ?? '尚无提交'}</code></dd>{preview.context.targetBranch && <><dt>目标分支</dt><dd>{preview.context.targetBranch}</dd><dt>目标提交</dt><dd><code>{preview.context.targetOid}</code></dd></>}</dl>{preview.context.message && <pre aria-label="将使用的提交说明">{preview.context.message}</pre>}</div>}
      {preview.files.length > 0 && <div className="operation-preview-body"><nav className="operation-preview-files" aria-label="本次操作文件">{preview.files.map((file, index) => <button key={file.id} aria-pressed={selected === index} disabled={busy} onClick={() => setSelected(index)}>{file.path}{file.oldPath && <small>← {file.oldPath}</small>}</button>)}</nav><section className="operation-preview-diff" aria-label="操作差异预览">{diff ? <DiffView diff={diff} positionKey={`operation:${preview.previewId}:${diff.entry.id}`}/> : <p className="operation-limit">此文件没有可展示的文本差异。</p>}</section></div>}
      {preview.warnings.length > 0 && <div className="operation-limit" role="note">{preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
      {preview.requiresHookConsent && <label className="operation-consent"><input type="checkbox" checked={allowHooks} disabled={busy} onChange={event => setAllowHooks(event.target.checked)}/>允许此操作运行仓库 hooks 和已配置的签名程序</label>}
      {state.error && <p className="operation-limit" role="alert">{state.error}</p>}
      <footer><span>{busy ? '正在执行，请等待回执…' : preview.context ? '仅执行本次预览的操作' : '仅操作上方列出的文件'}</span><button className="button" disabled={busy} onClick={operations.dismissPreview}>取消</button><button className="button primary" disabled={busy || operations.blocked || Boolean(preview.requiresHookConsent && !allowHooks)} onClick={() => void operations.execute(allowHooks)}>{busy ? '执行中…' : `确认${operationLabel(preview.kind)}`}</button></footer></>}
  </dialog>;
}
