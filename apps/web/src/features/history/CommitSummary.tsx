import { useI18n } from '../../i18n/index';
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
  const { t, locale } = useI18n();
  const { commit, base, comparisonLabel, changes } = detail;
  const subject = commit.subject || t('（无提交说明）');
  const authoredAt = new Date(commit.authoredAt);

  return <section className="commit-detail commit-summary" aria-label={t("提交详情")}>
    <div className="commit-summary-heading">
      <h2 title={subject}>{subject}</h2>
      {status && <div className="commit-summary-status">{status}</div>}
    </div>
    <div className="commit-summary-meta">
      <span className="commit-summary-author" title={commit.author}>{commit.author}</span>
      <time dateTime={commit.authoredAt} title={authoredAt.toLocaleString(locale)}>{authoredAt.toLocaleDateString(locale)}</time>
      <button className="commit-copy-id" aria-label={t("复制提交 ID")} title={t(`复制提交 ID：${commit.oid}`)} onClick={() => onCopy(commit.oid)}><code>{commit.oid.slice(0, 8)}</code><span aria-hidden="true">⧉</span></button>
    </div>
    <details className="commit-metadata">
      <summary>{t("提交信息")}<span className="commit-summary-comparison"> · {t(comparisonLabel)}</span></summary>
      <dl>
        <dt>{t("提交 ID")}</dt><dd><code>{commit.oid}</code></dd>
        <dt>{t("提交说明")}</dt><dd>{subject}</dd>
        <dt>{t("作者")}</dt><dd>{commit.author}</dd>
        <dt>{t("时间")}</dt><dd><time dateTime={commit.authoredAt}>{authoredAt.toLocaleString(locale)} · {commit.authoredAt}</time></dd>
        <dt>{t("父提交")}</dt><dd>{commit.parents.length ? commit.parents.map(oid => <code key={oid}>{oid}</code>) : t('无')}</dd>
        <dt>{t("比较基准")}</dt><dd>{base ? <code>{base}</code> : t('空树（首次提交）')}</dd>
      </dl>
    </details>
    <details className="commit-files" open>
      <summary>{changes.length} {t(" 个变化文件")}</summary>
      <div className="commit-file-list">{children}</div>
    </details>
  </section>;
}
