/** Presentation timing is shared by every read surface. */
export const FEEDBACK_TIMING = { slowMs: 800, notificationMs: 3500 } as const;

export interface ReadState {
  loading: boolean;
  error?: string;
  stale?: boolean;
  cancelled?: boolean;
  activity?: { id: string; startedAt: number };
}

export interface ReadFeedbackPolicy {
  phase: 'idle' | 'loading' | 'error' | 'cancelled' | 'stale';
  message: string;
  accessibleMessage: string;
  role: 'status' | 'alert';
  action?: 'cancel' | 'retry' | 'reread';
  slow: boolean;
}

/** Read state owns truth; this policy only chooses its visible feedback. */
export function readFeedbackPolicy({ state, hasValue, scope, idleLabel = '', slow = false }: {
  state: ReadState;
  hasValue: boolean;
  scope: string;
  idleLabel?: string;
  slow?: boolean;
}): ReadFeedbackPolicy {
  const retained = hasValue ? ' 显示上次结果。' : '';
  if (state.loading) {
    const reading = `正在读取${scope}…`;
    return {
      phase: 'loading', message: hasValue && !slow ? idleLabel : reading,
      accessibleMessage: reading, role: 'status', action: slow ? 'cancel' : undefined, slow,
    };
  }
  if (state.error) {
    const message = `${state.error}${retained}`;
    return { phase: 'error', message, accessibleMessage: message, role: 'alert', action: 'retry', slow: false };
  }
  if (state.cancelled) {
    const message = `已取消${scope}读取。${retained}`;
    return { phase: 'cancelled', message, accessibleMessage: message, role: 'status', action: 'reread', slow: false };
  }
  if (state.stale) {
    const message = `${scope}结果已过期。${retained}`;
    return { phase: 'stale', message, accessibleMessage: message, role: 'status', action: 'reread', slow: false };
  }
  return { phase: 'idle', message: idleLabel, accessibleMessage: idleLabel, role: 'status', slow: false };
}

export function remainingSlowReadDelay(startedAt: number, now: number): number {
  return Math.max(0, FEEDBACK_TIMING.slowMs - Math.max(0, now - startedAt));
}
