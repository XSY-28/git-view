import type { ReactNode } from 'react';
import type { CommitDetail } from '@git-view/contracts';
import './commit-summary.css';

interface CommitSummaryProps {
  detail: CommitDetail;
  children: ReactNode;
  status?: ReactNode;
  onCopy: (value: string) => void;
}

export function CommitSummary({ detail, children, status, onCopy }: CommitSummaryProps) {
  const { commit, base, comparisonLabel, changes } = detail;
  const subject = commit.subject || '（无提交说明）';
  const authoredAt = new Date(commit.authoredAt);

  return <section className="commit-detail commit-summary" aria-label="提交详情">
    <div className="commit-summary-heading">
      <h2 title={subject}>{subject}</h2>
      {status && <div className="commit-summary-status">{status}</div>}
    </div>
    <div className="commit-summary-meta">
      <span className="commit-summary-author" title={commit.author}>{commit.author}</span>
      <time dateTime={commit.authoredAt} title={authoredAt.toLocaleString('zh-CN')}>{authoredAt.toLocaleDateString('zh-CN')}</time>
      <button className="commit-copy-id" aria-label="复制提交 ID" title={`复制提交 ID：${commit.oid}`} onClick={() => onCopy(commit.oid)}><code>{commit.oid.slice(0, 8)}</code><span aria-hidden="true">⧉</span></button>
    </div>
    <details className="commit-metadata">
      <summary>提交信息<span className="commit-summary-comparison"> · {comparisonLabel}</span></summary>
      <dl>
        <dt>提交 ID</dt><dd><code>{commit.oid}</code></dd>
        <dt>提交说明</dt><dd>{subject}</dd>
        <dt>作者</dt><dd>{commit.author}</dd>
        <dt>时间</dt><dd><time dateTime={commit.authoredAt}>{authoredAt.toLocaleString('zh-CN')} · {commit.authoredAt}</time></dd>
        <dt>父提交</dt><dd>{commit.parents.length ? commit.parents.map(oid => <code key={oid}>{oid}</code>) : '无'}</dd>
        <dt>比较基准</dt><dd>{base ? <code>{base}</code> : '空树（首次提交）'}</dd>
      </dl>
    </details>
    <details className="commit-files" open>
      <summary>{changes.length} 个变化文件</summary>
      <div className="commit-file-list">{children}</div>
    </details>
  </section>;
}
