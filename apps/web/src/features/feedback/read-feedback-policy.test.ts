import { describe, expect, it } from 'vitest';
import { FEEDBACK_TIMING, readFeedbackPolicy, remainingSlowReadDelay, type ReadState } from './read-feedback-policy';

const feedback = (state: ReadState, hasValue = false, slow = false) => readFeedbackPolicy({ state, hasValue, slow, scope: '文件差异' });

describe('read feedback policy', () => {
  it('keeps ordinary successful content quiet', () => {
    expect(feedback({ loading: false }, true)).toMatchObject({ phase: 'idle', message: '', role: 'status' });
    expect(feedback({ loading: false }, true).action).toBeUndefined();
    expect(readFeedbackPolicy({ state: { loading: false }, hasValue: true, scope: '仓库状态', idleLabel: '读取于 12:00:00' }).message).toBe('读取于 12:00:00');
  });

  it('shows an initial read immediately while reserving cancel for slow reads', () => {
    expect(feedback({ loading: true })).toMatchObject({ message: '正在读取文件差异…', action: undefined });
    expect(feedback({ loading: true }, false, true)).toMatchObject({ message: '正在读取文件差异…', action: 'cancel' });
  });

  it('does not flash reading text over existing content during a quick refresh', () => {
    expect(feedback({ loading: true, stale: true }, true)).toMatchObject({ message: '', accessibleMessage: '正在读取文件差异…', action: undefined });
    expect(feedback({ loading: true, stale: true }, true, true)).toMatchObject({ message: '正在读取文件差异…', action: 'cancel' });
  });

  it('retains full failure details and explains when the displayed data is old', () => {
    const error = '无法读取：权限不足。'.repeat(40);
    expect(feedback({ loading: false, error, stale: true }, true)).toMatchObject({ phase: 'error', message: `${error} 显示上次结果。`, accessibleMessage: `${error} 显示上次结果。`, role: 'alert', action: 'retry' });
    expect(feedback({ loading: false, error })).toMatchObject({ message: error });
  });

  it('presents cancellation as a neutral recoverable state', () => {
    expect(feedback({ loading: false, cancelled: true, stale: true }, true)).toMatchObject({ phase: 'cancelled', message: '已取消文件差异读取。 显示上次结果。', role: 'status', action: 'reread' });
    expect(feedback({ loading: false, cancelled: true }).message).not.toContain('上次结果');
  });

  it('offers a new read when a retained result becomes stale outside an active request', () => {
    expect(feedback({ loading: false, stale: true }, true)).toMatchObject({ phase: 'stale', message: '文件差异结果已过期。 显示上次结果。', action: 'reread', role: 'status' });
  });

  it('an active retry takes precedence over its previous failure or cancellation', () => {
    expect(feedback({ loading: true, error: '旧错误', cancelled: true, stale: true }, true)).toMatchObject({ phase: 'loading', message: '', role: 'status' });
  });

  it('measures the delay from each activity start and tolerates clock correction', () => {
    expect(remainingSlowReadDelay(1000, 1000)).toBe(FEEDBACK_TIMING.slowMs);
    expect(remainingSlowReadDelay(1000, 1799)).toBe(1);
    expect(remainingSlowReadDelay(1000, 1800)).toBe(0);
    expect(remainingSlowReadDelay(1800, 1800)).toBe(FEEDBACK_TIMING.slowMs);
    expect(remainingSlowReadDelay(1000, 900)).toBe(FEEDBACK_TIMING.slowMs);
  });
});
