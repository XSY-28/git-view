import { useEffect, useMemo, useState } from 'react';
import { readFeedbackPolicy, remainingSlowReadDelay, type ReadState } from './read-feedback-policy';
import './read-feedback.css';

export { FEEDBACK_TIMING, type ReadState } from './read-feedback-policy';

export function ReadFeedback({ state, hasValue, scope, onRetry, onCancel, idleLabel, className = '', compact = false }: {
  state: ReadState;
  hasValue: boolean;
  scope: string;
  onRetry?: () => void;
  onCancel?: () => void;
  idleLabel?: string;
  className?: string;
  compact?: boolean;
}) {
  // A fresh identity resets the delay even when one loading request replaces another.
  const activity = useMemo(() => state.activity ?? { id: 'initial', startedAt: Date.now() }, [state.loading, state.activity?.id, state.activity?.startedAt]);
  const [elapsedActivity, setElapsedActivity] = useState<typeof activity>();
  useEffect(() => {
    if (!state.loading) return;
    const timer = window.setTimeout(() => setElapsedActivity(activity), remainingSlowReadDelay(activity.startedAt, Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.loading, activity]);
  const slow = state.loading && (elapsedActivity === activity || remainingSlowReadDelay(activity.startedAt, Date.now()) === 0);
  const feedback = readFeedbackPolicy({ state, hasValue, scope, idleLabel, slow });
  const expandable = feedback.phase === 'error' || feedback.phase === 'cancelled' || feedback.phase === 'stale';
  const action = feedback.action === 'cancel' ? onCancel : onRetry;
  const actionLabel = feedback.action === 'cancel' ? '取消' : feedback.action === 'retry' ? '重试' : '重新读取';
  const actionName = feedback.action === 'cancel' ? `取消${scope}读取` : feedback.action === 'retry' ? `重试${scope}读取` : `重新读取${scope}`;

  return <div className={`read-feedback ${compact ? 'read-feedback--compact' : 'read-feedback--block'} ${className}`} data-scope={scope} data-phase={feedback.phase} data-slow={feedback.slow} data-expandable={expandable}>
    <span className="read-feedback-indicator" aria-hidden="true" data-visible={feedback.phase !== 'idle' || Boolean(idleLabel)} />
    <span className="read-feedback-text"><span className="read-feedback-message" role={feedback.role} aria-live={feedback.role === 'alert' ? 'assertive' : 'polite'} aria-atomic="true" aria-label={feedback.accessibleMessage || undefined} title={feedback.accessibleMessage || undefined} tabIndex={expandable ? 0 : undefined}>{feedback.message}</span></span>
    <span className="read-feedback-actions">{feedback.action && action && <button type="button" onClick={action} aria-label={actionName}>{actionLabel}</button>}</span>
  </div>;
}
