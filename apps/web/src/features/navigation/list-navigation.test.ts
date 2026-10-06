import { describe, expect, it } from 'vitest';
import { listNavigationTarget } from './list-navigation';

describe('list keyboard navigation', () => {
  it('moves within available rows and clamps at either edge without wrapping', () => {
    expect(listNavigationTarget('ArrowDown', 0, 3)).toBe(1);
    expect(listNavigationTarget('ArrowUp', 2, 3)).toBe(1);
    expect(listNavigationTarget('ArrowUp', 0, 3)).toBe(0);
    expect(listNavigationTarget('ArrowDown', 2, 3)).toBe(2);
    expect(listNavigationTarget('Home', 2, 3)).toBe(0);
    expect(listNavigationTarget('End', 0, 3)).toBe(2);
  });
  it('leaves text input and activation keys alone and handles an empty list', () => {
    expect(listNavigationTarget('Enter', 0, 3)).toBeUndefined();
    expect(listNavigationTarget('a', 0, 3)).toBeUndefined();
    expect(listNavigationTarget('End', -1, 0)).toBeUndefined();
  });
});
