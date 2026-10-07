import { useI18n } from '../../i18n/index';
import { useEffect, useId, useRef } from 'react';
import type { Navigation, RecentRepository } from '@git-view/contracts';
import './repository-switcher.css';

type RepositorySwitcherProps = {
  root?: string;
  recents: RecentRepository[];
  worktrees?: Navigation['worktrees'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (path?: string) => void;
  onCopyPath: () => void;
  busy: boolean;
  disabled: boolean;
  repoPath: string;
  onRepoPathChange: (value: string) => void;
  error?: string;
};

const repositoryName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

export function RepositorySwitcher({ root, recents, worktrees = [], open, onOpenChange, onOpen, onCopyPath, busy, disabled, repoPath, onRepoPathChange, error }: RepositorySwitcherProps) {
  const { t, locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  const panelId = useId();
  const name = root ? repositoryName(root) : '打开仓库';
  const cannotOpen = disabled || busy;
  const groupedWorktrees = worktrees.length > 1 ? worktrees : [];
  const worktreePaths = new Set(groupedWorktrees.map(tree => tree.path));
  const recentRepositories = recents.filter(recent => recent.path !== root && !worktreePaths.has(recent.path)).slice(0, 5);

  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      (cannotOpen ? panel.current : firstAction.current)?.focus();
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) onOpenChange(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onOpenChange(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, cannotOpen, onOpenChange]);

  function choose(path?: string) {
    if (cannotOpen) return;
    if (path !== undefined && !path.trim()) return;
    if (path === root && path !== undefined) { onOpenChange(false); return; }
    onOpen(path);
  }

  const toggle = <button
    ref={trigger}
    className="repository-switcher-trigger"
    aria-label={root ? t('切换仓库：{0}', [name]) : t('打开仓库')}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? panelId : undefined}
    disabled={disabled}
    title={root}
    onClick={event => { focusOnOpen.current = !open && event.detail === 0; onOpenChange(!open); }}
    onKeyDown={event => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (open) (cannotOpen ? panel.current : firstAction.current)?.focus();
      else { focusOnOpen.current = true; onOpenChange(true); }
    }}
  >
    <svg className="repository-switcher-folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/></svg>
    <span>{root ? name : t(name)}</span>
    <svg className="repository-switcher-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
  </button>;

  return <div ref={container} className="repository-switcher repository-title" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
  }} onKeyDown={event => {
    if (!open || event.key !== 'Tab') return;
    // Let the browser move focus first; a null blur target also occurs when selecting path text.
    requestAnimationFrame(() => {
      if (container.current && (!document.hasFocus() || !container.current.contains(document.activeElement))) onOpenChange(false);
    });
  }}>
    {root ? <h1>{toggle}</h1> : toggle}
    {open && <div ref={panel} id={panelId} className="repository-switcher-panel" role="dialog" aria-label={t("切换仓库")} tabIndex={-1}>
      <button ref={firstAction} className="repository-switcher-open" disabled={cannotOpen} onClick={() => choose()}>
        <span>{t("打开仓库…")}</span><kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘O' : 'Ctrl+O'}</kbd>
      </button>
      {root && <div className="repository-switcher-current"><span>{t("当前仓库")}</span><div><code>{root}</code><button className="repository-switcher-copy" onClick={onCopyPath} aria-label={t("复制仓库路径")} title={t("复制仓库路径")}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4V2.5h10.5V13H16M2.5 7h10.5v10.5H2.5z"/></svg></button></div></div>}
      {error && <p className="repository-switcher-error" role="alert">{t(error)}</p>}
      {recentRepositories.length > 0 && <section className="repository-switcher-group" aria-label={t("最近仓库")}><h2>{t("最近仓库")}</h2>{recentRepositories.map(recent => <button data-testid="recent-repository" className="navigation-recent" key={recent.worktreeId} disabled={cannotOpen} onClick={() => choose(recent.path)} title={recent.path}><span>{repositoryName(recent.path)}</span><small>{recent.path}</small></button>)}</section>}
      {groupedWorktrees.length > 0 && <section className="repository-switcher-group" aria-label="Worktrees"><h2>Worktrees</h2>{groupedWorktrees.map(tree => <button className="navigation-worktree" key={tree.path} disabled={cannotOpen || tree.bare || Boolean(tree.prunable)} aria-current={tree.path === root ? 'true' : undefined} onClick={() => choose(tree.path)} title={tree.path}><span>{repositoryName(tree.path)}{tree.path === root && <small className="repository-switcher-active">{t("当前")}</small>}</span><small>{tree.branch?.replace(/^refs\/heads\//, '') || (tree.detached ? 'detached HEAD' : t('工作区'))}{tree.locked && t(' · 已锁定')}{tree.prunable && t(' · 不可用')}</small></button>)}</section>}
      <details className="repository-switcher-manual"><summary>{t("手动输入路径")}</summary><form onSubmit={event => { event.preventDefault(); choose(repoPath.trim()); }}><label className="sr-only" htmlFor="repo-path">{t("本地仓库路径")}</label><input id="repo-path" value={repoPath} onChange={event => onRepoPathChange(event.target.value)} placeholder={t("仓库文件夹路径")} autoComplete="off" spellCheck={false} disabled={cannotOpen}/><button className="button" disabled={cannotOpen || !repoPath.trim()}>{t("按路径打开")}</button></form></details>
    </div>}
  </div>;
}
