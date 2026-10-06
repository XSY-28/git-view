import { describe, expect, it, vi } from 'vitest';
import { RequestGate } from './request-gate';

describe('UI asynchronous acceptance, independent of transport cancellation', () => {
  it('rejects old success, error, and finally when a file is replaced', () => {
    const gate = new RequestGate(); gate.setContext('repo-a', 1);
    const old = gate.begin('diff', 'file-a');
    // Simulate a transport that completes despite the cancellation request.
    vi.spyOn(old.controller, 'abort').mockImplementation(() => undefined);
    const latest = gate.begin('diff', 'file-b');
    expect(old.controller.signal.aborted).toBe(false);
    for (const event of ['success', 'error', 'finally']) {
      expect(gate.accepts(old), event).toBe(false);
      expect(gate.accepts(latest), event).toBe(true);
    }
  });
  it('rejects every mismatched stamp field', () => {
    const gate = new RequestGate(); gate.setContext('s', 2);
    const current = gate.begin('overview', 'worktree:overview');
    const stamp = { sessionId: current.sessionId, generation: current.generation, queryKey: current.queryKey, requestId: current.requestId };
    expect(gate.accepts(current, stamp)).toBe(true);
    for (const field of ['sessionId', 'generation', 'queryKey', 'requestId'] as const) expect(gate.accepts(current, { ...stamp, [field]: field === 'generation' ? 3 : 'different' })).toBe(false);
  });
  it('isolates repository changes, refresh generations, and repeated same-query requests', () => {
    const gate = new RequestGate(); gate.setContext('a', 1);
    const first = gate.begin('history', 'same'); const second = gate.begin('history', 'same');
    expect(gate.accepts(first)).toBe(false);
    gate.setContext('a', 2); expect(gate.accepts(second)).toBe(false);
    const refreshed = gate.begin('history', 'same');
    gate.setContext('b', 2); expect(gate.accepts(refreshed)).toBe(false);
  });
  it('keeps independent views alive and makes cancellation final', () => {
    const gate = new RequestGate(); const history = gate.begin('history', 'h'); const diff = gate.begin('diff', 'd');
    expect(gate.accepts(history)).toBe(true); gate.cancel('diff');
    expect(gate.accepts(diff)).toBe(false); expect(gate.accepts(history)).toBe(true);
  });
});
